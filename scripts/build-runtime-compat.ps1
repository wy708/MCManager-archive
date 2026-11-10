[CmdletBinding()]
param(
    [string]$Compiler = $env:CXX,
    [string]$VcVarsPath = $env:MCARCHIVE_VCVARS,
    [string]$OutputDirectory,
    [switch]$SkipTests
)
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$source = Join-Path $repo 'collector/runtime-compat'
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $repo 'collector/build/runtime-compat' }
$output = [IO.Path]::GetFullPath($OutputDirectory)
$bundle = Join-Path $output 'AAA-archive-runtime-compat'
New-Item -ItemType Directory -Force -Path $output, $bundle | Out-Null
# Remove only known build/test byproducts from older bundles, never server data.
foreach ($artifact in @('runtime-compat.log','archive-runtime-compat.lib','archive-runtime-compat.exp')) {
    $artifactPath = Join-Path $bundle $artifact
    if (Test-Path -LiteralPath $artifactPath -PathType Leaf) { Remove-Item -LiteralPath $artifactPath }
}
if (-not $Compiler) {
    $available = Get-Command clang-cl.exe -ErrorAction SilentlyContinue
    if (-not $available) { $available = Get-Command cl.exe -ErrorAction SilentlyContinue }
    if ($available) { $Compiler = $available.Source } else { $Compiler = 'cl.exe' }
}
if (-not $env:VCToolsInstallDir -and -not $VcVarsPath) {
    $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
    if (Test-Path -LiteralPath $vswhere) {
        $installation = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
        if ($installation) { $VcVarsPath = Join-Path $installation 'VC/Auxiliary/Build/vcvars64.bat' }
    }
    if (-not $VcVarsPath) { throw 'Use an x64 VS developer shell or pass -VcVarsPath with the x64 MSVC environment script.' }
}
if ($VcVarsPath -and -not (Test-Path -LiteralPath $VcVarsPath -PathType Leaf)) { throw 'VcVarsPath does not exist.' }
$identity = Get-Content -LiteralPath (Join-Path $source 'identity.json') -Raw | ConvertFrom-Json
$table = Join-Path $source 'compat-symbols.tsv'
if ((Get-FileHash -LiteralPath $table -Algorithm SHA256).Hash.ToLowerInvariant() -cne $identity.tableSHA256) {
    throw 'Symbol table differs from the reviewed identity manifest. Revalidate before updating its fixed hash.'
}
$evidence = Get-Content -LiteralPath (Join-Path $source 'verified-symbols.json') -Raw | ConvertFrom-Json
$names = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
$canonical = [Text.StringBuilder]::new()
foreach ($row in $evidence.symbols) {
    if ($row.validated -ne $true -or @('function','getter','direct') -notcontains $row.kind -or -not $names.Add($row.symbol)) {
        throw 'Unvalidated, invalid or duplicate symbol in reviewed evidence.'
    }
    $rva = [Convert]::ToUInt32($row.newRva.Substring(2), 16)
    [void]$canonical.Append("$($row.kind)`t$($rva.ToString('x'))`t$($row.symbol)`n")
}
if ($names.Count -ne $identity.symbolCount -or [IO.File]::ReadAllText($table) -cne $canonical.ToString()) {
    throw 'Reviewed symbol evidence does not reproduce the pinned table.'
}
foreach ($field in @('tableSHA256','loadedExecutableSHA256','preLoaderSHA256','leviLaminaSHA256')) {
    if ($identity.$field -cnotmatch '^[a-f0-9]{64}$') { throw "Invalid identity hash: $field" }
}
if ($identity.target -cne '1.26.61.1/26.60.2' -or $identity.symbolCount -ne 932) { throw 'Unsupported identity profile.' }
$header = @"
#pragma once
namespace identity {
inline constexpr char target[] = "$($identity.target)";
inline constexpr unsigned symbolCount = $($identity.symbolCount);
inline constexpr char tableSHA[] = "$($identity.tableSHA256)";
inline constexpr char executableSHA[] = "$($identity.loadedExecutableSHA256)";
inline constexpr char preloaderSHA[] = "$($identity.preLoaderSHA256)";
inline constexpr char leviLaminaSHA[] = "$($identity.leviLaminaSHA256)";
}
"@
[IO.File]::WriteAllText((Join-Path $output 'identity.generated.h'), $header, [Text.UTF8Encoding]::new($false))
# Quote actual argv in an MSVC response file; do not interpolate paths into executable shell commands.
function Quote-Argument([string]$value) {
    if ($value.Contains('"') -or $value.Contains("`n") -or $value.Contains("`r")) { throw 'Unsupported quote/newline in build path.' }
    return '"' + $value + '"'
}
function Invoke-Compile([string]$name, [string[]]$arguments) {
    $response = Join-Path $output "$name.rsp"
    [IO.File]::WriteAllText($response, ($arguments -join ' '), [Text.UTF8Encoding]::new($false))
    if ($VcVarsPath) {
        # The generated batch file only initializes MSVC and invokes a response file.
        # Reject CMD expansion characters in its three interpolated path operands.
        foreach ($value in @($VcVarsPath, $Compiler, $response)) {
            if ($value -match '[%"\r\n!&|<>^]') { throw 'Unsafe command-shell character in tool path.' }
        }
        $batch = Join-Path $output "$name.cmd"
        $lines = @('@echo off', "call `"$VcVarsPath`" >nul", 'if errorlevel 1 exit /b %errorlevel%', "`"$Compiler`" @`"$response`"", 'exit /b %errorlevel%')
        [IO.File]::WriteAllLines($batch, $lines, [Text.Encoding]::Default)
        & $env:ComSpec /d /c $batch
    } else { & $Compiler "@$response" }
    if ($LASTEXITCODE -ne 0) { throw "Compilation failed: $name" }
}
$common = @('/nologo','/std:c++20','/EHsc','/O2','/MT','/W4',('/I' + (Quote-Argument $source)),('/I' + (Quote-Argument $output)))
Push-Location $output
try {
    Invoke-Compile 'runtime-compat' ($common + @('/LD', (Quote-Argument (Join-Path $source 'compat.cpp')), '/Fo:compat.obj',
        ('/Fe:' + (Quote-Argument (Join-Path $bundle 'archive-runtime-compat.dll'))), '/link','bcrypt.lib','/MACHINE:X64','/DYNAMICBASE','/NXCOMPAT',
        ('/IMPLIB:' + (Quote-Argument (Join-Path $output 'archive-runtime-compat.lib')))))
    Copy-Item -LiteralPath $table -Destination (Join-Path $bundle 'compat-symbols.tsv') -Force
    Copy-Item -LiteralPath (Join-Path $source 'manifest.json') -Destination $bundle -Force
    Copy-Item -LiteralPath (Join-Path $source 'identity.json') -Destination $bundle -Force
    if (-not $SkipTests) {
        Invoke-Compile 'runtime-compat-tests' ($common + @((Quote-Argument (Join-Path $source 'tests.cpp')), '/Fo:tests.obj', '/Fe:runtime-compat-tests.exe','/link','/MACHINE:X64'))
        $safetyHost = Join-Path $output 'safety-host'
        New-Item -ItemType Directory -Force -Path $safetyHost | Out-Null
        Copy-Item -LiteralPath (Join-Path $bundle 'archive-runtime-compat.dll') -Destination $safetyHost -Force
        & (Join-Path $output 'runtime-compat-tests.exe') $table (Join-Path $safetyHost 'archive-runtime-compat.dll')
        if ($LASTEXITCODE -ne 0) { throw 'Compatibility safety tests failed.' }
    }
    $summary = [ordered]@{
        target = $identity.target; symbols = $identity.symbolCount; tableSHA256 = $identity.tableSHA256
        dllSHA256 = (Get-FileHash -LiteralPath (Join-Path $bundle 'archive-runtime-compat.dll')).Hash.ToLowerInvariant()
        safetyTests = $(if ($SkipTests) {'not run'} else {'passed'})
        gameplayAcceptance = 'not run by build script'
        installedOrStartedServer = $false
    }
    $summary | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $output 'build-evidence.json') -Encoding UTF8
    Write-Host "Built independent plugin bundle: $bundle"
} finally { Pop-Location }

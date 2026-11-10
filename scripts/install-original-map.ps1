param(
    [Parameter(Mandatory=$true)][string]$GameDirectory,
    [Parameter(Mandatory=$true)][string]$MapOrigin,
    [ValidateSet('1.26.51.1','1.26.61.1')][string]$RuntimeProfile='1.26.51.1',
    [string]$RuntimeWheel
)
$ErrorActionPreference='Stop'
$gameRoot=(Resolve-Path -LiteralPath $GameDirectory).Path
$origin=[Uri]$MapOrigin
if (!$origin.IsAbsoluteUri -or $origin.Scheme -notin @('http','https') -or $origin.AbsolutePath -ne '/' -or $origin.Query -or $origin.Fragment -or $origin.UserInfo) { throw 'MapOrigin must be an HTTP(S) origin without a path.' }
if ($env:MCM_MAP_INGEST_KEY -notmatch '^[a-fA-F0-9]{64}$') { throw 'Set MCM_MAP_INGEST_KEY to the same 64-character key used by the map gateway.' }
if (Get-CimInstance Win32_Process -Filter "Name='bedrock_server_mod.exe' OR Name='bedrock_server.exe'" | Where-Object { $_.ExecutablePath -and (Split-Path -Parent $_.ExecutablePath) -eq $gameRoot }) { throw 'Stop this game server normally before installing.' }
$repoRoot=Split-Path -Parent $PSScriptRoot
$runtime=Join-Path $gameRoot 'plugins/EndstoneRuntime'
$backup=Join-Path $gameRoot '.mcmanager-map-original'
if ($RuntimeProfile -eq '1.26.61.1') {
    if (!$RuntimeWheel) { throw 'The 1.26.61.1 profile requires -RuntimeWheel with the reviewed local compatibility wheel.' }
    $wheel=(Resolve-Path -LiteralPath $RuntimeWheel).Path
    $compatibility=Join-Path $repoRoot 'map/compatibility'
    $verified=Get-Content -LiteralPath (Join-Path $compatibility 'verified-artifacts.json') -Raw | ConvertFrom-Json
    $pins=Get-Content -LiteralPath (Join-Path $compatibility 'sources.json') -Raw | ConvertFrom-Json
    if ((Get-FileHash -LiteralPath $wheel -Algorithm SHA256).Hash.ToLowerInvariant() -ne $verified.wheelSha256) { throw 'The local wheel is not the reviewed artifact; new builds require their own runtime verification.' }
    $originalExe=Join-Path $gameRoot 'bedrock_server.exe.bak'
    if (!(Test-Path -LiteralPath $originalExe)) { $originalExe=Join-Path $gameRoot 'bedrock_server.exe' }
    if ((Get-FileHash -LiteralPath $originalExe -Algorithm SHA256).Hash.ToLowerInvariant() -ne $verified.officialExecutableSha256) { throw 'The server does not match the reviewed BDS 1.26.61.1 executable.' }
    $loader=Join-Path $gameRoot 'plugins/LeviLamina/LeviLamina.dll'
    if ((Get-FileHash -LiteralPath $loader -Algorithm SHA256).Hash.ToLowerInvariant() -ne $verified.leviLaminaSha256) { throw 'The server must use the reviewed LL 26.60.2 runtime with its compatibility adapter.' }
    if (!(Test-Path -LiteralPath (Join-Path $gameRoot 'plugins/AAA-archive-runtime-compat/archive-runtime-compat.dll'))) { throw 'Install the checked 1.26.61.1 runtime adapter first.' }
    $pythonInfo=& py -3.12 -c 'import sys,json; print(json.dumps({"base":sys.base_prefix,"version":".".join(map(str,sys.version_info[:3]))}))'
    if ($LASTEXITCODE -ne 0) { throw 'CPython 3.12 is required.' }
    $pythonInfo=$pythonInfo | ConvertFrom-Json
    if ($pythonInfo.version -ne $pins.python) { throw "This profile was verified with CPython $($pins.python)." }
    $python=Join-Path $pythonInfo.base 'python.exe'
    & $python (Join-Path $compatibility 'verify_runtime.py') --wheel $wheel
    if ($LASTEXITCODE -ne 0) { throw 'The compatibility wheel contents failed verification.' }
    New-Item -ItemType Directory -Force -Path $backup | Out-Null
    $staging=Join-Path $backup ('runtime-stage-'+[Guid]::NewGuid().ToString('N'))
    & $python -m pip install --target $staging --no-deps --disable-pip-version-check $wheel @($pins.runtimeDependencies)
    if ($LASTEXITCODE -ne 0) { throw 'Compatibility runtime staging failed; the existing runtime was not replaced.' }
    & $python (Join-Path $compatibility 'verify_runtime.py') --installed $staging
    if ($LASTEXITCODE -ne 0) { throw 'Staged native files failed verification; the existing runtime was not replaced.' }
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $runtime) | Out-Null
    $runtimeBackup=Join-Path $backup ('EndstoneRuntime-'+[Guid]::NewGuid().ToString('N'))
    foreach ($candidate in @($runtime,$staging,$runtimeBackup)) {
        if (![IO.Path]::GetFullPath($candidate).StartsWith($gameRoot.TrimEnd('\')+'\',[StringComparison]::OrdinalIgnoreCase)) { throw 'Runtime replacement path escaped the specified game directory.' }
    }
    if (Test-Path -LiteralPath $runtime) { Move-Item -LiteralPath $runtime -Destination $runtimeBackup }
    try { Move-Item -LiteralPath $staging -Destination $runtime }
    catch { if (Test-Path -LiteralPath $runtimeBackup) { Move-Item -LiteralPath $runtimeBackup -Destination $runtime }; throw }
    Write-Host "Verified 1.26.61.1 map runtime installed. Use the base Python executable for ENDSTONE_PYTHON_EXECUTABLE: $python"
} else {
    if ($RuntimeWheel) { throw '-RuntimeWheel is only accepted with the explicit 1.26.61.1 profile.' }
    & py -3.12 -m pip install --target $runtime 'levistone==0.11.13' --disable-pip-version-check
    if($LASTEXITCODE -ne 0){throw 'LeviStone installation failed.'}
}
$cache=Join-Path $repoRoot 'map/dist'
New-Item -ItemType Directory -Force -Path $cache | Out-Null
$official=Join-Path $cache 'endstone_mipmap-1.0.3-py2.py3-none-any.whl'
if(!(Test-Path -LiteralPath $official)) { Invoke-WebRequest 'https://github.com/MipaSenpai/MipMap/releases/download/v1.0.3/endstone_mipmap-1.0.3-py2.py3-none-any.whl' -OutFile $official }
& py -3.12 (Join-Path $repoRoot 'map/prepare_plugin.py') $official --output $cache
if($LASTEXITCODE -ne 0){throw 'Official wheel verification or compatibility patch failed.'}
New-Item -ItemType Directory -Force -Path $backup | Out-Null
Copy-Item -LiteralPath $official -Destination (Join-Path $backup (Split-Path -Leaf $official)) -Force
foreach($oldWheel in (Get-ChildItem -LiteralPath (Join-Path $gameRoot 'plugins') -Filter 'endstone_mipmap-*.whl' -File)) {
    Move-Item -LiteralPath $oldWheel.FullName -Destination (Join-Path $backup $oldWheel.Name) -Force
}
Copy-Item -LiteralPath (Join-Path $cache 'endstone_mipmap-1.0.3+mcmanager.6-py2.py3-none-any.whl') -Destination (Join-Path $gameRoot 'plugins') -Force
$config=Join-Path $gameRoot 'plugins/mipmap/config.toml'
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $config) | Out-Null
if(Test-Path -LiteralPath $config) {
    $text=Get-Content -LiteralPath $config -Raw
    Copy-Item -LiteralPath $config -Destination (Join-Path $backup ('config-'+(Get-Date -Format 'yyyyMMdd-HHmmss')+'.toml'))
} else {
    $text=& py -3.12 -c 'import sys,zipfile;sys.stdout.buffer.write(zipfile.ZipFile(sys.argv[1]).read("endstone_mipmap/config.toml"))' (Join-Path $cache 'endstone_mipmap-1.0.3+mcmanager.6-py2.py3-none-any.whl')
    if($LASTEXITCODE -ne 0){throw 'Cannot read original plugin configuration.'}
    $text=$text -join "`n"
}
$base=$MapOrigin.TrimEnd('/')+'/upload/'+$env:MCM_MAP_INGEST_KEY
$text=[regex]::Replace($text,'(?m)^chunks\s*=.*$',('chunks = "'+$base+'/chunks"'))
$text=[regex]::Replace($text,'(?m)^players\s*=.*$',('players = "'+$base+'/players"'))
[IO.File]::WriteAllText($config,$text,[Text.UTF8Encoding]::new($false))
Write-Host 'Original MipMap installed with Windows compatibility and block-state capture. Start the game normally.'

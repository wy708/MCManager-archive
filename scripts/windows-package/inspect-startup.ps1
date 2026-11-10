param([string]$GameRoot = 'E:\bedrock-server-1.26.61.1')
$ErrorActionPreference = 'Stop'
$problems = New-Object System.Collections.Generic.List[string]
function FileInfoSafe([string]$File, [string]$Expected = '') {
    if (-not (Test-Path -LiteralPath $File -PathType Leaf)) { return @{exists=$false;path=$File} }
    $entry = Get-Item -LiteralPath $File
    $sha = (Get-FileHash -LiteralPath $File -Algorithm SHA256).Hash.ToLowerInvariant()
    return @{exists=$true;path=$File;bytes=$entry.Length;modifiedAt=$entry.LastWriteTimeUtc.ToString('o');sha256=$sha;matchesRelease=($Expected -eq '' -or $sha -eq $Expected)}
}
function QueueInfo([string]$Directory) {
    [long]$count=0;[long]$bytes=0;$oldest=$null;$newest=$null
    if (Test-Path -LiteralPath $Directory -PathType Container) {
        Get-ChildItem -LiteralPath $Directory -File -Filter '*.pending' | ForEach-Object {
            $count++;$bytes+=$_.Length
            if ($null -eq $oldest -or $_.LastWriteTimeUtc -lt $oldest) {$oldest=$_.LastWriteTimeUtc}
            if ($null -eq $newest -or $_.LastWriteTimeUtc -gt $newest) {$newest=$_.LastWriteTimeUtc}
        }
    }
    return @{path=$Directory;files=$count;bytes=$bytes;oldestWrite=$oldest;newestWrite=$newest}
}
function ProcessSnapshot {
    $rows=@()
    foreach($item in @(Get-CimInstance Win32_Process -Filter "Name='bedrock_server_mod.exe' OR Name='bedrock_server.exe' OR Name='node.exe'")) {
        $consoleHost=$item.Name -eq 'node.exe' -and $item.CommandLine -match 'console-host\.mjs'
        if ($item.Name -eq 'node.exe' -and -not $consoleHost) {continue}
        try {
            $process=Get-Process -Id $item.ProcessId
            $rows+=@{pid=$item.ProcessId;name=$item.Name;path=$item.ExecutablePath;consoleHost=$consoleHost;cpuSeconds=$process.CPU;memoryBytes=$process.WorkingSet64;threads=$process.Threads.Count}
        }catch{$problems.Add('Process ended or inaccessible: '+$item.ProcessId)}
    }
    return @{at=(Get-Date).ToUniversalTime().ToString('o');processes=$rows}
}
$result=@{schema=1;at=(Get-Date).ToUniversalTime().ToString('o');gameRoot=$GameRoot;note='Read-only diagnosis; only this report is written. No process, world, cache, credential or game setting is changed.'}
try {
    $root=(Get-Item -LiteralPath $GameRoot).FullName
    $plugin=Join-Path $root 'plugins\archive-collector'
    $result.dll=FileInfoSafe (Join-Path $plugin 'archive-collector.dll') '36c57f33bba3e00d8d2f916e27ccef33521e82d4c921f65d2d962bf17fb49398'
    $manifest=Join-Path $plugin 'manifest.json'
    if(Test-Path -LiteralPath $manifest){$result.pluginVersion=(Get-Content -LiteralPath $manifest -Raw | ConvertFrom-Json).version}
    $result.hostProgram=FileInfoSafe (Join-Path $PSScriptRoot 'host\src\managed-game.mjs') '19a27dc2aa10bb5051572c171545f8778f772aea625f3de72395db7e4083f8cd'
    $result.processBefore=ProcessSnapshot
    $outbox=Join-Path $plugin 'data\outbox'
    $result.pending=QueueInfo $outbox
    $result.acknowledged=QueueInfo (Join-Path $outbox 'acknowledged')
    $lockPath=Join-Path $outbox 'collector.lock'
    if(Test-Path -LiteralPath $lockPath){
        try {$handle=[IO.File]::Open($lockPath,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::ReadWrite);$handle.Dispose();$result.collectorLock='readable'}
        catch{$result.collectorLock='locked-or-inaccessible'}
    }
    Start-Sleep -Seconds 3
    $result.processAfter=ProcessSnapshot
    $drive=(Get-Item -LiteralPath $root).PSDrive
    $result.disk=@{name=$drive.Name;freeBytes=$drive.Free;usedBytes=$drive.Used}
}catch{$problems.Add($_.Exception.GetType().FullName+': '+$_.Exception.Message)}
$result.errors=@($problems.ToArray())
$output=Join-Path $PSScriptRoot ('startup-check-'+(Get-Date -Format 'yyyyMMdd-HHmmss')+'.json')
$result | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $output -Encoding UTF8
Write-Host ('Check complete. Report: '+$output)

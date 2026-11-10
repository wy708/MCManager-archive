param([string]$GameDirectory)
$ErrorActionPreference='Stop'
if (!$GameDirectory) { $GameDirectory=Read-Host '请输入游戏服务端目录，例如 E:\bedrock-server-1.26.61.1' }
$gameRoot=(Resolve-Path -LiteralPath $GameDirectory).Path
if (!(Test-Path -LiteralPath (Join-Path $gameRoot 'bedrock_server.exe'))) { throw '该目录没有 bedrock_server.exe。' }
$plugins=Join-Path $gameRoot 'plugins'
$config=Join-Path $plugins 'mipmap/config.toml'
if (!(Test-Path -LiteralPath $config)) { throw '没有找到已安装的地图配置；此更新包用于已有地图插件。' }
foreach($process in (Get-CimInstance Win32_Process -Filter "Name='bedrock_server_mod.exe' OR Name='bedrock_server.exe'")) {
    if (!$process.ExecutablePath -or ([IO.Path]::GetDirectoryName($process.ExecutablePath) -ieq $gameRoot)) { throw '请先正常 stop 停服，确认游戏进程退出后再更新。' }
}
$wheel='endstone_mipmap-1.0.3+mcmanager.6-py2.py3-none-any.whl'
$hashes=Get-Content -LiteralPath (Join-Path $PSScriptRoot 'SHA256.json') -Raw -Encoding UTF8 | ConvertFrom-Json
foreach($name in @($wheel,'transparent_blocks.json')) {
    if((Get-FileHash -LiteralPath (Join-Path $PSScriptRoot $name) -Algorithm SHA256).Hash.ToLowerInvariant() -ne $hashes.$name) { throw ('文件校验失败：'+$name) }
}
$transparent=@{}
foreach($name in ((Get-Content -LiteralPath (Join-Path $PSScriptRoot 'transparent_blocks.json') -Raw -Encoding UTF8 | ConvertFrom-Json).blocks)) {
    if($name -notin @('minecraft:air','minecraft:cave_air','minecraft:void_air','minecraft:structure_void','minecraft:light_block','minecraft:barrier','minecraft:chemical_heat')) { $transparent[$name]=$true; $transparent[$name+'.png']=$true }
}
$original=[IO.File]::ReadAllBytes($config)
$text=[Text.Encoding]::UTF8.GetString($original)
$section=[regex]::Match($text,'(?ms)^\[blacklist\][ \t]*\r*\n(.*?)(?=^\[|\z)')
if($section.Success) {
    $list=[regex]::Match($section.Groups[1].Value,'(?ms)^blocks\s*=\s*\[(.*?)\]')
    if($list.Success) {
        $updated=[regex]::Replace($list.Groups[1].Value,'["'']([^"'']+)["'']\s*,?',{param($entry) if($transparent.ContainsKey($entry.Groups[1].Value)){return ''};return $entry.Value})
        $offset=$section.Groups[1].Index+$list.Groups[1].Index
        $text=$text.Substring(0,$offset)+$updated+$text.Substring($offset+$list.Groups[1].Length)
    }
}
$backup=Join-Path $gameRoot ('.mcmanager-map-updates\'+(Get-Date -Format yyyyMMdd-HHmmss)+'-'+[Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $backup | Out-Null
[IO.File]::WriteAllBytes((Join-Path $backup 'config.toml'),$original)
$oldWheels=@(Get-ChildItem -LiteralPath $plugins -Filter 'endstone_mipmap-*.whl' -File)
$writingNew=$false
try {
    foreach($old in $oldWheels) { Move-Item -LiteralPath $old.FullName -Destination (Join-Path $backup $old.Name) }
    $writingNew=$true
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot $wheel) -Destination (Join-Path $plugins $wheel)
    [IO.File]::WriteAllText($config,$text,[Text.UTF8Encoding]::new($false))
} catch {
    $newWheel=Join-Path $plugins $wheel
    if($writingNew -and (Test-Path -LiteralPath $newWheel)) { Remove-Item -LiteralPath $newWheel }
    foreach($old in $oldWheels) { $saved=Join-Path $backup $old.Name; if(Test-Path -LiteralPath $saved) { Copy-Item -LiteralPath $saved -Destination $old.FullName -Force } }
    [IO.File]::WriteAllBytes($config,$original)
    throw
}
Write-Host '地图插件已更新到 1.0.3+mcmanager.6。原配置和插件已备份：'
Write-Host $backup
Write-Host '已从地图黑名单恢复透明装饰方块。上传地址、密钥和其他配置保留。'
Write-Host '已修复进退服重复定时上传；位置变化每 5 秒发送一次，无变化每 30 秒保活。区块最多 4 个并行上传。'
Write-Host '使用原来的 03-start.cmd 启动；不修改游戏世界，不需要重新配置平台地址。'

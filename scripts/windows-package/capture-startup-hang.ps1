param([string]$GameRoot = 'E:\bedrock-server-1.26.61.1')
$ErrorActionPreference='Stop'
# Microsoft MiniDumpWriteDump, called from a separate process. No full-memory flag.
# https://learn.microsoft.com/windows/win32/api/minidumpapiset/nf-minidumpapiset-minidumpwritedump
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class StartupHangDump {
 [DllImport("kernel32.dll",SetLastError=true)] public static extern IntPtr OpenProcess(uint access,bool inherit,uint pid);
 [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr handle);
 [DllImport("dbghelp.dll",SetLastError=true)] public static extern bool MiniDumpWriteDump(IntPtr process,uint pid,IntPtr file,uint flags,IntPtr exception,IntPtr streams,IntPtr callback);
}
'@
$processHandle=[IntPtr]::Zero;$fileHandle=$null
try{
 $root=(Get-Item -LiteralPath $GameRoot).FullName
 $expected=Join-Path $root 'bedrock_server_mod.exe'
 $targets=@(Get-CimInstance Win32_Process -Filter "Name='bedrock_server_mod.exe'" | Where-Object {$_.ExecutablePath -eq $expected})
 if($targets.Count -ne 1){throw 'Expected exactly one running game in the configured directory. No game was started or stopped.'}
 $gameProcessId=[uint32]$targets[0].ProcessId
 $process=Get-Process -Id $gameProcessId
 $directory=Join-Path $PSScriptRoot ('startup-hang-'+(Get-Date -Format 'yyyyMMdd-HHmmss'))
 $null=New-Item -ItemType Directory -Path $directory
 $details=@{at=(Get-Date).ToUniversalTime().ToString('o');pid=$gameProcessId;gameRoot=$root;cpuSeconds=$process.CPU;memoryBytes=$process.WorkingSet64;threads=@();modules=@()}
 foreach($thread in $process.Threads){
  $wait=$null;if($thread.ThreadState.ToString() -eq 'Wait'){$wait=$thread.WaitReason.ToString()}
  $details.threads+=@{id=$thread.Id;state=$thread.ThreadState.ToString();wait=$wait;cpuSeconds=$thread.TotalProcessorTime.TotalSeconds}
 }
 foreach($module in $process.Modules){$details.modules+=@{name=$module.ModuleName;path=$module.FileName;base=$module.BaseAddress.ToInt64().ToString('x');bytes=$module.ModuleMemorySize;version=$module.FileVersionInfo.FileVersion}}
 $details | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $directory 'process.json') -Encoding UTF8
 $processHandle=[StartupHangDump]::OpenProcess(0x410,$false,$gameProcessId)
 if($processHandle -eq [IntPtr]::Zero){throw 'Cannot read game process. Run this check as administrator.'}
 $fileHandle=[IO.File]::Open((Join-Path $directory 'game.dmp'),[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
 if(-not [StartupHangDump]::MiniDumpWriteDump($processHandle,$gameProcessId,$fileHandle.SafeFileHandle.DangerousGetHandle(),0x1020,[IntPtr]::Zero,[IntPtr]::Zero,[IntPtr]::Zero)){throw ('Dump failed: '+[Runtime.InteropServices.Marshal]::GetLastWin32Error())}
 $fileHandle.Dispose();$fileHandle=$null
 $archive=$directory+'.zip'
 Compress-Archive -LiteralPath @((Join-Path $directory 'process.json'),(Join-Path $directory 'game.dmp')) -DestinationPath $archive
 Write-Host ('Report ready: '+$archive)
 Write-Host 'This contains diagnostic memory fragments. Share privately, not in a public release.'
}catch{Write-Host ('Check failed: '+$_.Exception.Message);exit 1}
finally{if($null -ne $fileHandle){$fileHandle.Dispose()};if($processHandle -ne [IntPtr]::Zero){[StartupHangDump]::CloseHandle($processHandle)|Out-Null}}

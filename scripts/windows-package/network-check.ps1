param([string]$GameRoot)
$ErrorActionPreference = 'Stop'
$report = [ordered]@{
    time = (Get-Date).ToString('o')
    note = 'Read-only snapshot. No firewall, game or authentication settings changed. Rule presence alone does not prove traffic is allowed.'
    errors = @()
}
function Read-Section([string]$Name, [scriptblock]$Action) {
    Write-Host ('Checking: ' + $Name)
    try { $report[$Name] = @(& $Action) }
    catch { $report.errors += ($Name + ': ' + $_.Exception.Message) }
}
try {
    if (-not $GameRoot) {
        $installation = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'config\installation.json') -Raw | ConvertFrom-Json
        $GameRoot = $installation.gameRoot
    }
    $GameRoot = (Resolve-Path -LiteralPath $GameRoot).Path
    $report.gameRoot = $GameRoot
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    $report.administrator = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    $report.powershell = $PSVersionTable.PSVersion.ToString()
    $programs = @((Join-Path $GameRoot 'bedrock_server.exe'), (Join-Path $GameRoot 'bedrock_server_mod.exe'))
    $gamePorts = @(35393,19132,19133)
    Read-Section 'properties' {
        Get-Content -LiteralPath (Join-Path $GameRoot 'server.properties') | Where-Object {
            $_ -match '^(transport|online-mode|server-port|server-portv6|server-public-ip|server-udp-ports)='
        } | ForEach-Object { [string]::Concat('', $_) }
    }
    foreach ($line in $report.properties) {
        if ($line -match '^server-port(?:v6)?=(\d+)$') { $gamePorts += [int]$Matches[1] }
    }
    Read-Section 'frameworkNetworkAdjustment' {
        $config = Get-Content -LiteralPath (Join-Path $GameRoot 'plugins\LeviLamina\config\Config.json') -Raw | ConvertFrom-Json
        $config.targeted.netherNetPatch | Select-Object enable,stunServers
    }
    Read-Section 'gameProcesses' {
        Get-CimInstance Win32_Process -Filter "Name='bedrock_server.exe' OR Name='bedrock_server_mod.exe'" |
            Select-Object ProcessId,Name,ExecutablePath
    }
    $gamePids = @($report.gameProcesses | Where-Object { $_.ExecutablePath -in $programs } | ForEach-Object { $_.ProcessId })
    Read-Section 'udpEndpoints' {
        Get-NetUDPEndpoint | Where-Object { $_.OwningProcess -in $gamePids -or $_.LocalPort -in $gamePorts } |
            Select-Object LocalAddress,LocalPort,OwningProcess
    }
    foreach ($endpoint in $report.udpEndpoints) {
        if ($endpoint.OwningProcess -in $gamePids) { $gamePorts += [int]$endpoint.LocalPort }
    }
    $gamePorts = @($gamePorts | Sort-Object -Unique)
    Read-Section 'tcpListeners' {
        Get-NetTCPConnection -State Listen | Where-Object { $_.OwningProcess -in $gamePids -or $_.LocalPort -in $gamePorts } |
            Select-Object LocalAddress,LocalPort,OwningProcess
    }
    Read-Section 'networkProfiles' {
        Get-NetConnectionProfile | Select-Object InterfaceAlias,NetworkCategory,IPv4Connectivity,IPv6Connectivity
    }
    Read-Section 'firewallProfiles' {
        Get-NetFirewallProfile -PolicyStore ActiveStore |
            Select-Object Name,Enabled,DefaultInboundAction,DefaultOutboundAction,AllowInboundRules,AllowLocalFirewallRules,LogBlocked,LogFileName
    }
    $report.firewallScope = 'Application-specific rules only. Broad port rules, interface/IPsec policy and third-party security software are not evaluated. No rule is not proof of blocking.'
    Read-Section 'firewallRules' {
        # The COM policy reader avoids very slow per-rule CIM association queries.
        $policy = New-Object -ComObject HNetCfg.FwPolicy2
        foreach ($rule in $policy.Rules) {
            $application = [string]$rule.ApplicationName
            if (-not $application -or [Environment]::ExpandEnvironmentVariables($application) -notin $programs) { continue }
            $protocol = $rule.Protocol
            [pscustomobject]@{
                name=$rule.Name; program=$application; enabled=$rule.Enabled
                action=$(if ($rule.Action -eq 1) { 'Allow' } else { 'Block' })
                direction=$(if ($rule.Direction -eq 1) { 'Inbound' } else { 'Outbound' })
                profileMask=$rule.Profiles; profileLegend='1=Domain,2=Private,4=Public; bitmask'
                protocol=$protocol
                localPort=$(if ($protocol -eq 6 -or $protocol -eq 17) { $rule.LocalPorts } else { 'Any' })
                remotePort=$(if ($protocol -eq 6 -or $protocol -eq 17) { $rule.RemotePorts } else { 'Any' })
                localAddress=$rule.LocalAddresses; remoteAddress=$rule.RemoteAddresses
                service=$rule.ServiceName; interfaceTypes=$rule.InterfaceTypes
                effectivePermissionDetermined=$false
            }
        }
    }
} catch { $report.errors += $_.Exception.Message }
$outputFile = Join-Path $PSScriptRoot ('network-report-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.json')
Write-Host 'Writing report...'
$report | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $outputFile -Encoding UTF8
Write-Host ('Saved: ' + $outputFile)
Write-Host 'Send this report for review. Keep the server running when collecting it.'
if ($report.errors.Count) { Write-Host 'Some checks could not complete; see errors in the report. Running as administrator may be required.' }

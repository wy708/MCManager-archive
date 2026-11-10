$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$envPath = Join-Path $projectRoot '.env'
if (!(Test-Path -LiteralPath $envPath)) { throw 'Run ./scripts/setup.ps1 first.' }
foreach ($line in Get-Content -LiteralPath $envPath) {
    if ($line -match '^(MCM_[A-Z_]+)=(.*)$') { [Environment]::SetEnvironmentVariable($Matches[1], $Matches[2], 'Process') }
}
if (!$env:JAVA_HOME) {
    $javacPath = (Get-Command javac -ErrorAction Stop).Source
    $javaPath = Join-Path (Split-Path -Parent (Split-Path -Parent $javacPath)) 'lib'
    if (Test-Path -LiteralPath $javaPath) { $env:JAVA_HOME = Split-Path -Parent $javaPath }
    elseif (Test-Path -LiteralPath 'C:\Program Files\Java\jdk-21\bin\java.exe') { $env:JAVA_HOME = 'C:\Program Files\Java\jdk-21' }
    else { throw 'Set JAVA_HOME to a Java 21 JDK directory.' }
}
# The database password in .env is for Docker PostgreSQL. Local H2 uses its own setting.
if (!$env:MCM_DB_URL) { $env:MCM_DB_PASSWORD = ''; $env:MCM_DB_USER = 'sa' }
Push-Location (Join-Path $projectRoot 'backend')
try { & .\mvnw.cmd -B -ntp spring-boot:run; if ($LASTEXITCODE -ne 0) { throw 'Backend exited with an error.' } }
finally { Pop-Location }

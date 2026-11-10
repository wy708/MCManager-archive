$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$envPath = Join-Path $projectRoot '.env'
if (Test-Path -LiteralPath $envPath) {
    Write-Output 'Existing .env preserved.'
    exit 0
}
function New-RandomSecret {
    $bytes = New-Object byte[] 24
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
    return [Convert]::ToBase64String($bytes)
}
$settings = @(
    'MCM_ADMIN_USERNAME=admin'
    "MCM_ADMIN_PASSWORD=$(New-RandomSecret)"
    "MCM_DB_PASSWORD=$(New-RandomSecret)"
    'MCM_COOKIE_SECURE=false'
    'MCM_WEB_BIND=127.0.0.1'
    'MCM_WEB_PORT=8088'
)
[IO.File]::WriteAllLines($envPath, $settings, (New-Object Text.UTF8Encoding($false)))
Write-Output 'Created .env with random credentials. Read MCM_ADMIN_PASSWORD there to sign in.'

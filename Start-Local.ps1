$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$secretFile = Join-Path $PSScriptRoot '.env.deploy.local'
if (-not (Test-Path -LiteralPath $secretFile)) {
    throw 'Local server configuration is missing. Configure CREATIVE_RADAAR_PEPPER and ACCESS_CODE_DIGESTS before starting.'
}
Get-Content -LiteralPath $secretFile | ForEach-Object {
    $entry = $_.Split('=', 2)
    if ($entry.Length -eq 2) { [Environment]::SetEnvironmentVariable($entry[0], $entry[1], 'Process') }
}
$env:NODE_ENV = 'production'
$env:PORT = '3032'
$env:DATA_DIR = Join-Path $env:TEMP 'creative-radaar-upload-runtime-20261030'
if (-not (Test-Path -LiteralPath 'dist/index.html')) { npm run build; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE } }
node --import tsx server.ts

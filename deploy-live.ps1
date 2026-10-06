# Deploy AiX Track to LIVE (pm2: mom-tool, port 3000, track.aiextensive.com).
# Sends only server.js, public/index.html and ops/ — never .env, uploads or node_modules.
# Run: right-click this file → "Run with PowerShell". You will be asked for the server's root password once.
# The server side (ops/deploy-live.sh) stops before changing anything if packages differ or a MOC
# is being processed, backs up the database and the code, and rolls back if /health fails.
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot

$server = 'root@200.234.44.166'
$stage  = '/root/mom-tool-deploy-staging'
$remote = "rm -rf $stage && mkdir -p $stage && tar xzf - -C $stage && bash $stage/ops/deploy-live.sh $stage"

Write-Host ''
Write-Host 'Deploying AiX Track to LIVE: track.aiextensive.com' -ForegroundColor Red
Write-Host 'Files: server.js, public/index.html, ops/  (plus package files, for comparison only)' -ForegroundColor Cyan
Write-Host ''
$answer = Read-Host 'Type LIVE to continue'
if ($answer -ne 'LIVE') { Write-Host 'Cancelled.'; Read-Host 'Press Enter to close'; exit }
Write-Host 'Enter the server root password when asked (typing is hidden).' -ForegroundColor Yellow
Write-Host ''

# cmd /c keeps the tar → ssh pipe binary-safe (Windows PowerShell would corrupt it)
cmd /c "tar -czf - server.js public/index.html ops package.json package-lock.json | ssh -o StrictHostKeyChecking=accept-new $server `"$remote`""

Write-Host ''
if ($LASTEXITCODE -eq 0) {
  Write-Host 'Live deploy finished. Open https://track.aiextensive.com and do one short test upload.' -ForegroundColor Green
} else {
  Write-Host "Deploy did not complete (exit code $LASTEXITCODE). Read the STOPPED / ROLLED BACK message above and send it over." -ForegroundColor Red
}
Read-Host 'Press Enter to close'

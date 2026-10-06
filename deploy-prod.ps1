# Deploy AiX Track to the LIVE app. Pass -App to match the pm2 name / folder on the server.
# Run: powershell -ExecutionPolicy Bypass -File .\deploy-prod.ps1 -App mom-tool
param([string]$App = 'mom-tool')
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot

$server = 'root@200.234.44.166'
# npm install runs only when package.json / package-lock.json changed - a reinstall while the app runs can crash it (MODULE_NOT_FOUND)
$remote = "cd ~/$App && OLD=`$(cat package.json package-lock.json 2>/dev/null | md5sum | cut -c1-32) && tar xzf - && NEW=`$(cat package.json package-lock.json 2>/dev/null | md5sum | cut -c1-32) && if [ x`$OLD != x`$NEW ]; then echo Packages changed - running npm install; npm install --no-audit --no-fund; else echo Packages unchanged - skipping npm install; fi && pm2 restart $App && sleep 4 && pm2 logs $App --lines 25 --nostream"

Write-Host ''
Write-Host "LIVE DEPLOY - $PSScriptRoot" -ForegroundColor Yellow
Write-Host "to $server : ~/$App   (pm2 restart $App only)" -ForegroundColor Yellow
Write-Host 'Skips node_modules, uploads, .env, .git' -ForegroundColor Cyan
$ok = Read-Host 'Type the app name again to confirm'
if ($ok -ne $App) { Write-Host 'Cancelled.' -ForegroundColor Red; Read-Host 'Press Enter to close'; exit 1 }
Write-Host 'Enter the server root password when asked (typing is hidden).' -ForegroundColor Yellow
Write-Host ''

# cmd /c keeps the tar to ssh pipe binary-safe (Windows PowerShell would corrupt it)
cmd /c "tar --exclude=node_modules --exclude=uploads --exclude=.env --exclude=.env.* --exclude=.git --exclude=deploy-test.ps1 --exclude=deploy-prod.ps1 -czf - . | ssh -o StrictHostKeyChecking=accept-new $server `"$remote`""

if ($LASTEXITCODE -eq 0) {
  Write-Host ''
  Write-Host 'Deployed. Look above for [db] Tables ready and the AiX Track start line.' -ForegroundColor Green
} else {
  Write-Host ''
  Write-Host "Deploy failed (exit code $LASTEXITCODE). Copy the messages above and send them over." -ForegroundColor Red
}
Read-Host 'Press Enter to close'
# Deploy AiX Track to the TEST app (pm2: mom-tool-test, port 3002) — never touches live mom-tool.
# Run: right-click this file → "Run with PowerShell". You will be asked for the server's root password once.
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot

$server = 'root@200.234.44.166'
# npm install runs only when package.json / package-lock.json changed — a reinstall while the app runs can crash it (MODULE_NOT_FOUND)
$remote = 'cd ~/mom-tool-test && OLD=$(cat package.json package-lock.json 2>/dev/null | md5sum | cut -c1-32) && tar xzf - && NEW=$(cat package.json package-lock.json 2>/dev/null | md5sum | cut -c1-32) && if [ x$OLD != x$NEW ]; then echo Packages changed - running npm install; npm install --no-audit --no-fund; else echo Packages unchanged - skipping npm install; fi && pm2 restart mom-tool-test && sleep 4 && pm2 logs mom-tool-test --lines 25 --nostream'

Write-Host ''
Write-Host "Uploading AiX Track from $PSScriptRoot" -ForegroundColor Cyan
Write-Host "to $server : ~/mom-tool-test  (skips node_modules, uploads, .env, .git)" -ForegroundColor Cyan
Write-Host 'Enter the server root password when asked (typing is hidden).' -ForegroundColor Yellow
Write-Host ''

# cmd /c keeps the tar → ssh pipe binary-safe (Windows PowerShell would corrupt it)
cmd /c "tar --exclude=node_modules --exclude=uploads --exclude=.env --exclude=.env.* --exclude=.git --exclude=deploy-test.ps1 --exclude=setup-test-drive-env.ps1 -czf - . | ssh -o StrictHostKeyChecking=accept-new $server `"$remote`""

if ($LASTEXITCODE -eq 0) {
  Write-Host ''
  Write-Host 'Deployed. Look above for "[db] Tables ready" and "AiX Track -> http://localhost:3002".' -ForegroundColor Green
} else {
  Write-Host ''
  Write-Host "Deploy failed (exit code $LASTEXITCODE). Copy the messages above and send them over." -ForegroundColor Red
}
Read-Host 'Press Enter to close'

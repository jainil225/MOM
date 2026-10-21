# One-time setup for the TEST app (pm2: mom-tool-test) — adds the Google Drive
# storage and bonus-credit settings to the server's .env.
#
# deploy-test.ps1 deliberately never uploads .env, so these keys have to be added
# on the server once. Running this twice is safe: it checks first and does
# nothing if the keys are already there.
#
# Run: right-click this file -> "Run with PowerShell". You will be asked for the
# server's root password once.
#
# After this, deploy the code with deploy-test.ps1 as usual.

$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot

$server   = 'root@200.234.44.166'
$appDir   = '~/mom-tool-test'
# The address customers reach the TEST app on. This exact URL must also be added
# as an authorised redirect URI on the OAuth client in Google Cloud Console.
$testHost = 'https://testtrack.aiextensive.com'

$block = @"

# ── Signup and referral bonuses (credits) — change and restart ──
JOINING_BONUS_CREDITS=86
REFERRAL_FRIEND_BONUS=30
REFERRAL_REWARD_CREDITS=86

# ── Customer Google Drive storage ──
# Blank client id/secret means the login OAuth client is reused.
# The callback URL below must also be registered in Google Cloud Console.
DRIVE_STORAGE=on
GOOGLE_DRIVE_CLIENT_ID=
GOOGLE_DRIVE_CLIENT_SECRET=
GOOGLE_DRIVE_CALLBACK_URL=$testHost/auth/drive/callback
DRIVE_FOLDER_NAME=AiX Track Recordings
DRIVE_SWEEP_MINUTES=30
"@

# Sent base64-encoded so no quote or special character can be mangled on the way
$b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($block))

$remote = "cd $appDir && " +
          "cp .env .env.bak.`$(date +%Y%m%d%H%M%S) && " +
          "if grep -q '^GOOGLE_DRIVE_CALLBACK_URL=' .env; then " +
          "echo 'ALREADY PRESENT - .env left unchanged'; else " +
          "echo $b64 | base64 -d >> .env && echo 'ADDED - Drive and bonus settings appended to .env'; fi && " +
          "echo '--- current values ---' && " +
          "grep -E '^(DRIVE_|GOOGLE_DRIVE_|JOINING_BONUS|REFERRAL_)' .env"

Write-Host ''
Write-Host "Adding Drive + bonus settings to $server : $appDir/.env" -ForegroundColor Cyan
Write-Host "Callback URL: $testHost/auth/drive/callback" -ForegroundColor Cyan
Write-Host 'A timestamped backup of .env is made first.' -ForegroundColor Cyan
Write-Host 'Enter the server root password when asked (typing is hidden).' -ForegroundColor Yellow
Write-Host ''

ssh -o StrictHostKeyChecking=accept-new $server $remote

if ($LASTEXITCODE -eq 0) {
  Write-Host ''
  Write-Host 'Done. Next: run deploy-test.ps1 to upload the code, then restart happens automatically.' -ForegroundColor Green
  Write-Host 'Reminder: add the callback URL above to the OAuth client in Google Cloud Console.' -ForegroundColor Yellow
} else {
  Write-Host ''
  Write-Host "Failed (exit code $LASTEXITCODE). Copy the messages above and send them over." -ForegroundColor Red
}
Read-Host 'Press Enter to close'

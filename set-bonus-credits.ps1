# Sets the signup and referral bonus credits in the server .env of TEST and LIVE.
#   JOINING_BONUS_CREDITS   — every new account, once
#   REFERRAL_REWARD_CREDITS — the referrer, when the invited friend creates their first MOC
#   REFERRAL_FRIEND_BONUS   — the invited friend, on signup (left as it is unless changed below)
#
# Changes .env only (a timestamped backup is made first). It does NOT restart the apps:
# run this before deploy-test.ps1 / deploy-live.ps1, whose restart picks the new values up.
# Run: right-click this file -> "Run with PowerShell". Enter the server root password once.

$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot

$server  = 'root@200.234.44.166'
$joining = 86
$reward  = 86
$usdInr  = 96   # rupees per US dollar, used for the ₹ figures on the usage and cost pages
$alertTo = 'carajnikant@gmail.com,jainildoshi22@gmail.com'   # emailed when any provider balance is low or out of credit

# Replace the key when present, append it when missing — in each app folder that exists
$set = 'set_key(){ if grep -q "^$1=" .env; then sed -i "s/^$1=.*/$1=$2/" .env; else echo "$1=$2" >> .env; fi; }'
$remote = "$set; for d in ~/mom-tool-test ~/mom-tool; do " +
          "[ -f `$d/.env ] || { echo `"`$d: no .env - skipped`"; continue; }; " +
          "cd `$d && cp .env .env.bak.`$(date +%Y%m%d%H%M%S) && " +
          "sed -i 's/carajanikant@gmail\.com/carajnikant@gmail.com/g' .env && " +
          "set_key JOINING_BONUS_CREDITS $joining && set_key REFERRAL_REWARD_CREDITS $reward && set_key USD_INR $usdInr && set_key BALANCE_ALERT_EMAILS $alertTo && " +
          "echo `"--- `$d ---`" && grep -E '^(JOINING_BONUS|REFERRAL_|USD_INR|BALANCE_ALERT_EMAILS)' .env; done"

Write-Host ''
Write-Host "Setting JOINING_BONUS_CREDITS=$joining, REFERRAL_REWARD_CREDITS=$reward, USD_INR=$usdInr and BALANCE_ALERT_EMAILS=$alertTo on TEST and LIVE" -ForegroundColor Cyan
Write-Host 'A timestamped backup of each .env is made first. Apps are not restarted.' -ForegroundColor Cyan
Write-Host 'Enter the server root password when asked (typing is hidden).' -ForegroundColor Yellow
Write-Host ''

ssh -o StrictHostKeyChecking=accept-new $server $remote

if ($LASTEXITCODE -eq 0) {
  Write-Host ''
  Write-Host 'Done. The new values apply when each app restarts - run deploy-test.ps1, then deploy-live.ps1.' -ForegroundColor Green
} else {
  Write-Host ''
  Write-Host "Failed (exit code $LASTEXITCODE). Copy the messages above and send them over." -ForegroundColor Red
}
Read-Host 'Press Enter to close'

#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════
#  AiX Track — deploy to LIVE (pm2: mom-tool, port 3000, track.aiextensive.com)
#  Run by deploy-live.ps1 on your PC; not meant to be run by hand.
#  Usage:  bash ops/deploy-live.sh <staging dir>
#
#  Stops before touching anything if: packages differ from live, someone is
#  mid-processing, or the database backup fails. After the restart it checks
#  /health; if the app does not come up healthy it restores the old code.
# ═══════════════════════════════════════════════════════════════════════
set -uo pipefail

STAGE="${1:?Usage: deploy-live.sh <staging dir>}"
APP=/root/mom-tool
PM2_NAME=mom-tool
PORT=3000
# Everything the live app needs from this release. Local modules server.js requires must be listed here.
FILES=(server.js drive.js moc-quality.js public/index.html public/history.html public/js/rates.js public/usage.html public/cost.html public/credits.html public/activity.html public/admin.html public/login.html public/profile.html public/pricing.html public/terms.html public/privacy.html public/usage-policy.html public/terms-v1.html public/privacy-v1.html public/consent.html public/js/theme.js prompts/master-moc-prompt.md ops)
STAMP="$(date +%Y%m%d-%H%M%S)"
CODE_BACKUP_DIR=/var/backups/aix/code
CODE_BACKUP="$CODE_BACKUP_DIR/$PM2_NAME-$STAMP.tgz"

step() { echo; echo "── $1"; }
stop() { echo; echo "STOPPED: $1"; echo "Nothing on live was changed."; rm -rf "$STAGE"; exit 1; }

cd "$APP" || stop "$APP not found"

# 0. Every file in this release, and every local module server.js requires, must be in the upload
step "0/6  Checking the upload is complete"
for f in "${FILES[@]}"; do [ -e "$STAGE/$f" ] || stop "$f is missing from the upload."; done
for mod in $(grep -oE "require\(['\"]\./[^'\"]+['\"]\)" "$STAGE/server.js" | sed -E "s/require\(['\"]\.\/([^'\"]+)['\"]\)/\1/"); do
  [ -e "$STAGE/$mod" ] || [ -e "$STAGE/$mod.js" ] || stop "server.js needs ./$mod but it is not in the upload — add it to FILES in deploy-live.sh and deploy-live.ps1."
done
echo "     all files present"

# 1. Packages — this deploy never runs npm install on live and never replaces its lock file.
#    package.json must match. A lock file that differs only by version drift is fine as
#    long as every module the new server.js needs loads from live's node_modules.
step "1/6  Checking packages"
cmp -s "$STAGE/package.json" "$APP/package.json"   || stop "package.json differs from live. New packages would need npm install — send this message over before deploying."
if cmp -s "$STAGE/package-lock.json" "$APP/package-lock.json"; then
  echo "     same packages — no npm install needed"
else
  echo "     package.json matches; package-lock.json differs — checking every module server.js needs loads on live"
  missing="$(node "$STAGE/ops/check-modules.js" "$STAGE/server.js" "$APP")" || stop "could not run the module check"
  [ -z "$missing" ] || stop "these modules are not installed on live: $missing — send this message over before deploying."
  echo "     all modules present — no npm install needed"
fi

# 2. Don't cut off a MOC that is being processed right now
step "2/6  Checking nobody is mid-processing"
busy=1
for i in 1 2 3 4 5 6; do
  open="$(ss -Htn state established "( sport = :$PORT )" 2>/dev/null | wc -l)"
  if [ "$open" -eq 0 ]; then busy=0; break; fi
  echo "     $open request(s) in progress — waiting 10s ($i/6)"
  sleep 10
done
[ "$busy" -eq 0 ] || stop "requests still in progress after 60s (likely a MOC being generated). Try again in a few minutes."
echo "     idle"

# 3. Database backup — the new server.js adds columns on start-up
step "3/6  Backing up the database"
bash "$STAGE/ops/backup-db.sh" "$APP" || stop "database backup failed (see above)"
ls -lh "/var/backups/aix/$PM2_NAME/" 2>/dev/null | tail -1

# 4. Code backup
step "4/6  Backing up the current code"
mkdir -p "$CODE_BACKUP_DIR"; chmod 700 "$CODE_BACKUP_DIR"
existing=(); for f in "${FILES[@]}"; do [ -e "$f" ] && existing+=("$f"); done
tar czf "$CODE_BACKUP" "${existing[@]}" || stop "could not back up the current code"
echo "     $CODE_BACKUP"

# 5. Copy the new files in and restart
step "5/6  Installing new files and restarting $PM2_NAME"
for f in "${FILES[@]}"; do
  [ "$f" = ops ] && continue
  mkdir -p "$APP/$(dirname "$f")" && cp "$STAGE/$f" "$APP/$f"
done
mkdir -p "$APP/ops" && cp "$STAGE"/ops/* "$APP/ops/"
pm2 restart "$PM2_NAME" >/dev/null && echo "     restarted"

# 6. Health check — roll back if the app does not come up
step "6/6  Waiting for the app to report healthy"
healthy=0
for i in $(seq 1 15); do
  sleep 2
  code="$(curl -s -o /tmp/aix-health.json -w '%{http_code}' "http://127.0.0.1:$PORT/health" || true)"
  if [ "$code" = "200" ]; then healthy=1; break; fi
done

if [ "$healthy" -eq 1 ]; then
  echo "     healthy: $(cat /tmp/aix-health.json)"
  echo
  pm2 logs "$PM2_NAME" --lines 15 --nostream
  rm -rf "$STAGE"
  echo
  echo "DEPLOYED. Rollback, if ever needed:"
  echo "  cd $APP && tar xzf $CODE_BACKUP && pm2 restart $PM2_NAME"
  exit 0
fi

echo "     NOT healthy after 30s (last status: ${code:-none}) — ROLLING BACK"
pm2 logs "$PM2_NAME" --lines 40 --nostream
tar xzf "$CODE_BACKUP" -C "$APP" && pm2 restart "$PM2_NAME" >/dev/null
sleep 5
pm2 describe "$PM2_NAME" | grep -E "status|uptime|restarts"
rm -rf "$STAGE"
echo
echo "ROLLED BACK to the previous code. Live is on the old version. Send the log above over."
exit 1

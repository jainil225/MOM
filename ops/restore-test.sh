#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════
#  AiX Track — prove the latest backup can be restored
#  Usage:  RESTORE_TEST_DATABASE_URL='postgres://…/aix_restore_test' \
#          bash ops/restore-test.sh /root/mom-tool-test
#  Restores the newest dump into a SEPARATE, empty database (for example a
#  Neon branch made for this), then compares row counts with the live one.
#  It refuses to run against the app's own DATABASE_URL.
# ═══════════════════════════════════════════════════════════════════════
set -euo pipefail

APP_DIR="${1:-$HOME/mom-tool}"
NAME="$(basename "$APP_DIR")"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/aix/$NAME}"
TARGET="${RESTORE_TEST_DATABASE_URL:-}"
LIVE="$(grep -E '^DATABASE_URL=' "$APP_DIR/.env" | head -1 | cut -d= -f2- | sed -e 's/^["'\'']//' -e 's/["'\'']$//')"

[ -n "$TARGET" ] || { echo "Set RESTORE_TEST_DATABASE_URL to an empty test database first."; exit 1; }
[ "$TARGET" != "$LIVE" ] || { echo "Refusing: RESTORE_TEST_DATABASE_URL is the live database."; exit 1; }

LATEST="$(ls -1t "$BACKUP_DIR"/aix-*.dump 2>/dev/null | head -1 || true)"
[ -n "$LATEST" ] || { echo "No backups found in $BACKUP_DIR"; exit 1; }
echo "Restoring $LATEST"
echo "into the test database…"

pg_restore --clean --if-exists --no-owner --no-privileges --dbname="$TARGET" "$LATEST"

echo
echo "Row counts — backup copy vs live now (live may be slightly higher if people used the app since):"
printf '%-24s %12s %12s\n' table restored live
for t in users mom_sessions credit_orders credits_log invoices recording_uploads; do
  r="$(psql "$TARGET" -tAc "SELECT COUNT(*) FROM $t" 2>/dev/null || echo '-')"
  l="$(psql "$LIVE"   -tAc "SELECT COUNT(*) FROM $t" 2>/dev/null || echo '-')"
  printf '%-24s %12s %12s\n' "$t" "$r" "$l"
done
echo
echo "Restore test finished $(date -Is). Record the date and result in your backup log."

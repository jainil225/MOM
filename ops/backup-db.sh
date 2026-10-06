#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════
#  AiX Track — daily PostgreSQL backup
#  Usage:  bash ops/backup-db.sh /root/mom-tool-test
#  Reads DATABASE_URL from <app dir>/.env, writes a compressed dump,
#  checks the dump can be read back, keeps 14 days, emails on failure.
#  Optional: BACKUP_S3_URI=s3://bucket/aix-backups in .env copies each
#  dump off the server (needs the aws CLI).
# ═══════════════════════════════════════════════════════════════════════
set -euo pipefail

APP_DIR="${1:-$HOME/mom-tool}"
NAME="$(basename "$APP_DIR")"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/aix/$NAME}"
KEEP_DAYS="${KEEP_DAYS:-14}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

env_value() { grep -E "^$1=" "$APP_DIR/.env" | head -1 | cut -d= -f2- | sed -e 's/^["'\'']//' -e 's/["'\'']$//'; }

fail() {
  echo "$(date -Is) BACKUP FAILED: $1" >&2
  node "$SCRIPT_DIR/notify.js" "$APP_DIR" "Database backup failed ($NAME)" "$1" || true
  exit 1
}
trap 'fail "backup script stopped at line $LINENO"' ERR

DATABASE_URL="$(env_value DATABASE_URL)"
[ -n "$DATABASE_URL" ] || fail "DATABASE_URL not found in $APP_DIR/.env"
command -v pg_dump >/dev/null || fail "pg_dump is not installed (see ops/README.md)"

mkdir -p "$BACKUP_DIR"; chmod 700 "$BACKUP_DIR"
STAMP="$(date +%Y%m%d-%H%M)"
OUT="$BACKUP_DIR/aix-$NAME-$STAMP.dump"

pg_dump --format=custom --no-owner --no-privileges --dbname="$DATABASE_URL" --file="$OUT.part" \
  || fail "pg_dump returned an error (check that the pg_dump version is the same or newer than the database)"
pg_restore --list "$OUT.part" > /dev/null || fail "the new dump could not be read back"
mv "$OUT.part" "$OUT"; chmod 600 "$OUT"

S3_URI="$(env_value BACKUP_S3_URI || true)"
if [ -n "$S3_URI" ]; then
  command -v aws >/dev/null || fail "BACKUP_S3_URI is set but the aws CLI is not installed"
  AWS_ACCESS_KEY_ID="$(env_value AWS_ACCESS_KEY_ID)" AWS_SECRET_ACCESS_KEY="$(env_value AWS_SECRET_ACCESS_KEY)" \
  AWS_DEFAULT_REGION="$(env_value AWS_REGION)" \
    aws s3 cp "$OUT" "${S3_URI%/}/$NAME/$(basename "$OUT")" --only-show-errors --sse AES256 \
    || fail "copy to $S3_URI failed"
fi

find "$BACKUP_DIR" -name 'aix-*.dump' -mtime +"$KEEP_DAYS" -delete
echo "$(date -Is) backup ok: $OUT ($(du -h "$OUT" | cut -f1))"

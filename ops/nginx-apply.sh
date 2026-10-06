#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════
#  AiX Track — let long uploads and long processing finish through Nginx
#  Usage:  bash ops/nginx-apply.sh testtrack.aiextensive.com
#  Settings already in the site file get the new value; missing ones are
#  added to every "location / {" block. The config is tested before
#  reloading. If the test fails, the original file is put back and Nginx is
#  not reloaded.
# ═══════════════════════════════════════════════════════════════════════
set -euo pipefail

DOMAIN="${1:?Usage: bash ops/nginx-apply.sh <domain>}"

# Uploads up to 2 GB; up to 4 hours for a long recording to upload and process.
# client_body_timeout is the one that matters on mobile: Nginx defaults to 60s and
# returns 408 if the phone stalls mid-part, which aborts the whole upload.
SETTINGS=(
  "client_max_body_size 2100m"
  "client_body_timeout 300s"
  "proxy_request_buffering off"
  "proxy_connect_timeout 60s"
  "proxy_send_timeout 14400s"
  "proxy_read_timeout 14400s"
  "send_timeout 14400s"
)

# Dots are escaped and the domain must be bounded by whitespace or ";" — otherwise
# "track.aiextensive.com" also matches "test.track.aiextensive.com" and the wrong
# site gets patched while the real one stays on Nginx defaults.
ESC="$(printf '%s' "$DOMAIN" | sed 's/[.]/[.]/g')"   # dots -> [.] so they cannot act as wildcards
PAT="server_name[^;]*[[:space:]]${ESC}[[:space:];]"
MATCHES="$(grep -lE "$PAT" /etc/nginx/sites-enabled/* /etc/nginx/conf.d/*.conf 2>/dev/null || true)"
[ -n "$MATCHES" ] || { echo "No Nginx file found with server_name $DOMAIN"; exit 1; }
if [ "$(printf '%s\n' "$MATCHES" | wc -l)" -gt 1 ]; then
  echo "More than one Nginx file has server_name $DOMAIN — fix by hand:"
  printf '%s\n' "$MATCHES"
  exit 1
fi
SITE="$(readlink -f "$MATCHES")"
echo "Site file: $SITE"
echo "Matched:   $(grep -hE "$PAT" "$SITE" | head -1 | sed 's/^[[:space:]]*//')"

# The backup must NOT sit next to the site file: Nginx includes
# /etc/nginx/sites-enabled/* with no extension filter, so a .bak left there is
# parsed as a second config ("conflicting server name" warnings) and can even
# win over the real file. Keep backups outside every included directory.
BACKUP_DIR=/var/backups/nginx-aix
mkdir -p "$BACKUP_DIR"
BACKUP="$BACKUP_DIR/$(basename "$SITE").bak-$(date +%Y%m%d-%H%M%S)"
cp "$SITE" "$BACKUP"
echo "Backup of the original: $BACKUP"

# Remove an include left by an older version of this script
sed -i '/include snippets\/aix-long-requests.conf;/d' "$SITE"

MISSING=""
for s in "${SETTINGS[@]}"; do
  key="${s%% *}"; val="${s#* }"
  if grep -Eq "^[[:space:]]*$key[[:space:]]" "$SITE"; then
    sed -i -E "s#^([[:space:]]*)$key[[:space:]]+[^;]*;#\1$key $val;#" "$SITE"
    echo "  updated  $key $val"
  else
    MISSING="$MISSING\\n\\1    $key $val;"
    echo "  adding   $key $val"
  fi
done

if [ -n "$MISSING" ]; then
  sed -i -E "s#^([[:space:]]*)location[[:space:]]+/[[:space:]]*\{[[:space:]]*\$#&$MISSING#" "$SITE"
  added=0
  for s in "${SETTINGS[@]}"; do grep -Eq "^[[:space:]]*${s%% *}[[:space:]]" "$SITE" || added=1; done
  if [ "$added" = 1 ]; then
    cp "$BACKUP" "$SITE"
    echo "Could not find a 'location / {' line to add the missing settings — original restored. Send: cat $SITE"
    exit 1
  fi
fi

if nginx -t; then
  systemctl reload nginx
  echo "Nginx reloaded. Long requests now allowed for $DOMAIN."
else
  cp "$BACKUP" "$SITE"
  echo "Nginx config test failed — original file restored, Nginx NOT reloaded. Send the output above."
  exit 1
fi

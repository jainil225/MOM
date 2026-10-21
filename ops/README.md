# AiX Track: server operations

Setup for backups, alerts and long uploads. Run every command on the server as root. The examples use the test app (`~/mom-tool-test`, port 3002, testtrack.aiextensive.com). For live, change the folder, port and domain.

## 1. Long recordings through Nginx (one time)

```bash
cd ~/mom-tool-test
bash ops/nginx-apply.sh testtrack.aiextensive.com
```

This lets uploads of up to 2 GB, and up to 4 hours of uploading and processing, pass through Nginx. Settings already in the site file get the new value, and missing ones are added to `location / {`. The script backs up the site file first. If `nginx -t` fails, it restores the backup and does not reload.

## 2. Database backups (one time)

Install the PostgreSQL client. `pg_dump` must be the same major version as the database, or newer:

```bash
psql "$(grep ^DATABASE_URL= ~/mom-tool-test/.env | cut -d= -f2-)" -tAc 'show server_version'
# example for version 17 on Ubuntu:
apt-get install -y postgresql-common && /usr/share/postgresql-common/pgdg/apt.postgresql.org.sh -y
apt-get install -y postgresql-client-17
```

Run one backup by hand and check it says `backup ok`:

```bash
bash ~/mom-tool-test/ops/backup-db.sh ~/mom-tool-test
ls -lh /var/backups/aix/mom-tool-test/
```

Backups are kept for 14 days in `/var/backups/aix/<app>/`. To keep a copy off the server as well, add `BACKUP_S3_URI=s3://your-bucket/aix-backups` to `.env` and install the AWS CLI.

## 3. Prove a restore works (once now, then once a month)

Create an empty database for the test, for example a new branch in the Neon console called `restore-test`. Then:

```bash
RESTORE_TEST_DATABASE_URL='postgres://…restore-test…' bash ~/mom-tool-test/ops/restore-test.sh ~/mom-tool-test
```

The row counts for the backup and live should match, or live should be slightly higher. Write down the date and result. Delete the test branch afterwards.

## 4. Schedule backups and the health check (one time)

```bash
crontab -e
```

Add these lines:

```
# AiX Track — daily database backup at 02:30
30 2 * * * bash /root/mom-tool-test/ops/backup-db.sh /root/mom-tool-test >> /var/log/aix-backup.log 2>&1
# AiX Track — app and disk check every 5 minutes
*/5 * * * * node /root/mom-tool-test/ops/healthcheck.js /root/mom-tool-test http://127.0.0.1:3002/health >> /var/log/aix-health.log 2>&1
```

## 5. What sends an email, and to whom

Alerts go to `OPS_ALERT_EMAILS` in `.env` (comma-separated). If that isn't set, they go to `BALANCE_ALERT_EMAILS`, then to carajnikant@gmail.com.

| Alert | Sent by | When |
|---|---|---|
| App down / back up | `healthcheck.js` (cron) | 2 failed checks in a row (about 10 minutes), then again on recovery |
| Disk nearly full | `healthcheck.js` (cron) | Disk with `uploads/` is over 85% full (`DISK_ALERT_PERCENT`), at most once a day |
| Backup failed | `backup-db.sh` (cron) | Any backup error |
| Server crashed | the app | Uncaught error; pm2 restarts the app |
| Error spike | the app | `ERROR_ALERT_THRESHOLD` (default 10) server errors within 10 minutes |

## 6. Outside monitor (recommended)

The health check runs on the same server, so it can't report a full server outage. Add an external uptime monitor, such as UptimeRobot or Better Stack, that checks `https://testtrack.aiextensive.com/health` every 5 minutes and emails the same people.

## 7. Logs

```bash
pm2 install pm2-logrotate      # keeps pm2 logs from filling the disk
pm2 logs mom-tool-test --lines 200
tail -50 /var/log/aix-backup.log /var/log/aix-health.log
```

## 8. Uploads failing on mobile ("Connection lost — checking whether your MOC finished…")

The user's screen is not where the failure is. That message comes from the browser's
recovery path after the request to the server was cut off; the progress text next to it
("Generating minute with AI…") runs on a timer and does not reflect real server progress.

Check the Nginx access log first — it names the cause in one column:

```bash
grep "upload/chunk" /var/log/nginx/access.log | tail -40
```

| Status | Cause | Fix |
|--------|-------|-----|
| `408` | Phone stalled mid-part; Nginx `client_body_timeout` (default **60s**) expired | `bash ops/nginx-apply.sh <domain>` |
| `413` | Part larger than `client_max_body_size` | same |
| `504` | Processing took longer than `proxy_read_timeout` | same |
| `499` | User closed the tab or locked the screen | expected; the retry in the app handles it |
| `200` then nothing | Upload finished; look at `pm2 logs` for the processing stage | — |

`[server-error] POST /api/upload/chunk Error: Request aborted` in the pm2 error log is the
*symptom* of all of the above — it only says the body stopped arriving, not why.

Confirm the proxy settings are actually applied to the domain in question:

```bash
grep -E "client_max_body_size|client_body_timeout|proxy_request_buffering|proxy_read_timeout" \
  $(grep -l "<domain>" /etc/nginx/sites-enabled/* /etc/nginx/conf.d/*.conf | head -1)
```

Nginx defaults (`client_body_timeout 60s`, `proxy_read_timeout 60s`) are far too short for
long recordings. Run `ops/nginx-apply.sh` against **every** domain, live included — it is
easy to apply it to test only and leave live on the defaults.

## 9. Orphaned upload chunks

Failed uploads leave part files behind. Check the size and clear parts older than 2 days:

```bash
du -sh /root/mom-tool/uploads/
find /root/mom-tool/uploads/chunks/ -mindepth 1 -maxdepth 1 -type d -mtime +2 -print   # review
find /root/mom-tool/uploads/chunks/ -mindepth 1 -maxdepth 1 -type d -mtime +2 -exec rm -rf {} + 
```

## 10. Server map

| | Live | Test |
|---|---|---|
| Domain | `track.aiextensive.com` | `test.track.aiextensive.com` |
| Nginx file | `/etc/nginx/sites-enabled/track` (a real file, not a symlink) | `/etc/nginx/sites-available/aix-track-test` |
| App folder | `/root/mom-tool` | `/root/mom-tool-test` |
| pm2 process | `mom-tool` | `mom-tool-test` |
| Port | 3000 | 3002 |

The live `track` file holds two server blocks: the first is `listen 443 ssl` with
`proxy_pass http://localhost:3000` — upload and timeout settings belong **there**. The
second is only the port-80 redirect.

Two things to keep in mind when running `nginx-apply.sh`:

- Nginx includes `/etc/nginx/sites-enabled/*` with no extension filter, so **nothing but
  live config may sit in that directory**. A `.bak` left there is parsed as a second config
  and produces "conflicting server name" warnings. Backups now go to `/var/backups/nginx-aix/`.
- Check the `Matched:` line in the script output before trusting a run. `track.aiextensive.com`
  and `test.track.aiextensive.com` are easy to confuse.

Both `aix-track-test` and `testtrack.aiextensive.com` are symlinked into `sites-enabled`.
Worth consolidating to one test config.

## 11. Deploying to live

Run `deploy-live.ps1` from the project folder on your PC (right-click → Run with PowerShell,
type `LIVE`, enter the root password once). It sends only `server.js`, `public/index.html`
and `ops/`, then `ops/deploy-live.sh` on the server:

1. stops if `package.json` / `package-lock.json` differ from live (it never runs npm install on live)
2. waits up to 60s for in-flight requests to finish, and stops if a MOC is still processing
3. backs up the database (`ops/backup-db.sh`) and stops if that fails
4. backs up the current code to `/var/backups/aix/code/`
5. copies the files in and restarts `mom-tool`
6. checks `/health`; if the app is not healthy within 30s it restores the old code and restarts

Always deploy the same code to test first with `deploy-test.ps1`.

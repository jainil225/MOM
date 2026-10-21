# AiX Track — Technical Workflow (internal)

Internal reference for how AiX Track turns a meeting recording into a MOC (Minutes of Conversation), how credits are charged, how we deploy, and what we check every week. Say "MOC", not "MOM", in anything user-facing. Do not show AI vendor names in the UI. This doc is internal, so env var names are listed as they are in code.

## How to update this doc

| Item | Rule |
|---|---|
| When | Whenever a route, env var, table, credit rate, bonus or deploy step changes in code. Also on any weekly-check finding that changes the process. |
| Who | The developer making the change, in the same change set. The owner reviews. |
| Source of truth | `server.js` (routes, credits, tables), `auth.js`, `moc-quality.js`, `drive.js`, `storage.js`, `deploy-*.ps1`, `ops/*`. If this doc and code differ, code wins — fix the doc. |
| Quick check | `grep -nE "app\.(get\|post\|patch\|delete)\(" server.js` and compare with the route tables below. |
| Change log | Add one line at the bottom: date, who, what changed. |

---

## 1. End-to-end flow

```
Sign-up / login ──► Upload or record ──► Transcription (+ diarization) ──► Meeting brief
   ──► MOC generation ──► Quality gates ──► Save (mom_sessions) ──► Edit / regenerate / rediarize
   ──► Export (Word / PDF / client view / share link / email) ──► Google Drive offload
Credits are checked before processing and charged after; every movement goes to credits_log.
```

### 1.1 Sign-up and login

| Step | Route | Notes |
|---|---|---|
| Google login | `GET /auth/google` → `GET /auth/google/callback` | Env: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_CALLBACK_URL`. A consent cookie is set before redirect. |
| Email OTP | `POST /auth/otp/request` → `POST /auth/otp/verify` | OTPs stored in `auth_otps`. Mail via `SMTP_*` / `GMAIL_*`. |
| Session | `GET /api/me`, `GET /auth/me`, `POST /auth/logout` | `SESSION_SECRET`, `JWT_SECRET`. |
| Consent | `/consent`, `GET /api/consent/status`, `POST /api/consent/reconsent`, `POST /api/consent/recording`, `POST /api/consent/withdraw` | Tables `consent_log`, `consent_records`. |
| New user | (in signup code, `server.js` ~line 775) | Row in `users`; `JOINING_BONUS_CREDITS` granted once and logged as "Joining bonus". |

Note: `auth.js` also defines `/auth/google`, `/auth/otp/*`, `/auth/me`, `/auth/logout`. Verify in code which copy is actually mounted before changing login logic.

### 1.2 Referral

| Step | Route / setting | Notes |
|---|---|---|
| Invite link | `GET /r/:code` | Sets cookie `aix_ref` (30 days, httpOnly), redirects to `/login.html?invited=1` (or `/` if logged in). |
| Friend signs up | signup code | Friend gets `REFERRAL_FRIEND_BONUS` (default 30), logged "Referral welcome bonus". |
| Friend's first MOC | after first MOC saved | Referrer gets `REFERRAL_REWARD_CREDITS` (default 86), logged "Referral reward — <friend> created their first MOC". |
| User's link and earnings | `GET /api/referral` | Also returns the bonus values. |

### 1.3 Upload or record

| Path | Routes |
|---|---|
| File upload (chunked) | `POST /api/upload/chunk` → `POST /api/upload/complete` |
| Direct transcribe | `POST /api/transcribe` (multipart) |
| In-browser recording | `POST /api/recordings/start` → `POST /api/recordings/:id/chunk` → `POST /api/recordings/:id/status`; file at `GET /api/recordings/:id/file`. Table `recording_uploads`. |
| Draft recording | `POST /api/draft-recording` |
| Pre-checks | `GET /api/credits/preflight`, `GET /api/credits/recording-allowance`, `GET /api/config/rates` |

Upload limits and Nginx timeouts: see `ops/README.md` and `ops/nginx-apply.sh`. Max length: `MAX_AUDIO_HOURS`.

### 1.4 Transcription and diarization

- Speech-to-text provider keys: `SARVAM_API_KEY`; diarization: `SARVAM_DIARIZATION_KEY`, `SARVAM_DIARIZATION_MODEL`. Per-user key can be set by admin (`/api/admin/users/:email/sarvam-key`).
- Long files may go to batch mode: `BATCH_TRANSCRIPTION`, `BATCH_TRANSCRIPTION_MIN_SEC`.
- Silence trimming: `SILENCE_REMOVAL`, `SILENCE_THRESHOLD_DB`, `SILENCE_MIN_PAUSE_SEC`.
- Cost tracking: `SARVAM_INR_PER_MIN`, `SARVAM_DIAR_INR_PER_MIN` → `api_usage_log`.

### 1.5 Meeting brief and MOC generation

1. A first LLM call reads the transcript plus the active master prompt and writes a **meeting brief** tailored to this meeting (topics, detail level, correct names). Topic scan model: `TOPIC_SCAN_MODEL`. Key: `OPENAI_API_KEY`.
2. A second LLM call receives master prompt + brief + transcript and writes the **MOC** JSON. Key: `ANTHROPIC_API_KEY`; settings `MOC_EFFORT`, `COMPOSER_TOKEN_BUDGET`.
3. Master prompts live in `master_prompts` (admin: `/api/admin/master-prompt*`). Each run is logged in `moc_prompt_log` (`/api/admin/prompt-log`). User-level prompt view: `GET /api/user/full-prompt`.

### 1.6 Quality gates (`moc-quality.js`)

`applyQualityGates(mom, transcript)` runs on the generated MOC before save. It checks items against the transcript (quote matching), removes near-duplicates and normalises decision lines. Version is `GATE_VERSION`. Test with `node ops/test-moc-quality.js`. Exact gate rules: verify in code.

### 1.7 Save, edit, regenerate, rediarize

| Action | Route |
|---|---|
| List / open / delete | `GET /api/history`, `GET /api/history/:id`, `DELETE /api/history/:id` |
| Edit MOC | `PATCH /api/history/:id` |
| Tags / project | `PATCH /api/history/:id/tags`, `PATCH /api/history/:id/project`, `/api/projects*` (table `projects`) |
| Action items | `PATCH /api/history/:id/action/:idx`, `.../email`, `POST .../send` |
| Regenerate MOC | `POST /api/history/:id/regenerate` (charged at `CREDITS_PER_MIN_REGENERATE`) |
| Rediarize | `POST /api/history/:id/rediarize` |
| Audio file | `GET /api/history/:id/file` |

Main table: `mom_sessions`.

### 1.8 Exports and sharing

| Output | Route |
|---|---|
| Word (full MOC) | `GET /api/history/:id/export/docx` |
| Word (client MOC) | `GET /api/history/:id/export/docx?view=client` — agenda business, confirmed decisions and agreed actions only |
| PDF | Browser print from the UI (no server PDF route found — verify in code) |
| Share link | `POST /api/history/:id/share`, `DELETE ...share`, `GET /api/share/:token`, page `/s/:token` |
| Email | `POST /api/history/:id/send-email`, `POST /api/history/:id/draft-email` |

### 1.9 Storage and Google Drive offload

- Object storage (`storage.js`): S3 / R2 via `S3_BUCKET`, `AWS_*`, or `R2_*`.
- Google Drive (`drive.js`): user connects at `GET /auth/drive` → `/auth/drive/callback`. Then `GET /api/drive/status`, `POST /api/drive/enabled`, `POST /api/drive/sync`, `POST /api/drive/disconnect`.
- Env: `DRIVE_STORAGE`, `DRIVE_FOLDER_NAME`, `DRIVE_SWEEP_MINUTES`, `GOOGLE_DRIVE_CLIENT_ID`, `GOOGLE_DRIVE_CLIENT_SECRET`, `GOOGLE_DRIVE_CALLBACK_URL`. A periodic sweep offloads files to Drive (interval `DRIVE_SWEEP_MINUTES`).
- Admin view: `GET /api/admin/storage`.

---

## 2. Credits

| Setting | Env var / constant | Default |
|---|---|---|
| Standard rate (credits per min) | `CREDITS_PER_MIN_STANDARD` | 1 |
| Diarization rate | `CREDITS_PER_MIN_DIARIZATION` | 2 |
| Regenerate rate | `CREDITS_PER_MIN_REGENERATE` | 0.5 |
| Free trial | `FREE_TIER_MINUTES` (constant) × standard rate | 60 min = 60 credits |
| Joining bonus | `JOINING_BONUS_CREDITS` | 86 |
| Referral — friend | `REFERRAL_FRIEND_BONUS` | 30 |
| Referral — referrer (on friend's first MOC) | `REFERRAL_REWARD_CREDITS` | 86 |
| Unlimited users | `UNLIMITED_CREDIT_EMAILS` | — |

How a charge works (`computeCharge` in `server.js`):
- Free-trial pool is used first; diarization uses it twice as fast.
- Remaining minutes are rounded up and charged at the rate; privileged users are not charged.
- `checkCanStart` blocks only when free trial is used up and balance is 0.

Low-credit display: **below 20 = red**, **below 50 = amber**, else green (applies to paid and free-trial balances). Below 20 the UI calls `POST /api/credits/low-credit-alert`.

Buying credits: `POST /api/credits/create-order` → `POST /api/credits/verify-payment`; webhook `POST /api/razorpay/webhook` (`RAZORPAY_*`). Tables `credit_orders`, `razorpay_webhook_events`.

Logs:
| Table | What it holds |
|---|---|
| `credits_log` | Every credit movement (bonus, charge, purchase, admin change) with balance after |
| `api_usage_log` | Provider usage and cost per session |
| `provider_balances` | Provider account balances; alerts below `PROVIDER_BALANCE_THRESHOLD_INR` / `_USD` to `BALANCE_ALERT_EMAILS` |

User/admin views: `GET /api/credits/balance`, `GET /api/free-tier/status`, `GET /api/usage/me`, `/credits`, `/usage`, `/cost`, `/api/admin/usage*`, `/api/admin/cost-intelligence`, `PATCH /api/admin/users/:email/credits`.

---

## 3. Deploy

| Target | Script | pm2 process | Port |
|---|---|---|---|
| **Test (normal path)** | `deploy-test.ps1` | `mom-tool-test` | 3002 |
| Live | `deploy-live.ps1` / `deploy-prod.ps1` / `ops/deploy-live.sh` | `mom-tool` | 3000 (track.aiextensive.com) |

Rules:
1. Always deploy to **test** first with `deploy-test.ps1`. It skips `node_modules`, `uploads`, `.env`, `.git`, runs `npm install` only if packages changed, restarts only `mom-tool-test`, and prints logs. Look for `[db] Tables ready`.
2. **Live deploy only with explicit owner approval.** `ops/deploy-live.sh` backs up DB and code, checks `/health`, and rolls back if unhealthy.
3. **Never run `pm2 restart all`.** Restart only the named process.
4. `.env` is never uploaded — change it on the server by hand.

---

## 4. Weekly maintenance checklist

Copy this list into the week's notes and tick as you go.

**Providers**
- [ ] Check transcription account balance (Sarvam) and LLM account balances (OpenAI, Anthropic) — admin `/api/admin/provider-balances` (use Refresh).
- [ ] Top up any account near the alert threshold.

**Credit log sanity** (`credits_log`, `users`)
- [ ] No users with negative balance: `SELECT email, credits FROM users WHERE credits < 0;`
- [ ] No duplicate charges for the same session (same user, same amount, same reason, seconds apart).
- [ ] Joining bonus / referral bonuses not granted twice to the same user.
- [ ] Razorpay orders paid = credits added (`credit_orders` vs `credits_log`).

**Sessions**
- [ ] Find failed or stuck sessions in `mom_sessions` / `recording_uploads` (still processing after 1 hour). Check pm2 logs for the cause; refund credits if charged without a MOC.

**Test-site smoke test (mom-tool-test)**
- [ ] Log in (OTP or Google).
- [ ] Upload a short audio file.
- [ ] Generate a MOC; check quality looks right.
- [ ] Export Word (full and `?view=client`).

**Backups**
- [ ] Confirm `ops/backup-db.sh` ran (dumps in `/var/backups/aix/<app>`, 14 days kept). Run by hand if needed: `bash ops/backup-db.sh /root/mom-tool-test`.
- [ ] Keep a safe offline copy of each server `.env`.

**Storage**
- [ ] Drive offload working: `/api/admin/storage`, no growing `uploads/` on the server.

**Code**
- [ ] `git status` clean; `git push client main` (remote `client`).

**Server**
- [ ] Disk space: `df -h`.
- [ ] `pm2 status` — check restart counts; `pm2 logs mom-tool-test --lines 200` and live logs for errors. pm2-logrotate installed.
- [ ] `GET /health` returns OK on test and live.

---

## Change log

| Date | Who | Change |
|---|---|---|
| 2026-10-21 | Dev | First version. |

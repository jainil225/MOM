// ═══════════════════════════════════════════════════════════════════
  //  MOM GENERATOR — server.js (v3)
  //  New: Live mic recording · 30-min limit · Attendee name tagging ·
  //       Tasks-by-person view · Auto language detect · Free tier ·
  //       Tags & Categories · Custom prompt per user · OpenAI key save
  // ═══════════════════════════════════════════════════════════════════

  require('dotenv').config();

  const express        = require('express');
  const multer         = require('multer');
  const path           = require('path');
  const fs             = require('fs');
  const { execSync }   = require('child_process');
  const axios          = require('axios');
  const FormData       = require('form-data');
  const Anthropic      = require('@anthropic-ai/sdk');
  const { Pool }       = require('pg');
  const session        = require('express-session');
  const passport       = require('passport');
  const GoogleStrategy = require('passport-google-oauth20').Strategy;
  const nodemailer     = require('nodemailer');

  const app  = express();
  const PORT = process.env.PORT || 3000;

  // ─── FFmpeg ──────────────────────────────────────────────────────────────────
  const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;

  // ─── Anthropic client ────────────────────────────────────────────────────────
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  // ─── PostgreSQL pool — Neon (DATABASE_URL) or local fallback ─────────────────
  const NEON_URL = process.env.DATABASE_URL ||
    'postgresql://neondb_owner:npg_VBbtpMP0dY4K@ep-rapid-flower-ammnsym7-pooler.c-5.us-east-1.aws.neon.tech/neondb?sslmode=require';

  const pool = new Pool({
    connectionString:        NEON_URL,
    ssl:                     { rejectUnauthorized: false },
    max:                     10,
    idleTimeoutMillis:       30000,
    connectionTimeoutMillis: 5000,
  });

  // ─── In-memory OTP store ─────────────────────────────────────────────────────
  const otpStore = new Map();

  // ─── Dev mode (no SMTP configured) ──────────────────────────────────────────
  const DEV_MODE = !process.env.SMTP_HOST;

  // ════════════════════════════════════════════════════════════════════════════
  //  MIDDLEWARE
  // ════════════════════════════════════════════════════════════════════════════

  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  // ── Trust Render/Heroku reverse proxy so secure cookies work over HTTPS ───────
  app.set('trust proxy', 1);

  // ── Session — 30 days rolling (fixes logout bug) ──────────────────────────────
  app.use(session({
    secret:            process.env.SESSION_SECRET || 'mom-generator-change-in-prod',
    resave:            true,           // re-save on every request → keeps session alive
    rolling:           true,           // reset cookie expiry on every request
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure:   process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge:   30 * 24 * 60 * 60 * 1000   // 30 days always (no more 1-day default)
    }
  }));

  app.use(passport.initialize());
  app.use(passport.session());
  app.use(express.static(path.join(__dirname, 'public')));

  // ════════════════════════════════════════════════════════════════════════════
  //  DATABASE — init tables + migrations
  // ════════════════════════════════════════════════════════════════════════════

  async function initDB() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id          SERIAL PRIMARY KEY,
        email       TEXT UNIQUE NOT NULL,
        name        TEXT,
        avatar      TEXT,
        google_id   TEXT,
        created_at  TIMESTAMPTZ DEFAULT NOW(),
        last_login  TIMESTAMPTZ
      )
    `);

    // Safe migrations — add columns if they don't exist
    const userCols = [
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar TEXT`,
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS google_id TEXT`,
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS openai_api_key TEXT`,
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS custom_prompt TEXT`,
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS custom_prompt_openai TEXT`,
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS ai_provider TEXT DEFAULT 'claude'`,
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS free_files_used INTEGER DEFAULT 0`,
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS free_minutes_used NUMERIC DEFAULT 0`,
    ];
    for (const q of userCols) await pool.query(q);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS mom_sessions (
        id                SERIAL PRIMARY KEY,
        user_email        TEXT,
        file_name         TEXT,
        file_size         BIGINT,
        file_type         TEXT,
        duration_seconds  NUMERIC,
        transcript        TEXT,
        meeting_title     TEXT,
        meeting_date      TEXT,
        meeting_time      TEXT,
        attendees         JSONB DEFAULT '[]',
        agenda            JSONB DEFAULT '[]',
        discussion_points JSONB DEFAULT '[]',
        decisions         JSONB DEFAULT '[]',
        action_items      JSONB DEFAULT '[]',
        next_meeting      TEXT,
        summary           TEXT,
        language          TEXT DEFAULT 'en',
        created_at        TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // mom_sessions migrations
    const sessionCols = [
      `ALTER TABLE mom_sessions ADD COLUMN IF NOT EXISTS tags TEXT DEFAULT ''`,
      `ALTER TABLE mom_sessions ADD COLUMN IF NOT EXISTS category TEXT DEFAULT ''`,
      `ALTER TABLE mom_sessions ADD COLUMN IF NOT EXISTS detected_language TEXT DEFAULT ''`,
      `ALTER TABLE mom_sessions ADD COLUMN IF NOT EXISTS languages_detected JSONB DEFAULT '[]'`,
      `ALTER TABLE mom_sessions ADD COLUMN IF NOT EXISTS action_items_done JSONB DEFAULT '{}'`,
    ];
    for (const q of sessionCols) await pool.query(q);

    console.log('[db] Tables ready');
  }

  // ════════════════════════════════════════════════════════════════════════════
  //  AUTH HELPERS
  // ════════════════════════════════════════════════════════════════════════════

  async function findOrCreateUser(email, name = null, googleId = null, avatar = null) {
    const existing = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    if (existing.rows.length > 0) {
      await pool.query('UPDATE users SET last_login = NOW() WHERE email = $1', [email]);
      return existing.rows[0];
    }
    const result = await pool.query(
      'INSERT INTO users (email, name, google_id, avatar) VALUES ($1, $2, $3, $4) RETURNING *',
      [email, name, googleId, avatar]
    );
    return result.rows[0];
  }

  function requireAuth(req, res, next) {
    if (req.session?.user) return next();
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Not authenticated' });
    res.redirect('/login.html');
  }

  // ════════════════════════════════════════════════════════════════════════════
  //  GOOGLE OAUTH
  // ════════════════════════════════════════════════════════════════════════════

  if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
    passport.use(new GoogleStrategy({
      clientID:     process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      callbackURL:  process.env.GOOGLE_CALLBACK_URL || `http://localhost:${PORT}/auth/google/callback`
    }, async (accessToken, refreshToken, profile, done) => {
      try {
        const email  = profile.emails[0].value;
        const name   = profile.displayName;
        const avatar = profile.photos?.[0]?.value || null;
        const user   = await findOrCreateUser(email, name, profile.id, avatar);
        return done(null, user);
      } catch (err) { return done(err); }
    }));

    passport.serializeUser((user, done) => done(null, user.email));
    passport.deserializeUser(async (email, done) => {
      try {
        const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
        done(null, result.rows[0] || null);
      } catch (err) { done(err); }
    });

    app.get('/auth/google', passport.authenticate('google', { scope: ['profile', 'email'] }));

    app.get('/auth/google/callback',
      passport.authenticate('google', { failureRedirect: '/login.html?error=google' }),
      async (req, res) => {
        req.session.user = { email: req.user.email, id: req.user.id, name: req.user.name };
        req.session.cookie.maxAge = 30 * 24 * 60 * 60 * 1000;
        await req.session.save();
        res.redirect('/');
      }
    );
  } else {
    app.get('/auth/google', (req, res) =>
      res.redirect('/login.html?error=google_not_configured')
    );
    console.warn('[auth] Google OAuth not configured');
  }

  // ════════════════════════════════════════════════════════════════════════════
  //  EMAIL OTP AUTH
  // ════════════════════════════════════════════════════════════════════════════

  let transporter;
  if (!DEV_MODE) {
    transporter = nodemailer.createTransport({
      host:   process.env.SMTP_HOST,
      port:   parseInt(process.env.SMTP_PORT || '587'),
      secure: process.env.SMTP_PORT === '465',
      family: 4,   // force IPv4 — Render IPv6 → Gmail times out
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
      tls:  { rejectUnauthorized: false }
    });
  }

  function generateOTP() { return String(Math.floor(100000 + Math.random() * 900000)); }

  async function sendOTPEmail(email, otp) {
    if (DEV_MODE) {
      console.log(`\n  ╔══════════════════════════════╗`);
      console.log(`  ║  DEV OTP for ${email}`);
      console.log(`  ║  Code: ${otp}`);
      console.log(`  ╚══════════════════════════════╝\n`);
      return;
    }
    await transporter.sendMail({
      from:    process.env.SMTP_FROM || `"Minute." <${process.env.SMTP_USER}>`,
      to:      email,
      subject: `Your login code: ${otp}`,
      html: `
        <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
                    max-width:480px;margin:auto;padding:32px 24px;background:#fff">
          <div style="margin-bottom:24px">
            <span style="font-size:28px">📋</span>
            <strong style="font-size:18px;color:#0D1526;margin-left:8px">Minute.</strong>
          </div>
          <h2 style="color:#0D1526;font-size:22px;margin-bottom:8px">Your login code</h2>
          <p style="color:#4B5875;font-size:15px;margin-bottom:24px">
            Use this 6-digit code to sign in. It expires in <strong>10 minutes</strong>.
          </p>
          <div style="background:#F0F4FF;border-radius:14px;padding:24px;text-align:center;margin-bottom:24px">
            <span style="font-size:40px;font-weight:700;letter-spacing:14px;
                        color:#2563EB;font-family:'Courier New',monospace">${otp}</span>
          </div>
          <p style="color:#9BA5BE;font-size:12px">If you did not request this code, you can safely ignore this email.</p>
        </div>
      `
    });
  }

  app.post('/auth/otp/request', async (req, res) => {
    const { email } = req.body;
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      return res.status(400).json({ error: 'Enter a valid email address.' });

    const existing = otpStore.get(email);
    if (existing && Date.now() < existing.expiresAt - 9 * 60 * 1000)
      return res.status(429).json({ error: 'Please wait 1 minute before requesting another code.' });

    const otp = generateOTP();
    otpStore.set(email, { otp, expiresAt: Date.now() + 10 * 60 * 1000, attempts: 0 });

    try {
      await sendOTPEmail(email, otp);
      const response = { success: true };
      if (DEV_MODE) response.dev_otp = otp;
      res.json(response);
    } catch (err) {
      console.error('[otp] Email send failed:', err.message);
      otpStore.delete(email);
      res.status(500).json({ error: 'Failed to send email. Check SMTP settings in .env' });
    }
  });

  app.post('/auth/otp/verify', async (req, res) => {
    const { email, otp, remember } = req.body;
    const record = otpStore.get(email);
    if (!record) return res.status(400).json({ error: 'No active code found. Request a new one.' });
    if (Date.now() > record.expiresAt) {
      otpStore.delete(email);
      return res.status(400).json({ error: 'Code expired. Request a new one.' });
    }
    if (record.attempts >= 5) {
      otpStore.delete(email);
      return res.status(400).json({ error: 'Too many attempts. Request a new code.' });
    }
    record.attempts++;
    if (record.otp !== String(otp).trim())
      return res.status(400).json({ error: 'Incorrect code. Try again.' });

    otpStore.delete(email);
    const user = await findOrCreateUser(email);
    req.session.user = { email: user.email, id: user.id, name: user.name };
    // Always 30 days (remember by default — rolling sessions keep this alive)
    req.session.cookie.maxAge = 30 * 24 * 60 * 60 * 1000;
    await req.session.save();
    res.json({ success: true });
  });

  app.post('/auth/logout', (req, res) => {
    req.session.destroy(() => {
      res.clearCookie('connect.sid');
      res.json({ success: true });
    });
  });

  app.get('/auth/me', (req, res) => {
    if (req.session?.user) return res.json({ user: req.session.user });
    res.status(401).json({ error: 'Not authenticated' });
  });

  // ════════════════════════════════════════════════════════════════════════════
  //  MULTER
  // ════════════════════════════════════════════════════════════════════════════

  const ALLOWED_AUDIO_MIME = [
    'audio/mpeg', 'audio/mp4', 'audio/wav', 'audio/x-wav',
    'audio/m4a',  'audio/x-m4a', 'audio/ogg', 'audio/webm',
    'audio/aac',  'audio/flac',  'audio/aacp', 'audio/x-aac'
  ];
  const ALLOWED_VIDEO_MIME = [
    'video/mp4', 'video/quicktime', 'video/x-msvideo',
    'video/webm', 'video/x-matroska', 'video/mpeg', 'video/3gpp'
  ];
  const ALLOWED_EXTS = ['.mp3','.mp4','.wav','.m4a','.ogg','.webm','.aac','.flac','.mov','.avi','.mkv','.3gp'];
  const VIDEO_EXTS   = ['.mp4','.mov','.avi','.mkv','.webm','.3gp','.mpeg'];

  const multerStorage = multer.diskStorage({
    destination: (req, file, cb) => {
      const dir = path.join(__dirname, 'uploads');
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, file, cb) => {
      const unique = Date.now() + '_' + Math.random().toString(36).slice(2, 8);
      cb(null, unique + path.extname(file.originalname).toLowerCase());
    }
  });

  const upload = multer({
    storage: multerStorage,
    limits: { fileSize: 2048 * 1024 * 1024 },  // 2 GB — handles long video recordings
    fileFilter: (req, file, cb) => {
      const mime = file.mimetype.toLowerCase();
      const ext  = path.extname(file.originalname).toLowerCase();
      const ok   = ALLOWED_AUDIO_MIME.includes(mime) || ALLOWED_VIDEO_MIME.includes(mime) || ALLOWED_EXTS.includes(ext);
      if (!ok) return cb(new Error(`Unsupported file type: ${file.mimetype}`));
      cb(null, true);
    }
  });

  // ════════════════════════════════════════════════════════════════════════════
  //  FFMPEG HELPERS
  // ════════════════════════════════════════════════════════════════════════════

  async function extractAudioFromVideo(inputPath) {
    const ext = path.extname(inputPath).toLowerCase();
    if (!VIDEO_EXTS.includes(ext)) return inputPath;
    const audioPath = inputPath + '_audio.wav';
    console.log(`[video] Extracting audio from ${path.basename(inputPath)}…`);
    execSync(
      `"${ffmpegPath}" -y -i "${inputPath}" -vn -acodec pcm_s16le -ar 16000 -ac 1 "${audioPath}"`,
      { stdio: 'pipe' }
    );
    try { fs.unlinkSync(inputPath); } catch (_) {}
    return audioPath;
  }

  async function convertToWav(inputPath) {
    const ext = path.extname(inputPath).toLowerCase();
    if (ext === '.wav') return inputPath;
    const wavPath = inputPath + '.wav';
    console.log(`[ffmpeg] Converting ${path.extname(inputPath)} → WAV…`);
    execSync(
      `"${ffmpegPath}" -y -i "${inputPath}" -acodec pcm_s16le -ar 16000 -ac 1 "${wavPath}"`,
      { stdio: 'pipe' }
    );
    try { fs.unlinkSync(inputPath); } catch (_) {}
    return wavPath;
  }

  function getWavDuration(wavPath) {
    const buf = Buffer.alloc(44);
    const fd  = fs.openSync(wavPath, 'r');
    fs.readSync(fd, buf, 0, 44, 0);
    fs.closeSync(fd);
    const byteRate  = buf.readUInt32LE(28);
    const fileSize  = fs.statSync(wavPath).size;
    const dataBytes = fileSize - 44;
    return byteRate > 0 ? dataBytes / byteRate : 0;
  }

  async function chunkWavFile(wavPath, chunkSec = 25) {
    const totalDuration = getWavDuration(wavPath);
    const chunksDir     = wavPath + '_chunks';
    if (!fs.existsSync(chunksDir)) fs.mkdirSync(chunksDir);

    if (totalDuration <= chunkSec) {
      const single = path.join(chunksDir, 'chunk_000.wav');
      fs.copyFileSync(wavPath, single);
      console.log(`[chunk] Single chunk (${totalDuration.toFixed(1)}s)`);
      return [single];
    }

    const numChunks = Math.ceil(totalDuration / chunkSec);
    const chunks    = [];
    console.log(`[chunk] ${totalDuration.toFixed(1)}s → ${numChunks} chunks of ≤${chunkSec}s`);

    for (let i = 0; i < numChunks; i++) {
      const start     = i * chunkSec;
      const chunkPath = path.join(chunksDir, `chunk_${String(i).padStart(3, '0')}.wav`);
      execSync(
        `"${ffmpegPath}" -y -i "${wavPath}" -ss ${start} -t ${chunkSec} ` +
        `-acodec pcm_s16le -ar 16000 -ac 1 "${chunkPath}"`,
        { stdio: 'pipe' }
      );
      chunks.push(chunkPath);
    }
    return chunks;
  }

  // ════════════════════════════════════════════════════════════════════════════
  //  LANGUAGE AUTO-DETECTION (from transcript Unicode ranges)
  // ════════════════════════════════════════════════════════════════════════════

  function detectLangFromText(text) {
    if (!text || text.trim().length < 5) return 'hi';
    const counts = { hi: 0, ta: 0, te: 0, kn: 0, ml: 0, gu: 0, pa: 0, bn: 0 };
    for (const ch of text) {
      const cp = ch.codePointAt(0);
      if (cp >= 0x0900 && cp <= 0x097F) counts.hi++;   // Devanagari (Hindi / Marathi)
      else if (cp >= 0x0B80 && cp <= 0x0BFF) counts.ta++;  // Tamil
      else if (cp >= 0x0C00 && cp <= 0x0C7F) counts.te++;  // Telugu
      else if (cp >= 0x0C80 && cp <= 0x0CFF) counts.kn++;  // Kannada
      else if (cp >= 0x0D00 && cp <= 0x0D7F) counts.ml++;  // Malayalam
      else if (cp >= 0x0A80 && cp <= 0x0AFF) counts.gu++;  // Gujarati
      else if (cp >= 0x0A00 && cp <= 0x0A7F) counts.pa++;  // Punjabi/Gurmukhi
      else if (cp >= 0x0980 && cp <= 0x09FF) counts.bn++;  // Bengali
    }
    const total    = text.length;
    const nonAscii = Object.values(counts).reduce((a, b) => a + b, 0);
    if (nonAscii < total * 0.08) return 'en';  // Mostly ASCII → English
    const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    return sorted[0]?.[0] || 'hi';
  }

  // Maps detected ISO code → Sarvam BCP-47
  const LANG_TO_SARVAM = {
    auto:         'unknown',  // Let Sarvam detect per chunk
    multilingual: 'unknown',  // Per-chunk auto-detect; track all languages found
    en:   'en-IN',
    hi:   'hi-IN',
    mr:   'mr-IN',
    te:   'te-IN',
    ta:   'ta-IN',
    kn:   'kn-IN',
    gu:   'gu-IN',
    bn:   'bn-IN',
    pa:   'pa-IN',
    ml:   'ml-IN',
    hinglish: 'hi-IN',
    unknown:  'unknown',
    mixed:    'unknown',
  };

  // Sarvam BCP-47 → ISO short code (for reverse mapping from API response)
  const SARVAM_TO_ISO = {
    'en-IN': 'en', 'hi-IN': 'hi', 'mr-IN': 'mr', 'te-IN': 'te',
    'ta-IN': 'ta', 'kn-IN': 'kn', 'gu-IN': 'gu', 'bn-IN': 'bn',
    'pa-IN': 'pa', 'ml-IN': 'ml',
  };

  // ════════════════════════════════════════════════════════════════════════════
  //  MEETING CONTEXT — fetch previous MOMs to give AI running memory
  // ════════════════════════════════════════════════════════════════════════════

  const CONTEXT_SESSIONS = 3;  // how many previous MOMs to load as context

  function safeArr(v){ if(!v) return []; if(Array.isArray(v)) return v; try{ const p=JSON.parse(v); return Array.isArray(p)?p:[]; }catch{ return []; } }
  function safeObj(v){ if(!v) return {}; if(typeof v==='object'&&!Array.isArray(v)) return v; try{ return JSON.parse(v)||{}; }catch{ return {}; } }

  async function buildMeetingContext(userEmail) {
    try {
      const result = await pool.query(`
        SELECT meeting_title, meeting_date, attendees,
               decisions, action_items, action_items_done, summary
        FROM   mom_sessions
        WHERE  user_email = $1
        ORDER  BY created_at DESC
        LIMIT  $2
      `, [userEmail, CONTEXT_SESSIONS]);

      if (!result.rows.length) return { contextStr: null, count: 0 };

      const rows = result.rows;
      let ctx = '';
      ctx += `\n\n${'═'.repeat(60)}\n`;
      ctx += `CONTEXT FROM YOUR ${rows.length} MOST RECENT MEETING${rows.length > 1 ? 'S' : ''}\n`;
      ctx += `${'═'.repeat(60)}\n`;
      ctx += `Instructions for using this context:\n`;
      ctx += `  1. Keep ALL attendee name spellings IDENTICAL to how they appear in these previous MOMs.\n`;
      ctx += `  2. If an open action item from a previous meeting is mentioned as resolved in this transcript, note it.\n`;
      ctx += `  3. If a topic recurs, you may reference the previous meeting by name (e.g. "as discussed in [title]").\n`;
      ctx += `  4. Do NOT copy old decisions or actions into this MOM unless explicitly re-discussed in today's transcript.\n\n`;

      rows.forEach((mom, i) => {
        const att    = safeArr(mom.attendees);
        const dec    = safeArr(mom.decisions);
        const ai     = safeArr(mom.action_items);
        const done   = safeObj(mom.action_items_done);
        const open   = ai.filter((_, j) => !done[String(j)]);
        const closed = ai.filter((_, j) =>  !!done[String(j)]);

        ctx += `┌─ Meeting ${i + 1}: "${mom.meeting_title || 'Untitled'}"  (${mom.meeting_date || 'date not recorded'})\n`;
        if (att.length)    ctx += `│  Attendees     : ${att.join(' · ')}\n`;
        if (dec.length)    ctx += `│  Decisions     : ${dec.slice(0, 4).map(d => `"${d}"`).join('  |  ')}\n`;
        if (open.length)   ctx += `│  Open actions  : ${open.slice(0, 5).map(a => `${a.task} [${a.owner}]`).join('  |  ')}\n`;
        if (closed.length) ctx += `│  Done actions  : ${closed.slice(0, 3).map(a => `✓ ${a.task}`).join('  |  ')}\n`;
        if (mom.summary)   ctx += `│  Summary       : ${mom.summary.slice(0, 300)}${mom.summary.length > 300 ? '…' : ''}\n`;
        ctx += `└${'─'.repeat(58)}\n\n`;
      });

      ctx += `${'═'.repeat(60)}\n`;
      ctx += `NOW PROCESS THE NEW TRANSCRIPT BELOW:\n`;
      ctx += `${'═'.repeat(60)}\n`;

      console.log(`[context] Built context from ${rows.length} previous meeting(s) for ${userEmail}`);
      return { contextStr: ctx, count: rows.length };
    } catch (err) {
      console.error('[context] Failed to build context:', err.message);
      return { contextStr: null, count: 0 };
    }
  }

  // ════════════════════════════════════════════════════════════════════════════
  //  SARVAM AI — transcribe one WAV chunk
  // ════════════════════════════════════════════════════════════════════════════

  async function transcribeChunk(chunkPath, sarvamLangCode = 'hi-IN') {
    const fileBuffer = fs.readFileSync(chunkPath);
    const form       = new FormData();
    form.append('file', fileBuffer, { filename: path.basename(chunkPath), contentType: 'audio/wav' });
    form.append('model', 'saarika:v2.5');
    if (sarvamLangCode && sarvamLangCode !== 'unknown') {
      form.append('language_code', sarvamLangCode);
    }
    // Omitting language_code → Sarvam auto-detects (used for auto / multilingual modes)

    const response = await axios.post(
      'https://api.sarvam.ai/speech-to-text',
      form,
      {
        headers: { ...form.getHeaders(), 'api-subscription-key': process.env.SARVAM_API_KEY },
        timeout: 60000
      }
    );
    const data = response.data;
    // Return both transcript and Sarvam's detected language (available when auto-detect was used)
    const sarvamDetected = data.language_code || null;
    const isoDetected    = sarvamDetected ? (SARVAM_TO_ISO[sarvamDetected] || sarvamDetected.split('-')[0]) : null;
    return {
      transcript:   data.transcript   || '',
      detectedLang: isoDetected        || null,
    };
  }

  // ════════════════════════════════════════════════════════════════════════════
  //  SHARED MOM JSON SCHEMA (used by both Claude and OpenAI prompts)
  // ════════════════════════════════════════════════════════════════════════════

  const MOM_SYSTEM_ROLE = `You are a professional Corporate Secretary and Minute Taker with 15+ years of experience in Indian boardrooms, management committees, and client meetings. You produce precise, formal Minutes of Meeting documents in English. You are fluent in understanding transcripts across all major Indian languages — Hindi, Gujarati, Marathi, Tamil, Telugu, Kannada, Malayalam, Bengali, Punjabi — and in multilingual meetings where speakers freely switch between languages (e.g. Hindi + Gujarati, Hinglish + Marathi). You always translate content accurately into English in the final MOM.

CRITICAL — NAME CONSISTENCY: Indian names are frequently transcribed inconsistently by speech-to-text engines due to pronunciation variation (e.g. "Jainil" vs "Jenil", "Rahul" vs "Rahool", "Priya" vs "Priyaa", "Mehta" vs "Mehtha"). You MUST scan the entire transcript, identify when the same person is referred to by slightly different spellings, and use ONE consistent spelling throughout every field — attendees list, action_items owner, discussion_points, decisions. Pick the most complete or formal-looking spelling. If unsure, prefer the longer version.`;

  const MOM_JSON_SCHEMA = `Return ONLY a valid JSON object — no markdown, no backticks, no preamble. Use exactly these fields:
  {
    "meeting_title": "Clear, descriptive title based on the discussed topics",
    "meeting_date": "DD/MM/YYYY — infer from transcript if mentioned, else empty string",
    "meeting_time": "HH:MM in 24-hr format — infer if mentioned, else empty string",
    "location": "Physical venue or platform (Zoom, Teams, Google Meet, etc.) if mentioned, else empty string",
    "attendees": ["Full Name - Designation / Organisation"],
    "agenda": ["Agenda item 1", "Agenda item 2"],
    "discussion_points": [
      { "topic": "Topic heading", "details": "Detailed discussion summary in 2-4 sentences" }
    ],
    "decisions": ["Decision 1 as a complete, unambiguous sentence"],
    "action_items": [
      { "task": "Clear, specific task description", "owner": "Person or team responsible", "due_date": "DD/MM/YYYY or TBD", "priority": "High / Medium / Low" }
    ],
    "next_meeting": "Date, time, platform/venue — or empty string if not discussed",
    "summary": "2-3 sentence executive summary of overall meeting purpose, key outcomes, and next steps",
    "language": "Primary or dominant language — one of: en / hi / mr / te / ta / kn / gu / bn / pa / ml / mixed",
    "languages_detected": ["List every language actually spoken in the meeting, e.g. ['hi','gu'] or ['en','hi']"],
    "confidentiality": "Confidential / Internal / General — based on topics discussed",
    "suggested_tags": ["5 to 10 tags — MUST include each attendee's short name or first name as a tag, plus project names, companies, topic areas, quarter, platform"]
  }

  Guidelines:
  - Be precise and professional; avoid generic filler phrases
  - Capture EVERY decision and action item exactly as discussed
  - Indian context: names may include Mr., Ms., Dr., CA, CS, CFO, CTO etc.
  - NAME DEDUPLICATION: Before writing any output, mentally list all unique persons mentioned. Merge variants (e.g. Jainil/Jenil → Jainil, Rahul/Rahool → Rahul). Use the chosen canonical name everywhere — attendees, action item owners, discussion points. Never list the same person twice under different spellings.
  - MULTILINGUAL TRANSCRIPTS: If the transcript contains multiple languages (e.g. a speaker says something in Gujarati then another responds in Hindi), write the ENTIRE MOM in formal English. Translate all spoken content accurately — do not leave untranslated phrases in the output. Preserve only proper nouns (names, company names, city names, brand names) as originally spoken.
  - Set "language" to "mixed" and populate "languages_detected" with all languages you identify in the transcript
  - If a field cannot be determined, return empty string or empty array — do not invent details
  - Action item priority: High = committed deadline, Medium = discussed but flexible, Low = background task
  - Confidentiality: Confidential if financials/legal/HR discussed, Internal for ops/strategy, General otherwise
  - suggested_tags: 5-10 tags — ALWAYS add each attendee's first name or short name (e.g. "Rahul", "Priya-CA", "Mehta") as individual tags, then add project names, company names, topic areas (GST/Finance/HR/Audit/Sales/Legal), quarter (Q1-2025), and platform`;

  // ════════════════════════════════════════════════════════════════════════════
  //  CLAUDE — generate structured MOM from transcript
  // ════════════════════════════════════════════════════════════════════════════

  // ── Claude MOM generation ────────────────────────────────────────────────────
  async function generateMOMClaude(transcript, fileName, customPrompt = null, contextStr = null) {
    const extra   = customPrompt ? `\n\nADDITIONAL INSTRUCTIONS FROM USER:\n${customPrompt}` : '';
    const ctxBlock = contextStr ? contextStr : '';
    const prompt = `${MOM_SYSTEM_ROLE}
${ctxBlock}
Analyse the following meeting transcript and produce a complete, formal Minutes of Meeting (MOM) document.

FILE: ${fileName}

TRANSCRIPT:
${transcript}

${MOM_JSON_SCHEMA}${extra}`;

    const response = await anthropic.messages.create({
      model:      'claude-sonnet-4-6',
      max_tokens: 4096,
      messages: [{ role: 'user', content: prompt }]
    });

    const text  = response.content[0].text.trim();
    const clean = text.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
    try {
      return JSON.parse(clean);
    } catch (err) {
      console.error('[claude] JSON parse failed:', err.message);
      throw new Error('Claude returned malformed JSON. Please try again.');
    }
  }

  // ── OpenAI GPT-4o MOM generation ─────────────────────────────────────────────
  async function generateMOMOpenAI(transcript, fileName, openaiApiKey, customPrompt = null, contextStr = null) {
    const extra       = customPrompt ? `\n\nADDITIONAL INSTRUCTIONS FROM USER:\n${customPrompt}` : '';
    const ctxBlock    = contextStr ? contextStr : '';
    // Context goes into the system message so GPT-4o treats it as background knowledge
    const systemMsg   = MOM_SYSTEM_ROLE + (ctxBlock ? `\n${ctxBlock}` : '');

    const userMessage = `Analyse the following meeting transcript and produce a complete, formal Minutes of Meeting (MOM) document.

FILE: ${fileName}

TRANSCRIPT:
${transcript}

${MOM_JSON_SCHEMA}${extra}`;

    const response = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model:           'gpt-4o',
        temperature:     0.2,
        max_tokens:      4096,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: systemMsg },
          { role: 'user',   content: userMessage }
        ]
      },
      {
        headers: { 'Authorization': `Bearer ${openaiApiKey}`, 'Content-Type': 'application/json' },
        timeout: 120000
      }
    );

    const content = response.data.choices[0].message.content;
    try {
      return JSON.parse(content);
    } catch (err) {
      console.error('[openai] JSON parse failed:', err.message);
      throw new Error('OpenAI returned malformed JSON. Please try again.');
    }
  }

  // ── Provider router — picks Claude or OpenAI based on user settings ──────────
  async function generateMOM(transcript, fileName, user, contextStr = null) {
    const provider     = user?.ai_provider || 'claude';
    const openaiKey    = process.env.OPENAI_API_KEY;   // from .env — shared key
    const claudePrompt = user?.custom_prompt       || null;
    const openaiPrompt = user?.custom_prompt_openai || null;

    if (provider === 'openai' && openaiKey) {
      console.log('[mom] Provider: OpenAI GPT-4o (env key)');
      return generateMOMOpenAI(transcript, fileName, openaiKey, openaiPrompt, contextStr);
    }

    if (provider === 'openai' && !openaiKey) {
      console.warn('[mom] OpenAI selected but OPENAI_API_KEY not set in .env — falling back to Claude');
    }
    console.log('[mom] Provider: Claude claude-sonnet-4-6 (with context)');
    return generateMOMClaude(transcript, fileName, claudePrompt, contextStr);
  }

  // ════════════════════════════════════════════════════════════════════════════
  //  USER SETTINGS — OpenAI key, custom prompt
  // ════════════════════════════════════════════════════════════════════════════

  // GET /api/user/settings
  app.get('/api/user/settings', requireAuth, async (req, res) => {
    try {
      const result = await pool.query(
        `SELECT custom_prompt, custom_prompt_openai,
                ai_provider, free_files_used, free_minutes_used
        FROM users WHERE email = $1`,
        [req.session.user.email]
      );
      const u = result.rows[0] || {};
      res.json({
        has_openai_key:       !!process.env.OPENAI_API_KEY,  // from .env
        custom_prompt:        u.custom_prompt        || '',
        custom_prompt_openai: u.custom_prompt_openai || '',
        ai_provider:          u.ai_provider          || 'claude',
        free_files_used:      u.free_files_used      || 0,
        free_minutes_used:    parseFloat(u.free_minutes_used || 0),
        free_files_limit:     1,
        free_minutes_limit:   parseInt(process.env.FREE_MINUTES_LIMIT || '30') * 60
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/user/settings
  app.post('/api/user/settings', requireAuth, async (req, res) => {
    try {
      const { custom_prompt, custom_prompt_openai, ai_provider } = req.body;
      const validProviders = ['claude', 'openai'];
      const provider = validProviders.includes(ai_provider) ? ai_provider : 'claude';

      // If OpenAI selected but key not in .env, fall back to claude
      const effectiveProvider = (provider === 'openai' && !process.env.OPENAI_API_KEY)
        ? 'claude' : provider;

      await pool.query(
        `UPDATE users SET
          custom_prompt         = $1,
          custom_prompt_openai  = $2,
          ai_provider           = $3
        WHERE email = $4`,
        [
          custom_prompt        || null,
          custom_prompt_openai || null,
          effectiveProvider,
          req.session.user.email
        ]
      );
      res.json({
        success:    true,
        ai_provider: effectiveProvider,
        openai_available: !!process.env.OPENAI_API_KEY
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ════════════════════════════════════════════════════════════════════════════
  //  PROMPT PREVIEW — returns the exact prompt Claude will receive
  //  Replaces [TRANSCRIPT] with a placeholder so the user can read the structure
  // ════════════════════════════════════════════════════════════════════════════

  function buildFullPrompt(customPrompt = null, provider = 'claude') {
    const label   = provider === 'openai' ? '[SYSTEM MESSAGE]\n' + MOM_SYSTEM_ROLE + '\n\n[USER MESSAGE]\n' : MOM_SYSTEM_ROLE + '\n\n';
    const extra   = customPrompt ? `\n\nADDITIONAL INSTRUCTIONS FROM USER:\n${customPrompt}` : '';
    const _ = extra; // used below

    const providerNote = provider === 'openai'
      ? `\n\n━━━ SENT AS: OpenAI GPT-4o (gpt-4o) ━━━\nSystem message → role instructions\nUser message → transcript + schema + your custom instructions\nresponse_format: json_object (guaranteed valid JSON)`
      : `\n\n━━━ SENT AS: Anthropic Claude (claude-sonnet-4-6) ━━━\nSingle user message containing role + transcript + schema + your custom instructions`;

    const base = `${MOM_SYSTEM_ROLE}

  Analyse the following meeting transcript and produce a complete, formal Minutes of Meeting (MOM) document.

  FILE: [recording file name]

  TRANSCRIPT:
  [Full audio transcript inserted here — every spoken word from the meeting]

  ${MOM_JSON_SCHEMA}${extra}`;

    return base + providerNote;
  }

  // GET /api/user/full-prompt — returns the exact prompt this user's provider will receive
  app.get('/api/user/full-prompt', requireAuth, async (req, res) => {
    try {
      const result = await pool.query(
        'SELECT custom_prompt, custom_prompt_openai, ai_provider FROM users WHERE email = $1',
        [req.session.user.email]
      );
      const u          = result.rows[0] || {};
      const provider   = u.ai_provider || 'claude';
      const activePrompt = provider === 'openai'
        ? (u.custom_prompt_openai || null)
        : (u.custom_prompt       || null);

      const fullPrompt = buildFullPrompt(activePrompt, provider);

      res.json({
        provider,
        has_openai_key:       !!process.env.OPENAI_API_KEY,
        active_custom_prompt: activePrompt || '',
        custom_prompt_claude: u.custom_prompt        || '',
        custom_prompt_openai: u.custom_prompt_openai || '',
        full_prompt:          fullPrompt,
        effective_model:      provider === 'openai' && process.env.OPENAI_API_KEY ? 'gpt-4o' : 'claude-sonnet-4-6'
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ════════════════════════════════════════════════════════════════════════════
  //  API — POST /api/transcribe  (main pipeline)
  // ════════════════════════════════════════════════════════════════════════════

  app.post('/api/transcribe', requireAuth, upload.any(), async (req, res) => {
    const file = req.files?.[0];
    if (!file) return res.status(400).json({ error: 'No file uploaded.' });

    const originalName  = file.originalname;
    const fileSizeBytes = file.size;
    const fileType      = path.extname(originalName).toLowerCase().replace('.', '');
    const langInput     = req.body.language || 'auto';   // 'auto' triggers detection
    const tags          = req.body.tags     || '';
    const category      = req.body.category || '';

    let workingPath = file.path;
    let wavPath     = null;
    let chunksDir   = null;

    console.log(`\n[transcribe] ── START ───────────────────────────────`);
    console.log(`[transcribe] File : ${originalName}`);
    console.log(`[transcribe] Size : ${(fileSizeBytes / 1024 / 1024).toFixed(2)} MB`);
    console.log(`[transcribe] Lang : ${langInput}`);

    try {
      // ── Fetch user (for free tier + custom prompt) ────────────────
      const userResult = await pool.query('SELECT * FROM users WHERE email = $1', [req.session.user.email]);
      const user       = userResult.rows[0];
      const filesUsed  = user?.free_files_used || 0;

      // ── Free tier check ───────────────────────────────────────────
      const FREE_FILES = 1;
      if (filesUsed >= FREE_FILES) {
        return res.status(402).json({
          error: 'Your free recording has been used. Contact us to upgrade.',
          free_tier_exhausted: true,
          upgrade_needed: true
        });
      }

      // ── Step 1: Extract audio from video (if needed) ──────────────
      workingPath = await extractAudioFromVideo(workingPath);

      // ── Step 2: Convert to 16kHz mono WAV ────────────────────────
      wavPath = await convertToWav(workingPath);

      // ── Step 3: Calculate duration ───────────────────────────────
      const durationSeconds = getWavDuration(wavPath);
      console.log(`[transcribe] Duration: ${durationSeconds.toFixed(1)}s`);

      // ── Free tier duration check (30 min max) ────────────────────
      const FREE_MINUTES = parseInt(process.env.FREE_MINUTES_LIMIT || '30');
      const FREE_SECONDS = FREE_MINUTES * 60;
      if (durationSeconds > FREE_SECONDS) {
        return res.status(402).json({
          error: `File exceeds the ${FREE_MINUTES}-minute free limit (this file: ${Math.ceil(durationSeconds/60)} min). Contact us to upgrade.`,
          free_tier_exhausted: true
        });
      }

      // ── Step 4: Chunk into ≤25-second segments ────────────────────
      const chunks = await chunkWavFile(wavPath);
      chunksDir    = chunks.length > 0 ? path.dirname(chunks[0]) : null;

      // ── Step 5: Transcribe each chunk ─────────────────────────────
      const isMultilingual  = langInput === 'multilingual';
      const isAutoDetect    = langInput === 'auto' || langInput === 'unknown' || isMultilingual;
      const sarvamCode      = isAutoDetect ? 'unknown' : (LANG_TO_SARVAM[langInput] || 'hi-IN');

      let fullTranscript   = '';
      let detectedLanguage = langInput;
      const langPerChunk   = [];   // tracks ISO code per chunk for multilingual

      for (let i = 0; i < chunks.length; i++) {
        console.log(`[sarvam] Chunk ${i + 1}/${chunks.length}…`);
        const result = await transcribeChunk(chunks[i], sarvamCode);
        fullTranscript += (fullTranscript ? ' ' : '') + result.transcript;

        // Language detection per chunk
        if (isAutoDetect && result.transcript.trim().length > 10) {
          // Prefer Sarvam's own detected language; fall back to Unicode heuristic
          const chunkLang = result.detectedLang || detectLangFromText(result.transcript);

          if (isMultilingual) {
            langPerChunk.push(chunkLang);
            console.log(`[lang] Chunk ${i+1} → ${chunkLang}`);
          } else if (i === 0) {
            detectedLanguage = chunkLang;
            console.log(`[lang] Auto-detected: ${detectedLanguage}`);
          }
        }
      }

      // Multilingual: resolve final language label
      if (isMultilingual && langPerChunk.length > 0) {
        const uniqueLangs = [...new Set(langPerChunk)];
        detectedLanguage  = uniqueLangs.length > 1 ? 'mixed' : uniqueLangs[0];
        console.log(`[lang] Multilingual result: [${uniqueLangs.join(', ')}] → ${detectedLanguage}`);
      }

      console.log(`[sarvam] Transcript: ${fullTranscript.length} chars`);

      if (!fullTranscript.trim()) {
        return res.status(422).json({ error: 'No speech detected in the file. Check the audio quality.' });
      }

      // ── Step 6: Build context from previous meetings ─────────────
      const { contextStr, count: contextCount } = await buildMeetingContext(req.session.user.email);

      // ── Step 6.1: Annotate transcript (multilingual hint + lang note) ──
      const langHint = isMultilingual
        ? `\n[NOTE: This is a MULTILINGUAL recording. Languages detected: ${[...new Set(langPerChunk)].join(', ')}. Translate all content to English in the MOM.]\n`
        : '';
      const annotatedTranscript = langHint + fullTranscript;

      console.log(`[mom] Generating MOM via ${user?.ai_provider === 'openai' && process.env.OPENAI_API_KEY ? 'OpenAI GPT-4o' : 'Claude'} | context: ${contextCount} previous meetings…`);
      const mom = await generateMOM(annotatedTranscript, originalName, user, contextStr);

      // Stamp detected language on MOM
      if (isAutoDetect && detectedLanguage && detectedLanguage !== 'auto' && detectedLanguage !== 'multilingual') {
        mom.language = mom.language || detectedLanguage;
      }
      if (isMultilingual) {
        mom.language           = mom.language || detectedLanguage;
        mom.languages_detected = mom.languages_detected || [...new Set(langPerChunk)];
      }

      // ── Merge auto-tags with user tags ────────────────────────────
      // Claude's suggested_tags + any manually entered tags, deduplicated
      const autoTags  = (mom.suggested_tags || []).map(t => t.trim()).filter(Boolean);
      const userTags  = tags.split(',').map(t => t.trim()).filter(Boolean);
      const mergedTags = [...new Set([...userTags, ...autoTags])].slice(0, 10);
      const finalTags  = mergedTags.join(',');
      console.log(`[tags] Auto: [${autoTags.join(', ')}]  User: [${userTags.join(', ')}]  Merged: [${mergedTags.join(', ')}]`);

      // ── Step 7: Save to DB ────────────────────────────────────────
      const langsDetectedArr = mom.languages_detected || (isMultilingual ? [...new Set(langPerChunk)] : []);

      const dbResult = await pool.query(`
        INSERT INTO mom_sessions
          (user_email, file_name, file_size, file_type, duration_seconds,
          transcript, meeting_title, meeting_date, meeting_time,
          attendees, agenda, discussion_points, decisions, action_items,
          next_meeting, summary, language, tags, category, detected_language, languages_detected)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
        RETURNING id, created_at
      `, [
        req.session.user.email,
        originalName, fileSizeBytes, fileType, durationSeconds,
        fullTranscript,
        mom.meeting_title  || '',
        mom.meeting_date   || '',
        mom.meeting_time   || '',
        JSON.stringify(mom.attendees         || []),
        JSON.stringify(mom.agenda            || []),
        JSON.stringify(mom.discussion_points || []),
        JSON.stringify(mom.decisions         || []),
        JSON.stringify(mom.action_items      || []),
        mom.next_meeting   || '',
        mom.summary        || '',
        mom.language       || 'en',
        finalTags,
        category,
        detectedLanguage,
        JSON.stringify(langsDetectedArr)
      ]);

      const saved = dbResult.rows[0];
      console.log(`[db] Saved as session #${saved.id}`);

      // ── Step 8: Increment free tier usage ─────────────────────────
      await pool.query(
        'UPDATE users SET free_files_used = free_files_used + 1, free_minutes_used = free_minutes_used + $1 WHERE email = $2',
        [durationSeconds, req.session.user.email]
      );

      console.log(`[transcribe] ── DONE ────────────────────────────────\n`);

      res.json({
        success:               true,
        session_id:            saved.id,
        created_at:            saved.created_at,
        transcript:            fullTranscript,
        duration:              durationSeconds,
        detected_language:     detectedLanguage,
        languages_detected:    langsDetectedArr,
        is_multilingual:       isMultilingual,
        context_sessions_used: contextCount,
        suggested_tags:        autoTags,
        merged_tags:           mergedTags,
        mom
      });

    } catch (err) {
      console.error('[transcribe error]', err.message);
      const status  = err.response?.status;
      let msg = err.response?.data?.message || err.message || 'Transcription failed.';
      if (status === 402) msg = 'Transcription service has no credits. Please top up your Sarvam account.';
      res.status(500).json({ error: msg });

    } finally {
      [workingPath, wavPath].forEach(p => {
        try { if (p && fs.existsSync(p)) fs.unlinkSync(p); } catch (_) {}
      });
      if (chunksDir && fs.existsSync(chunksDir)) {
        try {
          fs.readdirSync(chunksDir).forEach(f => fs.unlinkSync(path.join(chunksDir, f)));
          fs.rmdirSync(chunksDir);
        } catch (_) {}
      }
    }
  });

  // ════════════════════════════════════════════════════════════════════════════
  //  API — PATCH tags/category on a session
  // ════════════════════════════════════════════════════════════════════════════

  app.patch('/api/history/:id/tags', requireAuth, async (req, res) => {
    try {
      const { tags, category } = req.body;
      const result = await pool.query(
        'UPDATE mom_sessions SET tags = $1, category = $2 WHERE id = $3 AND user_email = $4 RETURNING id',
        [tags || '', category || '', req.params.id, req.session.user.email]
      );
      if (!result.rows.length) return res.status(404).json({ error: 'Session not found.' });
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ════════════════════════════════════════════════════════════════════════════
  //  API — PATCH action item done state (persistent checkbox save)
  // ════════════════════════════════════════════════════════════════════════════

  app.patch('/api/history/:id/action/:idx', requireAuth, async (req, res) => {
    try {
      const momId = parseInt(req.params.id);
      const idx   = String(parseInt(req.params.idx));   // normalise to "0","1","2"…
      const done  = !!req.body.done;

      // Verify ownership + fetch current done map
      const check = await pool.query(
        'SELECT id, action_items_done FROM mom_sessions WHERE id = $1 AND user_email = $2',
        [momId, req.session.user.email]
      );
      if (!check.rows.length) return res.status(404).json({ error: 'Session not found.' });

      const current = check.rows[0].action_items_done || {};
      if (done) { current[idx] = true; }
      else       { delete current[idx]; }

      await pool.query(
        'UPDATE mom_sessions SET action_items_done = $1 WHERE id = $2 AND user_email = $3',
        [JSON.stringify(current), momId, req.session.user.email]
      );

      console.log(`[task] MOM #${momId} item ${idx} → ${done ? 'done' : 'undone'}`);
      res.json({ success: true, done, idx: Number(idx), action_items_done: current });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ════════════════════════════════════════════════════════════════════════════
  //  API — MOM HISTORY
  // ════════════════════════════════════════════════════════════════════════════

  app.get('/api/history', requireAuth, async (req, res) => {
    const { search, limit = 50, offset = 0 } = req.query;
    try {
      let query, params;
      if (search) {
        query = `
          SELECT id, file_name, meeting_title, meeting_date, meeting_time,
                attendees, action_items, action_items_done,
                summary, language, duration_seconds, created_at, tags, category, detected_language
          FROM mom_sessions
          WHERE user_email = $1
            AND (meeting_title ILIKE $2 OR file_name ILIKE $2 OR summary ILIKE $2
                OR transcript ILIKE $2 OR tags ILIKE $2 OR category ILIKE $2)
          ORDER BY created_at DESC LIMIT $3 OFFSET $4`;
        params = [req.session.user.email, `%${search}%`, limit, offset];
      } else {
        query = `
          SELECT id, file_name, meeting_title, meeting_date, meeting_time,
                attendees, action_items, action_items_done,
                summary, language, duration_seconds, created_at, tags, category, detected_language
          FROM mom_sessions WHERE user_email = $1
          ORDER BY created_at DESC LIMIT $2 OFFSET $3`;
        params = [req.session.user.email, limit, offset];
      }
      const result = await pool.query(query, params);
      res.json({ sessions: result.rows });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/history/:id', requireAuth, async (req, res) => {
    try {
      const result = await pool.query(
        'SELECT * FROM mom_sessions WHERE id = $1 AND user_email = $2',
        [req.params.id, req.session.user.email]
      );
      if (!result.rows.length) return res.status(404).json({ error: 'Session not found.' });
      res.json(result.rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.delete('/api/history/:id', requireAuth, async (req, res) => {
    try {
      const result = await pool.query(
        'DELETE FROM mom_sessions WHERE id = $1 AND user_email = $2 RETURNING id',
        [req.params.id, req.session.user.email]
      );
      if (!result.rows.length) return res.status(404).json({ error: 'Session not found.' });
      res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ════════════════════════════════════════════════════════════════════════════
  //  API — USER
  // ════════════════════════════════════════════════════════════════════════════

  app.get('/api/user/me', requireAuth, async (req, res) => {
    try {
      const result = await pool.query(
        'SELECT email, name, avatar, free_files_used, free_minutes_used, created_at FROM users WHERE email = $1',
        [req.session.user.email]
      );
      if (!result.rows.length) return res.status(404).json({ error: 'User not found.' });
      res.json(result.rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ════════════════════════════════════════════════════════════════════════════
  //  PAGE ROUTES
  // ════════════════════════════════════════════════════════════════════════════

  app.get('/',       requireAuth, (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
  app.get('/history',requireAuth, (req, res) => res.sendFile(path.join(__dirname, 'public', 'history.html')));
  app.get('/login.html', (req, res) => {
    if (req.session?.user) return res.redirect('/');
    res.sendFile(path.join(__dirname, 'public', 'login.html'));
  });

  // ════════════════════════════════════════════════════════════════════════════
  //  ADMIN — Reset free tier for a user
  //  POST /admin/reset-credits  { email, secret }
  //  Protected by ADMIN_SECRET in .env — never exposed to frontend
  // ════════════════════════════════════════════════════════════════════════════

  app.post('/admin/reset-credits', async (req, res) => {
    const { email, secret } = req.body;
    const adminSecret = process.env.ADMIN_SECRET;

    if (!adminSecret || secret !== adminSecret) {
      return res.status(403).json({ error: 'Forbidden.' });
    }
    if (!email) return res.status(400).json({ error: 'email required.' });

    try {
      const result = await pool.query(
        `UPDATE users
         SET free_files_used = 0, free_minutes_used = 0
         WHERE email = $1
         RETURNING email, free_files_used, free_minutes_used`,
        [email]
      );
      if (!result.rows.length) return res.status(404).json({ error: `No user found: ${email}` });
      console.log(`[admin] Credits reset for ${email}`);
      res.json({ success: true, user: result.rows[0] });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ════════════════════════════════════════════════════════════════════════════
  //  HEALTH CHECK
  // ════════════════════════════════════════════════════════════════════════════

  app.get('/health', (req, res) => {
    res.json({
      status:        'ok',
      time:          new Date().toISOString(),
      ffmpeg:        !!ffmpegPath,
      sarvam_key:    !!process.env.SARVAM_API_KEY,
      anthropic_key: !!process.env.ANTHROPIC_API_KEY,
      openai_key:    !!process.env.OPENAI_API_KEY,
      google_oauth:  !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET),
      smtp:          !DEV_MODE,
      dev_mode:      DEV_MODE,
    });
  });

  // ════════════════════════════════════════════════════════════════════════════
  //  MULTER ERROR HANDLER
  // ════════════════════════════════════════════════════════════════════════════

  app.use((err, req, res, next) => {
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ error: 'File too large. Maximum size is 2 GB.' });
      return res.status(400).json({ error: err.message });
    }
    if (err?.message?.startsWith('Unsupported file type'))
      return res.status(400).json({ error: err.message });
    next(err);
  });

  // ════════════════════════════════════════════════════════════════════════════
  //  START
  // ════════════════════════════════════════════════════════════════════════════

  initDB()
    .then(() => {
      app.listen(PORT, () => {
        console.log(`\n  ✅  Minute. → http://localhost:${PORT}`);
        console.log(`      FFmpeg     : ${ffmpegPath ? 'ready' : '❌ NOT FOUND'}`);
        console.log(`      Sarvam AI  : ${process.env.SARVAM_API_KEY    ? '✓ key set' : '⚠️  SARVAM_API_KEY not set'}`);
        console.log(`      Anthropic  : ${process.env.ANTHROPIC_API_KEY ? '✓ key set' : '⚠️  ANTHROPIC_API_KEY not set'}`);
        console.log(`      OpenAI     : ${process.env.OPENAI_API_KEY    ? '✓ key set' : '— not configured (ChatGPT provider unavailable)'}`);
        console.log(`      Google     : ${process.env.GOOGLE_CLIENT_ID  ? '✓ configured' : '— not configured'}`);
        console.log(`      SMTP       : ${DEV_MODE ? '⚠️  DEV MODE — OTP logged to console' : '✓ configured'}`);
        console.log(`      DB         : postgres://${process.env.DB_HOST || 'localhost'}:${process.env.DB_PORT || '5432'}/${process.env.DB_NAME || 'postgres'}`);
        console.log(`      Sessions   : 30-day rolling (auto-logout fix active)`);
        console.log('');
      });
    })
    .catch(err => { console.error('❌  DB init failed:', err.message); process.exit(1); });
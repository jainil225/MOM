// db.js — MOC Tool PostgreSQL integration
// Place this file in your mom-tool/ folder alongside server.js
// Run: npm install pg

const { Pool } = require("pg");

const pool = new Pool({
  host:     process.env.DB_HOST || "localhost",
  port:     Number(process.env.DB_PORT) || 5432,
  database: process.env.DB_NAME || "postgres",
  user:     process.env.DB_USER || "postgres",
  password: process.env.DB_PASSWORD,
});

// Test connection on startup
pool.query("SELECT NOW()", (err) => {
  if (err) console.error("[DB] ❌ Connection failed:", err.message);
  else     console.log("[DB] ✅ PostgreSQL connected");
});

// ── CREATE TABLE (run once on startup) ──────────────────────────────────────
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS mom_sessions (
      id                SERIAL PRIMARY KEY,
      created_at        TIMESTAMPTZ DEFAULT NOW(),

      -- File info
      file_name         TEXT,
      file_size_mb      NUMERIC(8,2),
      language_code     TEXT,

      -- Transcript
      transcript        TEXT,
      transcript_chars  INTEGER,

      -- MOC fields
      meeting_title     TEXT,
      meeting_date      TEXT,
      duration          TEXT,
      next_meeting_date TEXT,

      -- Arrays stored as JSONB
      attendees         JSONB,
      agenda            JSONB,
      key_discussions   JSONB,
      decisions         JSONB,
      action_items      JSONB,
      next_steps        JSONB,

      -- Status
      status            TEXT DEFAULT 'completed'
    );

    CREATE INDEX IF NOT EXISTS idx_mom_created_at ON mom_sessions(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_mom_title      ON mom_sessions(meeting_title);
  `);
  console.log("[DB] ✅ Tables ready");
}

// ── SAVE MOC ────────────────────────────────────────────────────────────────
async function saveMOM({ fileName, fileSizeMB, languageCode, transcript, mom }) {
  const result = await pool.query(
    `INSERT INTO mom_sessions (
        file_name, file_size_mb, language_code,
        transcript, transcript_chars,
        meeting_title, meeting_date, duration, next_meeting_date,
        attendees, agenda, key_discussions, decisions, action_items, next_steps
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
     RETURNING id, created_at`,
    [
      fileName,
      fileSizeMB,
      languageCode,
      transcript,
      transcript?.length || 0,
      mom.meetingTitle,
      mom.date,
      mom.duration,
      mom.nextMeetingDate,
      JSON.stringify(mom.attendees      || []),
      JSON.stringify(mom.agenda         || []),
      JSON.stringify(mom.keyDiscussions || []),
      JSON.stringify(mom.decisions      || []),
      JSON.stringify(mom.actionItems    || []),
      JSON.stringify(mom.nextSteps      || []),
    ]
  );
  console.log(`[DB] ✅ Saved MOC id=${result.rows[0].id}`);
  return result.rows[0];
}

// ── GET ALL MOCs (list view) ─────────────────────────────────────────────────
async function listMOMs(limit = 50) {
  const result = await pool.query(
    `SELECT id, created_at, meeting_title, meeting_date, duration,
            file_name, language_code, transcript_chars,
            attendees, next_meeting_date, status
     FROM mom_sessions
     ORDER BY created_at DESC
     LIMIT $1`,
    [limit]
  );
  return result.rows;
}

// ── GET ONE MOC (full detail) ────────────────────────────────────────────────
async function getMOM(id) {
  const result = await pool.query(
    `SELECT * FROM mom_sessions WHERE id = $1`,
    [id]
  );
  return result.rows[0] || null;
}

// ── DELETE MOC ───────────────────────────────────────────────────────────────
async function deleteMOM(id) {
  await pool.query(`DELETE FROM mom_sessions WHERE id = $1`, [id]);
  console.log(`[DB] Deleted MOC id=${id}`);
}

module.exports = { initDB, saveMOM, listMOMs, getMOM, deleteMOM };
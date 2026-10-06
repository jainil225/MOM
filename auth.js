// auth.js — Google OAuth + Email OTP authentication
const passport       = require("passport");
const GoogleStrategy = require("passport-google-oauth20").Strategy;
const jwt            = require("jsonwebtoken");
const nodemailer     = require("nodemailer");
const crypto         = require("crypto");

const JWT_SECRET = process.env.JWT_SECRET || "mom-tool-secret-change-in-production";

// ─────────────────────────────────────────
// EMAIL TRANSPORTER (Nodemailer)
// ─────────────────────────────────────────
function createMailer() {
  // Uses Gmail by default — set SMTP_* in .env for other providers
  if (process.env.SMTP_HOST) {
    return nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT || "587"),
      secure: false,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
  }
  // Gmail shortcut
  return nodemailer.createTransport({
    service: "gmail",
    auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_PASS },
  });
}

// ─────────────────────────────────────────
// JWT HELPERS
// ─────────────────────────────────────────
function signToken(user) {
  return jwt.sign(
    { id: user.id, email: user.email, name: user.name, plan: user.plan },
    JWT_SECRET,
    { expiresIn: "7d" }
  );
}

function verifyToken(token) {
  try { return jwt.verify(token, JWT_SECRET); }
  catch { return null; }
}

// Middleware — protect API routes
function requireAuth(req, res, next) {
  const token = req.cookies?.token || req.headers.authorization?.replace("Bearer ", "");
  const user  = token ? verifyToken(token) : null;
  if (!user) return res.status(401).json({ error: "Not authenticated" });
  req.user = user;
  next();
}

// ─────────────────────────────────────────
// GOOGLE OAUTH SETUP
// ─────────────────────────────────────────
function setupGoogleStrategy(pool) {
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
    console.warn("[Auth] Google OAuth not configured — set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env");
    return;
  }
  passport.use(new GoogleStrategy({
    clientID:     process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL:  process.env.GOOGLE_CALLBACK_URL || "http://localhost:3000/auth/google/callback",
  }, async (accessToken, refreshToken, profile, done) => {
    try {
      const email    = profile.emails?.[0]?.value;
      const name     = profile.displayName;
      const avatar   = profile.photos?.[0]?.value;
      const googleId = profile.id;

      // Upsert user
      const result = await pool.query(
        `INSERT INTO users (email, name, avatar_url, auth_provider, google_id, credits_remaining, plan)
         VALUES ($1,$2,$3,'google',$4, 50, 'free')
         ON CONFLICT (email) DO UPDATE
           SET name=EXCLUDED.name, avatar_url=EXCLUDED.avatar_url, google_id=EXCLUDED.google_id
         RETURNING *`,
        [email, name, avatar, googleId]
      );
      done(null, result.rows[0]);
    } catch (err) {
      done(err);
    }
  }));
}

// ─────────────────────────────────────────
// AUTH ROUTES
// ─────────────────────────────────────────
function setupAuthRoutes(app, pool) {
  const mailer = createMailer();

  // ── Google OAuth ──
  app.get("/auth/google",
    passport.authenticate("google", { scope: ["profile", "email"], session: false })
  );

  app.get("/auth/google/callback",
    passport.authenticate("google", { session: false, failureRedirect: "/login.html?error=google" }),
    (req, res) => {
      const token = signToken(req.user);
      res.cookie("token", token, { httpOnly: true, maxAge: 7 * 24 * 60 * 60 * 1000 });
      res.redirect("/");
    }
  );

  // ── Email OTP — Request ──
  app.post("/auth/otp/request", async (req, res) => {
    const { email } = req.body;
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: "Enter a valid email address." });
    }

    const otp     = crypto.randomInt(100000, 999999).toString();
    const expires = new Date(Date.now() + 10 * 60 * 1000); // 10 min

    await pool.query(
      `INSERT INTO otp_tokens (email, otp, expires_at, used) VALUES ($1,$2,$3,false)
       ON CONFLICT (email) DO UPDATE SET otp=$2, expires_at=$3, used=false`,
      [email, otp, expires]
    );

    try {
      await mailer.sendMail({
        from:    process.env.GMAIL_USER || process.env.SMTP_USER,
        to:      email,
        subject: "Your MOC Generator login code",
        html: `
          <div style="font-family:sans-serif;max-width:400px;margin:0 auto;padding:24px">
            <h2 style="font-size:20px;font-weight:600;margin-bottom:8px">Your login code</h2>
            <p style="color:#666;margin-bottom:24px">Enter this code to sign in to MOC Generator. It expires in 10 minutes.</p>
            <div style="background:#f5f6fa;border-radius:12px;padding:20px;text-align:center;margin-bottom:24px">
              <span style="font-size:36px;font-weight:700;letter-spacing:8px;color:#0f1117">${otp}</span>
            </div>
            <p style="font-size:12px;color:#999">If you didn't request this, ignore this email.</p>
          </div>`,
      });
      res.json({ ok: true, message: "OTP sent to " + email });
    } catch (mailErr) {
      console.error("[OTP] Mail failed:", mailErr.message);
      // In dev — return OTP directly so you can test without mail setup
      if (process.env.NODE_ENV !== "production") {
        return res.json({ ok: true, dev_otp: otp, message: "DEV MODE: mail not sent, use dev_otp" });
      }
      res.status(500).json({ error: "Could not send email. Check GMAIL_USER and GMAIL_PASS in .env" });
    }
  });

  // ── Email OTP — Verify ──
  app.post("/auth/otp/verify", async (req, res) => {
    const { email, otp } = req.body;
    if (!email || !otp) return res.status(400).json({ error: "Email and OTP required." });

    const row = await pool.query(
      `SELECT * FROM otp_tokens WHERE email=$1 AND used=false ORDER BY expires_at DESC LIMIT 1`,
      [email]
    );
    const record = row.rows[0];

    if (!record)                          return res.status(400).json({ error: "No OTP found for this email. Request a new one." });
    if (record.otp !== otp.trim())        return res.status(400).json({ error: "Incorrect code. Try again." });
    if (new Date() > new Date(record.expires_at)) return res.status(400).json({ error: "Code expired. Request a new one." });

    // Mark OTP used
    await pool.query(`UPDATE otp_tokens SET used=true WHERE email=$1`, [email]);

    // Upsert user
    const result = await pool.query(
      `INSERT INTO users (email, name, auth_provider, credits_remaining, plan)
       VALUES ($1, $2, 'email', 50, 'free')
       ON CONFLICT (email) DO UPDATE SET name=EXCLUDED.name
       RETURNING *`,
      [email, email.split("@")[0]]
    );
    const user  = result.rows[0];
    const token = signToken(user);
    res.cookie("token", token, { httpOnly: true, maxAge: 7 * 24 * 60 * 60 * 1000 });
    res.json({ ok: true, user: { id: user.id, email: user.email, name: user.name, plan: user.plan, credits: user.credits_remaining } });
  });

  // ── Current user ──
  app.get("/auth/me", requireAuth, async (req, res) => {
    const result = await pool.query(`SELECT id,email,name,avatar_url,plan,credits_remaining FROM users WHERE id=$1`, [req.user.id]);
    if (!result.rows[0]) return res.status(404).json({ error: "User not found" });
    res.json({ user: result.rows[0] });
  });

  // ── Logout ──
  app.post("/auth/logout", (req, res) => {
    res.clearCookie("token");
    res.json({ ok: true });
  });
}

module.exports = { setupGoogleStrategy, setupAuthRoutes, requireAuth, signToken, verifyToken };
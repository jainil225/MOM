// Send an ops alert email using the app's own SMTP settings.
// Usage: node ops/notify.js <app dir> "<subject>" "<message>"
// Recipients: OPS_ALERT_EMAILS, else BALANCE_ALERT_EMAILS, else carajanikant@gmail.com
const path = require('path');

async function sendAlert(appDir, subject, message) {
  const need = (m) => require(path.join(appDir, 'node_modules', m));
  need('dotenv').config({ path: path.join(appDir, '.env') });
  const to = (process.env.OPS_ALERT_EMAILS || process.env.BALANCE_ALERT_EMAILS || 'carajanikant@gmail.com')
    .split(',').map(s => s.trim()).filter(Boolean).join(', ');
  const line = `${new Date().toISOString()} ${subject} — ${message}`;
  if (!process.env.SMTP_HOST) { console.error('[notify] SMTP not configured:', line); return false; }
  const transporter = need('nodemailer').createTransport({
    host: process.env.SMTP_HOST, port: parseInt(process.env.SMTP_PORT) || 587,
    secure: String(process.env.SMTP_PORT) === '465',
    family: 4,   // same as the app — IPv6 to some mail hosts times out
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
  const esc = (v) => String(v).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  await transporter.sendMail({
    from: '"AiX Track" <notification@aiextensive.com>', to,
    subject: `🚨 AiX Track: ${subject}`,
    html: `<div style="font-family:Roboto,Arial,sans-serif;max-width:560px;margin:auto;padding:24px">
      <h2 style="color:#A0472E;font-size:18px;margin:0 0 6px">${esc(subject)}</h2>
      <p style="color:#666;font-size:13px">${esc(appDir)} · ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST</p>
      <pre style="white-space:pre-wrap;font-size:12px;background:#f6f4ef;padding:12px;border-radius:8px">${esc(message)}</pre></div>`,
  });
  console.log('[notify] sent:', line);
  return true;
}

module.exports = { sendAlert };

if (require.main === module) {
  const [appDir, subject, message] = process.argv.slice(2);
  if (!appDir || !subject) { console.error('Usage: node ops/notify.js <app dir> "<subject>" "<message>"'); process.exit(2); }
  sendAlert(path.resolve(appDir), subject, message || '').catch(e => { console.error('[notify] failed:', e.message); process.exit(1); });
}

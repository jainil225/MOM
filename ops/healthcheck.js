// ═══════════════════════════════════════════════════════════════════════
//  AiX Track — uptime and disk check, run by cron every 5 minutes
//  Usage: node ops/healthcheck.js /root/mom-tool-test http://127.0.0.1:3002/health
//  Emails the admins when the app is down for 2 checks in a row, again when
//  it recovers, and when the disk holding uploads is over DISK_ALERT_PERCENT
//  (default 85%). Uses the app's SMTP settings (ops/notify.js).
//  Note: this runs on the same server, so it cannot report a full server
//  outage — add an external monitor for that (see ops/README.md).
// ═══════════════════════════════════════════════════════════════════════
const fs = require('fs');
const os = require('os');
const path = require('path');
const { sendAlert } = require('./notify');

const appDir = path.resolve(process.argv[2] || path.join(os.homedir(), 'mom-tool'));
const url = process.argv[3] || 'http://127.0.0.1:3000/health';
const name = path.basename(appDir);
const stateFile = path.join(os.tmpdir(), `aix-health-${name}.json`);
const DISK_LIMIT = parseFloat(process.env.DISK_ALERT_PERCENT) || 85;

const readState = () => { try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { return { fails: 0, down: false, diskAlertAt: 0 }; } };
const writeState = (s) => fs.writeFileSync(stateFile, JSON.stringify(s));

async function checkApp() {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    const body = await r.json().catch(() => ({}));
    if (r.status !== 200 || body.database === false) return `health returned ${r.status}${body.database === false ? ' (database not reachable)' : ''}`;
    return null;
  } catch (e) {
    return e.name === 'AbortError' ? 'no answer within 15 seconds' : `cannot connect: ${e.message}`;
  } finally { clearTimeout(timer); }
}

function diskUsedPercent() {
  const dir = fs.existsSync(path.join(appDir, 'uploads')) ? path.join(appDir, 'uploads') : appDir;
  if (!fs.statfsSync) return null;                 // Node older than 18.15
  const s = fs.statfsSync(dir);
  return 100 - (s.bavail / s.blocks) * 100;
}

(async () => {
  const st = readState();
  const problem = await checkApp();
  if (problem) {
    st.fails = (st.fails || 0) + 1;
    if (st.fails >= 2 && !st.down) {
      st.down = true; st.downSince = new Date().toISOString();
      await sendAlert(appDir, `App is DOWN (${name})`, `${url}\n${problem}\n\nCheck: pm2 status, then pm2 logs ${name} --lines 100`).catch(e => console.error(e.message));
    }
  } else {
    if (st.down) await sendAlert(appDir, `App is back UP (${name})`, `${url} answered normally. It was down since ${st.downSince}.`).catch(e => console.error(e.message));
    st.fails = 0; st.down = false;
  }

  const used = diskUsedPercent();
  if (used != null && used >= DISK_LIMIT && Date.now() - (st.diskAlertAt || 0) > 24 * 3600 * 1000) {
    st.diskAlertAt = Date.now();
    await sendAlert(appDir, `Disk ${used.toFixed(0)}% full (${name})`,
      `The disk holding ${appDir}/uploads is ${used.toFixed(1)}% used (alert level ${DISK_LIMIT}%).\nRecordings stop saving when the disk is full.\nCheck: du -sh ${appDir}/uploads/*`).catch(e => console.error(e.message));
  }
  writeState(st);
  console.log(`${new Date().toISOString()} ${name}: ${problem || 'ok'}${used != null ? ` · disk ${used.toFixed(0)}%` : ''}`);
})();

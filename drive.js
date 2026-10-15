// drive.js — store customer recordings in the customer's own Google Drive.
//
// Why: audio and video are by far the largest things this app keeps. When a
// customer connects their Drive, the media file moves to their storage and our
// disk only holds it for as long as transcription needs it. Nothing else about
// the MOC changes — the transcript and the MOC stay in our database.
//
// Scope is drive.file, the narrowest one Google offers: this app can only see
// and touch files it created itself. It cannot read the rest of the customer's
// Drive. That also keeps the app out of Google's restricted-scope review.
//
// No new dependency — this talks to the Drive REST API over axios, which the
// project already uses.

const axios = require('axios');
const fs    = require('fs');

const TOKEN_URL    = 'https://oauth2.googleapis.com/token';
const AUTH_URL     = 'https://accounts.google.com/o/oauth2/v2/auth';
const REVOKE_URL   = 'https://oauth2.googleapis.com/revoke';
const USERINFO_URL = 'https://www.googleapis.com/oauth2/v2/userinfo';
const FILES_URL    = 'https://www.googleapis.com/drive/v3/files';
const UPLOAD_URL   = 'https://www.googleapis.com/upload/drive/v3/files';

const SCOPES = [
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/userinfo.email',
];

// Drive connect reuses the login OAuth client unless a separate one is set.
const CLIENT_ID     = process.env.GOOGLE_DRIVE_CLIENT_ID     || process.env.GOOGLE_CLIENT_ID     || '';
const CLIENT_SECRET = process.env.GOOGLE_DRIVE_CLIENT_SECRET || process.env.GOOGLE_CLIENT_SECRET || '';
const FOLDER_NAME   = process.env.DRIVE_FOLDER_NAME || 'AiX Track Recordings';

function isConfigured() { return !!(CLIENT_ID && CLIENT_SECRET); }

function redirectUri() {
  if (process.env.GOOGLE_DRIVE_CALLBACK_URL) return process.env.GOOGLE_DRIVE_CALLBACK_URL;
  const base = (process.env.APP_URL || 'http://localhost:3000').replace(/\/+$/, '');
  return base + '/auth/drive/callback';
}

// access_type=offline plus prompt=consent is what makes Google return a refresh
// token. Without prompt=consent a returning user gets an access token only, and
// the connection would silently stop working after an hour.
function buildAuthUrl(state) {
  const p = new URLSearchParams({
    client_id:     CLIENT_ID,
    redirect_uri:  redirectUri(),
    response_type: 'code',
    scope:         SCOPES.join(' '),
    access_type:   'offline',
    prompt:        'consent',
    include_granted_scopes: 'true',
    state:         state || '',
  });
  return AUTH_URL + '?' + p.toString();
}

async function exchangeCode(code) {
  const { data } = await axios.post(TOKEN_URL, new URLSearchParams({
    code,
    client_id:     CLIENT_ID,
    client_secret: CLIENT_SECRET,
    redirect_uri:  redirectUri(),
    grant_type:    'authorization_code',
  }).toString(), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 20000 });

  let email = '';
  try {
    const me = await axios.get(USERINFO_URL, {
      headers: { Authorization: 'Bearer ' + data.access_token }, timeout: 15000,
    });
    email = me.data?.email || '';
  } catch (_) { /* the connection still works without the address */ }

  return { refreshToken: data.refresh_token || '', accessToken: data.access_token, email };
}

// Access tokens last an hour. Cache per refresh token so a batch of uploads
// does not hit Google's token endpoint once per file.
const tokenCache = new Map();

async function getAccessToken(refreshToken) {
  if (!refreshToken) throw new Error('Google Drive is not connected for this account.');
  const hit = tokenCache.get(refreshToken);
  if (hit && hit.expiresAt > Date.now() + 60000) return hit.token;

  const { data } = await axios.post(TOKEN_URL, new URLSearchParams({
    refresh_token: refreshToken,
    client_id:     CLIENT_ID,
    client_secret: CLIENT_SECRET,
    grant_type:    'refresh_token',
  }).toString(), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 20000 });

  const token = data.access_token;
  tokenCache.set(refreshToken, { token, expiresAt: Date.now() + (data.expires_in || 3600) * 1000 });
  return token;
}

function forgetToken(refreshToken) { tokenCache.delete(refreshToken); }

// A revoked or expired grant is permanent — the customer has to reconnect.
// Callers use this to clear the stored token instead of retrying forever.
function isAuthError(err) {
  const status = err?.response?.status;
  const body   = err?.response?.data;
  const reason = typeof body === 'string' ? body : (body?.error?.message || body?.error || '');
  return status === 401 || (status === 400 && /invalid_grant|unauthorized/i.test(String(reason)));
}

function driveError(err) {
  const d = err?.response?.data;
  return d?.error?.message || d?.error_description || d?.error || err.message;
}

// ── Folder the app keeps the customer's recordings in ───────────────────────
// Only folders this app created are visible under drive.file, so this finds our
// own folder or makes a new one. If the customer deletes or trashes it, the
// next upload quietly recreates it.
async function ensureFolder(accessToken, existingId) {
  if (existingId) {
    try {
      const { data } = await axios.get(FILES_URL + '/' + existingId, {
        params:  { fields: 'id,trashed' },
        headers: { Authorization: 'Bearer ' + accessToken }, timeout: 15000,
      });
      if (data && !data.trashed) return data.id;
    } catch (_) { /* gone — fall through and make a new one */ }
  }

  const safeName = FOLDER_NAME.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  const q = "mimeType='application/vnd.google-apps.folder' and name='" + safeName + "' and trashed=false";
  try {
    const { data } = await axios.get(FILES_URL, {
      params:  { q, fields: 'files(id,name)', pageSize: 1, spaces: 'drive' },
      headers: { Authorization: 'Bearer ' + accessToken }, timeout: 15000,
    });
    if (data.files?.length) return data.files[0].id;
  } catch (_) { /* fall through to create */ }

  const { data } = await axios.post(FILES_URL, {
    name: FOLDER_NAME, mimeType: 'application/vnd.google-apps.folder',
  }, {
    params:  { fields: 'id' },
    headers: { Authorization: 'Bearer ' + accessToken, 'Content-Type': 'application/json' },
    timeout: 20000,
  });
  return data.id;
}

// ── Upload ──────────────────────────────────────────────────────────────────
// Resumable upload, because a long meeting can run to hundreds of megabytes and
// a simple multipart POST is not safe at that size.
async function uploadFile({ refreshToken, folderId, filePath, name, mimeType }) {
  const accessToken = await getAccessToken(refreshToken);
  const folder      = await ensureFolder(accessToken, folderId);
  const size        = fs.statSync(filePath).size;

  const start = await axios.post(UPLOAD_URL + '?uploadType=resumable', {
    name, parents: [folder],
  }, {
    headers: {
      Authorization: 'Bearer ' + accessToken,
      'Content-Type': 'application/json; charset=UTF-8',
      'X-Upload-Content-Type':   mimeType || 'application/octet-stream',
      'X-Upload-Content-Length': String(size),
    },
    timeout: 30000,
  });

  const session = start.headers.location;
  if (!session) throw new Error('Google Drive did not start an upload session.');

  const { data } = await axios.put(session, fs.createReadStream(filePath), {
    headers: {
      'Content-Type':   mimeType || 'application/octet-stream',
      'Content-Length': String(size),
    },
    maxBodyLength:    Infinity,
    maxContentLength: Infinity,
    timeout:          0,            // large files set their own pace
  });

  return { fileId: data.id, folderId: folder, size };
}

// ── Read back ───────────────────────────────────────────────────────────────
// Returns a Node stream so the app can pipe it straight to the browser, with
// Range passed through so seeking in the player still works.
async function getFileStream({ refreshToken, fileId, range }) {
  const accessToken = await getAccessToken(refreshToken);
  const headers = { Authorization: 'Bearer ' + accessToken };
  if (range) headers.Range = range;

  const r = await axios.get(FILES_URL + '/' + fileId, {
    params: { alt: 'media' }, headers, responseType: 'stream', timeout: 0,
    validateStatus: s => s === 200 || s === 206,
  });
  return { stream: r.data, status: r.status, headers: r.headers };
}

async function getFileMeta({ refreshToken, fileId }) {
  const accessToken = await getAccessToken(refreshToken);
  const { data } = await axios.get(FILES_URL + '/' + fileId, {
    params:  { fields: 'id,name,size,mimeType,webViewLink,trashed' },
    headers: { Authorization: 'Bearer ' + accessToken }, timeout: 15000,
  });
  return data;
}

async function deleteFile({ refreshToken, fileId }) {
  if (!fileId) return;
  const accessToken = await getAccessToken(refreshToken);
  await axios.delete(FILES_URL + '/' + fileId, {
    headers: { Authorization: 'Bearer ' + accessToken }, timeout: 20000,
  });
}

// Used by "Disconnect" so the grant disappears from the customer's Google
// account too, not just from our database.
async function revoke(refreshToken) {
  forgetToken(refreshToken);
  if (!refreshToken) return;
  try {
    await axios.post(REVOKE_URL, new URLSearchParams({ token: refreshToken }).toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 15000 });
  } catch (_) { /* already revoked on Google's side — nothing to do */ }
}

module.exports = {
  isConfigured, redirectUri, buildAuthUrl, exchangeCode, getAccessToken,
  forgetToken, isAuthError, driveError, ensureFolder, uploadFile,
  getFileStream, getFileMeta, deleteFile, revoke, FOLDER_NAME, SCOPES,
};

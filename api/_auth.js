// Shared auth helpers for the serverless functions.
// Files starting with "_" in /api are not exposed as routes by Vercel.
const crypto = require('crypto');

const TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24h: one tournament day, then sign in again

// Used only when STAFF_PASSWORD is not configured in Vercel. Set STAFF_PASSWORD to override it.
const LEGACY_PASSWORD = 'sitare@2029';

function getSecret() {
  // AUTH_SECRET is preferred; the Blob token is never sent to the browser, so it is a
  // safe fallback signing key. As a last resort derive a key from the staff password so
  // login never fails just because neither variable is visible to this function.
  const configured = process.env.AUTH_SECRET || process.env.BLOB_READ_WRITE_TOKEN;
  if (configured) return configured;
  return 'cct-session-key:' + (process.env.STAFF_PASSWORD || LEGACY_PASSWORD);
}

function b64url(input) {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function hmac(data) {
  return b64url(crypto.createHmac('sha256', getSecret()).update(data).digest());
}

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function signToken({ name, role }) {
  const exp = Date.now() + TOKEN_TTL_MS;
  const body = b64url(JSON.stringify({ name, role, exp }));
  return { token: `${body}.${hmac(body)}`, exp };
}

// Returns the payload ({name, role, exp}) for a valid, unexpired token, otherwise null
function verifyToken(token) {
  if (!token || !getSecret()) return null;
  const parts = String(token).split('.');
  if (parts.length !== 2) return null;
  const [body, sig] = parts;
  if (!safeEqual(sig, hmac(body))) return null;
  try {
    const payload = JSON.parse(Buffer.from(body.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    if (!payload || !payload.exp || payload.exp < Date.now()) return null;
    if (payload.role !== 'umpire' && payload.role !== 'admin') return null;
    return payload;
  } catch (e) {
    return null;
  }
}

function getBearerToken(req) {
  const header = req.headers && (req.headers.authorization || req.headers.Authorization);
  if (!header) return null;
  const m = /^Bearer\s+(.+)$/i.exec(header);
  return m ? m[1].trim() : null;
}

module.exports = { signToken, verifyToken, getBearerToken, safeEqual, getSecret, LEGACY_PASSWORD };

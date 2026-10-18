// Staff login. Passwords live only in server environment variables:
//   STAFF_PASSWORD  - required; umpire password
//   ADMIN_PASSWORD  - optional; admin password (defaults to STAFF_PASSWORD)
//   AUTH_SECRET     - optional; token signing key (defaults to BLOB_READ_WRITE_TOKEN)
const { signToken, safeEqual, getSecret } = require('./_auth');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const staffPassword = process.env.STAFF_PASSWORD;
  const adminPassword = process.env.ADMIN_PASSWORD || staffPassword;
  if (!staffPassword || !getSecret()) {
    console.error('Auth is not configured: set STAFF_PASSWORD (and optionally ADMIN_PASSWORD / AUTH_SECRET)');
    return res.status(500).json({ error: 'Server login is not configured yet. Ask the tournament admin.' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { body = null; }
  }
  if (!body || typeof body !== 'object') {
    return res.status(400).json({ error: 'Invalid request' });
  }

  const name = typeof body.name === 'string' ? body.name.trim().slice(0, 60) : '';
  const password = typeof body.password === 'string' ? body.password : '';
  const wantsAdmin = body.role === 'admin';

  if (!name || !password) {
    return res.status(400).json({ error: 'Name and password are required' });
  }

  const ok = wantsAdmin
    ? safeEqual(password, adminPassword)
    : (safeEqual(password, staffPassword) || safeEqual(password, adminPassword));

  if (!ok) {
    await sleep(500); // slow down password guessing
    return res.status(401).json({ error: 'Incorrect password! Please check your credentials and try again.' });
  }

  const role = wantsAdmin ? 'admin' : 'umpire';
  const { token, exp } = signToken({ name, role });
  return res.status(200).json({ status: 'ok', name, role, token, exp });
};

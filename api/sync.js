const { put, list } = require('@vercel/blob');
const { verifyToken, getBearerToken } = require('./_auth');

const BLOB_FILENAME = 'tournament_state.json';
const SECTIONS = ['players', 'teams', 'matches'];
const MAX_BODY_BYTES = 3.5 * 1024 * 1024; // Vercel functions accept ~4.5 MB bodies

async function readCurrentState() {
  const { blobs } = await list({ prefix: BLOB_FILENAME });
  if (!blobs || blobs.length === 0) return null;

  const latest = blobs.sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt))[0];
  const fetchRes = await fetch(latest.url, { cache: 'no-store' });
  if (!fetchRes.ok) {
    throw new Error(`Could not read stored state (${fetchRes.status})`);
  }
  return { data: await fetchRes.json(), uploadedAt: latest.uploadedAt };
}

function isValidSection(items) {
  return Array.isArray(items) && items.every(
    (item) => item && typeof item === 'object' && !Array.isArray(item) &&
      typeof item.id === 'string' && item.id.length > 0 && item.id.length <= 120
  );
}

module.exports = async function handler(req, res) {
  // Same-origin only: the app is served from this deployment, so no CORS headers are sent.
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  try {
    if (req.method === 'GET') {
      const current = await readCurrentState();
      if (!current) {
        return res.status(200).json({ status: 'empty', data: null });
      }
      return res.status(200).json({ status: 'ok', data: current.data, updatedAt: current.uploadedAt });
    }

    if (req.method === 'POST') {
      // Only signed-in staff may write
      const user = verifyToken(getBearerToken(req));
      if (!user) {
        return res.status(401).json({ error: 'Staff sign-in required' });
      }

      let payload = req.body;
      if (typeof payload === 'string') {
        try { payload = JSON.parse(payload); } catch (e) { payload = null; }
      }
      if (!payload || typeof payload !== 'object' || !payload.sections || typeof payload.sections !== 'object') {
        return res.status(400).json({ error: 'Expected { sections: { players?, teams?, matches? } }' });
      }

      const incoming = {};
      for (const key of Object.keys(payload.sections)) {
        if (!SECTIONS.includes(key)) {
          return res.status(400).json({ error: `Unknown section "${key}"` });
        }
        if (!isValidSection(payload.sections[key])) {
          return res.status(400).json({ error: `Invalid "${key}" data` });
        }
        incoming[key] = payload.sections[key];
      }
      if (Object.keys(incoming).length === 0) {
        return res.status(400).json({ error: 'No sections provided' });
      }

      // Merge only the sections sent by this client into the latest stored state, so a
      // scorer pushing "matches" never overwrites squad edits made on another device.
      const current = await readCurrentState();
      const base = (current && current.data) || {};
      const merged = {};
      SECTIONS.forEach((key) => { merged[key] = incoming[key] || base[key] || []; });

      // Server-assigned, strictly increasing version (client clocks are not trusted)
      merged.updatedAt = Math.max(Date.now(), Number(base.updatedAt || 0) + 1);

      const serialized = JSON.stringify(merged);
      if (Buffer.byteLength(serialized) > MAX_BODY_BYTES) {
        return res.status(413).json({ error: 'Tournament data is too large' });
      }

      await put(BLOB_FILENAME, serialized, {
        access: 'public',
        contentType: 'application/json',
        addRandomSuffix: false,
        allowOverwrite: true,
        cacheControlMaxAge: 60
      });

      // Return the sections the client did NOT send so it can pick up other devices' edits
      const others = { updatedAt: merged.updatedAt };
      SECTIONS.forEach((key) => { if (!incoming[key]) others[key] = merged[key]; });
      return res.status(200).json({ status: 'ok', updatedAt: merged.updatedAt, data: others });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('Blob sync error:', err);
    return res.status(500).json({ error: 'Sync failed' });
  }
};

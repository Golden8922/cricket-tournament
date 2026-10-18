const { put, list } = require('@vercel/blob');
const { verifyToken, getBearerToken } = require('./_auth');

const BLOB_FILENAME = 'tournament_state.json';
const SECTIONS = ['players', 'teams', 'matches'];
const MAX_BODY_BYTES = 3.5 * 1024 * 1024; // Vercel functions accept ~4.5 MB bodies
const MAX_DELETED_IDS = 500;

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

function isValidIdList(ids) {
  return Array.isArray(ids) && ids.length <= MAX_DELETED_IDS &&
    ids.every((id) => typeof id === 'string' && id.length > 0 && id.length <= 120);
}

// Matches are merged by id (the newest copy of each match wins) so one device can never
// drop matches that another device saved. Deleted ids are remembered so deletions stick.
function mergeMatches(currentList, incomingList, deletedIds) {
  const byId = new Map();
  [...currentList, ...incomingList].forEach((match) => {
    if (!match || !match.id || deletedIds.has(match.id)) return;
    const previous = byId.get(match.id);
    if (!previous || Number(match.updatedAt || 0) >= Number(previous.updatedAt || 0)) {
      byId.set(match.id, match);
    }
  });
  return [...byId.values()].sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));
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
      if (!payload || typeof payload !== 'object') {
        return res.status(400).json({ error: 'Expected { sections: {...}, deleted?: { matches: [ids] } }' });
      }

      const sections = payload.sections && typeof payload.sections === 'object' ? payload.sections : {};
      const incoming = {};
      for (const key of Object.keys(sections)) {
        if (!SECTIONS.includes(key)) {
          return res.status(400).json({ error: `Unknown section "${key}"` });
        }
        if (!isValidSection(sections[key])) {
          return res.status(400).json({ error: `Invalid "${key}" data` });
        }
        incoming[key] = sections[key];
      }

      const deletedMatches = payload.deleted && payload.deleted.matches !== undefined ? payload.deleted.matches : [];
      if (!isValidIdList(deletedMatches)) {
        return res.status(400).json({ error: 'Invalid deleted matches list' });
      }

      if (Object.keys(incoming).length === 0 && deletedMatches.length === 0) {
        return res.status(400).json({ error: 'Nothing to save' });
      }

      // Merge into the latest stored state so a scorer pushing "matches" never overwrites
      // squad edits made on another device (and vice versa).
      const current = await readCurrentState();
      const base = (current && current.data) || {};
      const merged = {};
      SECTIONS.forEach((key) => { merged[key] = incoming[key] || base[key] || []; });

      const deletedIds = new Set([...(base.deletedMatchIds || []), ...deletedMatches]);
      merged.deletedMatchIds = [...deletedIds].slice(-MAX_DELETED_IDS);
      const matchesTouched = Boolean(incoming.matches) || deletedMatches.length > 0;
      if (matchesTouched) {
        merged.matches = mergeMatches(base.matches || [], incoming.matches || [], deletedIds);
      }

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

      // Return what the client may not have: sections it did not send, plus the merged matches
      const others = { updatedAt: merged.updatedAt, deletedMatchIds: merged.deletedMatchIds };
      SECTIONS.forEach((key) => { if (!incoming[key] || key === 'matches') others[key] = merged[key]; });
      return res.status(200).json({ status: 'ok', updatedAt: merged.updatedAt, data: others });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('Blob sync error:', err);
    return res.status(500).json({ error: 'Sync failed' });
  }
};

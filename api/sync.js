const { put, list } = require('@vercel/blob');

module.exports = async function handler(req, res) {
  // Set CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const BLOB_FILENAME = 'tournament_state.json';

  try {
    if (req.method === 'GET') {
      const { blobs } = await list({ prefix: BLOB_FILENAME });
      if (!blobs || blobs.length === 0) {
        return res.status(200).json({ status: 'empty', data: null });
      }

      const latest = blobs.sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt))[0];
      const fetchRes = await fetch(latest.url, { cache: 'no-store' });
      const data = await fetchRes.json();
      return res.status(200).json({ status: 'ok', data, updatedAt: latest.uploadedAt });
    }

    if (req.method === 'POST') {
      let payload = req.body;
      if (typeof payload === 'string') {
        try {
          payload = JSON.parse(payload);
        } catch (e) {}
      }
      if (!payload) {
        return res.status(400).json({ error: 'Missing body payload' });
      }

      payload.updatedAt = payload.updatedAt || Date.now();

      const blob = await put(BLOB_FILENAME, JSON.stringify(payload), {
        access: 'public',
        contentType: 'application/json',
        addRandomSuffix: false,
        allowOverwrite: true
      });

      return res.status(200).json({ status: 'ok', url: blob.url, updatedAt: payload.updatedAt });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('Blob sync error:', err);
    return res.status(500).json({ error: err.message });
  }
};

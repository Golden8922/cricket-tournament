// Run with: npm test   (uses the built-in node:test runner, no dependencies)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const Module = require('module');

const ROOT = path.join(__dirname, '..');

// ---------------------------------------------------------------------------
// API: api/login.js + api/sync.js (with @vercel/blob mocked in memory)
// ---------------------------------------------------------------------------
const blobStore = { body: null, uploadedAt: null };
const originalRequire = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === '@vercel/blob') {
    return {
      async list() {
        return blobStore.body === null
          ? { blobs: [] }
          : { blobs: [{ url: 'mock://blob', uploadedAt: blobStore.uploadedAt }] };
      },
      async put(name, body) {
        blobStore.body = body;
        blobStore.uploadedAt = new Date().toISOString();
        return { url: 'mock://blob' };
      }
    };
  }
  return originalRequire.apply(this, arguments);
};
const realFetch = global.fetch;
global.fetch = async (url) => {
  if (url === 'mock://blob') {
    return { ok: true, status: 200, json: async () => JSON.parse(blobStore.body) };
  }
  return realFetch(url);
};

process.env.STAFF_PASSWORD = 'umpire-pass';
process.env.ADMIN_PASSWORD = 'admin-pass';
process.env.AUTH_SECRET = 'test-secret';

const login = require(path.join(ROOT, 'api', 'login.js'));
const sync = require(path.join(ROOT, 'api', 'sync.js'));

function mockRes() {
  return {
    statusCode: 200, headers: {}, body: undefined,
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
    end() { return this; }
  };
}
async function call(handler, req) {
  const res = mockRes();
  await handler({ headers: {}, ...req }, res);
  return res;
}
async function signIn(role = 'umpire') {
  const pw = role === 'admin' ? 'admin-pass' : 'umpire-pass';
  const res = await call(login, { method: 'POST', body: { name: 'Test', password: pw, role } });
  assert.equal(res.statusCode, 200);
  return res.body.token;
}

test('login rejects a wrong password, and the legacy one when STAFF_PASSWORD is set', async () => {
  const bad = await call(login, { method: 'POST', body: { name: 'x', password: 'sitare@2029', role: 'umpire' } });
  assert.equal(bad.statusCode, 401);
  assert.equal(bad.body.token, undefined);
});

test('umpire password cannot sign in as admin', async () => {
  const res = await call(login, { method: 'POST', body: { name: 'x', password: 'umpire-pass', role: 'admin' } });
  assert.equal(res.statusCode, 401);
});

test('login still works when no signing secret or blob token is visible to the function', async () => {
  const saved = { s: process.env.STAFF_PASSWORD, a: process.env.ADMIN_PASSWORD, k: process.env.AUTH_SECRET, b: process.env.BLOB_READ_WRITE_TOKEN };
  delete process.env.STAFF_PASSWORD;
  delete process.env.ADMIN_PASSWORD;
  delete process.env.AUTH_SECRET;
  delete process.env.BLOB_READ_WRITE_TOKEN;
  try {
    const res = await call(login, { method: 'POST', body: { name: 'x', password: 'sitare@2029', role: 'umpire' } });
    assert.equal(res.statusCode, 200);
    const sync1 = await call(sync, { method: 'POST', headers: { authorization: `Bearer ${res.body.token}` }, body: { sections: { teams: [{ id: 't9' }] } } });
    assert.equal(sync1.statusCode, 200, 'token from login is accepted by sync');
  } finally {
    process.env.STAFF_PASSWORD = saved.s;
    process.env.ADMIN_PASSWORD = saved.a;
    process.env.AUTH_SECRET = saved.k;
    if (saved.b !== undefined) process.env.BLOB_READ_WRITE_TOKEN = saved.b;
  }
});

test('without STAFF_PASSWORD the legacy password works and others are rejected', async () => {
  const saved = { s: process.env.STAFF_PASSWORD, a: process.env.ADMIN_PASSWORD };
  delete process.env.STAFF_PASSWORD;
  delete process.env.ADMIN_PASSWORD;
  try {
    const good = await call(login, { method: 'POST', body: { name: 'x', password: 'sitare@2029', role: 'umpire' } });
    assert.equal(good.statusCode, 200);
    assert.ok(good.body.token);
    const admin = await call(login, { method: 'POST', body: { name: 'x', password: 'sitare@2029', role: 'admin' } });
    assert.equal(admin.statusCode, 200);
    const bad = await call(login, { method: 'POST', body: { name: 'x', password: 'anything', role: 'umpire' } });
    assert.equal(bad.statusCode, 401);
  } finally {
    process.env.STAFF_PASSWORD = saved.s;
    process.env.ADMIN_PASSWORD = saved.a;
  }
});

test('sync POST requires a valid token', async () => {
  const body = { sections: { matches: [{ id: 'm1' }] } };
  assert.equal((await call(sync, { method: 'POST', body })).statusCode, 401);
  assert.equal((await call(sync, { method: 'POST', body, headers: { authorization: 'Bearer nope.nope' } })).statusCode, 401);

  // tampered token
  const token = await signIn();
  const [payload] = token.split('.');
  const forged = Buffer.from(JSON.stringify({ name: 'x', role: 'admin', exp: Date.now() + 1e9 })).toString('base64url');
  assert.notEqual(forged, payload);
  assert.equal((await call(sync, { method: 'POST', body, headers: { authorization: `Bearer ${forged}.${token.split('.')[1]}` } })).statusCode, 401);
});

test('sync POST validates shape and merges only the sent sections', async () => {
  const token = await signIn();
  const headers = { authorization: `Bearer ${token}` };

  assert.equal((await call(sync, { method: 'POST', headers, body: { players: [] } })).statusCode, 400);
  assert.equal((await call(sync, { method: 'POST', headers, body: { sections: { hacked: [] } } })).statusCode, 400);
  assert.equal((await call(sync, { method: 'POST', headers, body: { sections: { matches: [{ nope: 1 }] } } })).statusCode, 400);

  const first = await call(sync, { method: 'POST', headers, body: { sections: { players: [{ id: 'p1' }], teams: [{ id: 't1' }] } } });
  assert.equal(first.statusCode, 200);

  const second = await call(sync, { method: 'POST', headers, body: { sections: { matches: [{ id: 'm1' }] } } });
  assert.equal(second.statusCode, 200);
  assert.ok(second.body.updatedAt > first.body.updatedAt, 'server version must increase');
  assert.deepEqual(second.body.data.players, [{ id: 'p1' }], 'other sections are returned to the client');
  assert.equal(second.body.data.matches, undefined, 'own section is not echoed back');

  const stored = JSON.parse(blobStore.body);
  assert.deepEqual(stored.players, [{ id: 'p1' }]);
  assert.deepEqual(stored.matches, [{ id: 'm1' }]);

  const get = await call(sync, { method: 'GET' });
  assert.equal(get.body.status, 'ok');
});

test('sync GET reports "empty" only when nothing is stored', async () => {
  const saved = { ...blobStore };
  blobStore.body = null;
  const res = await call(sync, { method: 'GET' });
  assert.equal(res.body.status, 'empty');
  Object.assign(blobStore, saved);
});

// ---------------------------------------------------------------------------
// Client: js/db.js sync engine (loaded into a vm with stubbed browser globals)
// ---------------------------------------------------------------------------
function loadDb({ token = true, fetchImpl } = {}) {
  const storage = new Map();
  const calls = [];
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    localStorage: {
      getItem: (k) => (storage.has(k) ? storage.get(k) : null),
      setItem: (k, v) => storage.set(k, String(v)),
      removeItem: (k) => storage.delete(k)
    },
    window: { addEventListener() {} },
    navigator: { onLine: true },
    setInterval() { return 0; },
    clearInterval() {},
    Date, JSON, Math, Number, String, Array, Boolean, Promise, Error, Set, Object,
    fetch: async (url, opts = {}) => {
      calls.push({ url: String(url), method: opts.method || 'GET', body: opts.body, headers: opts.headers });
      return fetchImpl(String(url), opts);
    }
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'js', 'seed.js'), 'utf8'), sandbox);
  const db = vm.runInContext(fs.readFileSync(path.join(ROOT, 'js', 'db.js'), 'utf8') + '\n;AppDB', sandbox);
  if (token) {
    db.currentUser = { name: 'Test', role: 'umpire', token: 't', exp: Date.now() + 3600e3 };
  }
  return { db, storage, calls };
}
const ok = (json) => ({ ok: true, status: 200, json: async () => json });
const posts = (calls) => calls.filter((c) => c.method === 'POST');

test('a failed cloud read never pushes local data (cloud-wipe regression)', async () => {
  const { db, calls } = loadDb({ fetchImpl: async () => { throw new Error('network down'); } });
  db.ensureSeedData(); // fresh visitor: local seed data, no matches
  await db.pullFromCloud();
  assert.equal(posts(calls).length, 0);
  assert.equal(db.connectionStatus, 'reconnecting');
});

test('non-OK responses are treated as errors, not as an empty cloud', async () => {
  const { db, calls } = loadDb({ fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}) }) });
  db.ensureSeedData();
  await db.pullFromCloud();
  assert.equal(posts(calls).length, 0);
});

test('an explicitly empty cloud is only seeded by signed-in staff', async () => {
  const empty = async () => ok({ status: 'empty', data: null });

  const visitor = loadDb({ token: false, fetchImpl: async (u, o) => (o.method === 'POST' ? ok({}) : empty()) });
  visitor.db.ensureSeedData();
  await visitor.db.pullFromCloud();
  assert.equal(posts(visitor.calls).length, 0);

  const staff = loadDb({
    fetchImpl: async (u, o) => {
      if (o.method === 'POST') return ok({ status: 'ok', updatedAt: 5, data: { updatedAt: 5 } });
      if (u.includes('blob.vercel-storage')) return { ok: false, status: 404, json: async () => ({}) };
      return empty();
    }
  });
  staff.db.ensureSeedData();
  await staff.db.pullFromCloud();
  await new Promise((r) => setTimeout(r, 10));
  const sent = posts(staff.calls);
  assert.equal(sent.length, 1);
  assert.deepEqual(Object.keys(JSON.parse(sent[0].body).sections).sort(), ['matches', 'players', 'teams']);
  assert.equal(sent[0].headers.Authorization, 'Bearer t');
});

test('a pull never overwrites sections with unsent local edits', async () => {
  const remote = { updatedAt: 100, players: [{ id: 'rp' }], teams: [{ id: 'rt' }], matches: [{ id: 'remote-match' }] };
  const { db, storage } = loadDb({ token: false, fetchImpl: async () => ok(remote) });
  storage.set('cct_matches', JSON.stringify([{ id: 'local-live-match' }]));
  db.markDirty(['matches']);
  await db.pullFromCloud();
  assert.deepEqual(JSON.parse(storage.get('cct_matches')), [{ id: 'local-live-match' }]);
  assert.deepEqual(JSON.parse(storage.get('cct_players')), [{ id: 'rp' }]);
});

test('failed pushes stay dirty and are retried; success clears them', async () => {
  let failing = true;
  const { db, storage, calls } = loadDb({
    fetchImpl: async (u, o) => {
      if (o.method === 'POST') {
        if (failing) throw new Error('offline');
        return ok({ status: 'ok', updatedAt: 50, data: { updatedAt: 50, players: [{ id: 'other-device' }] } });
      }
      return ok({ updatedAt: 1, players: [], teams: [], matches: [] });
    }
  });
  storage.set('cct_matches', JSON.stringify([{ id: 'm1' }]));
  await db.queueSync(['matches']);
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(db.getDirty(), ['matches'], 'still dirty after a failed push');

  failing = false;
  db._pushRetryAt = 0;
  await db.pullFromCloud(); // poll tick retries the push
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(db.getDirty(), []);
  assert.equal(posts(calls).length, 2);
  assert.deepEqual(JSON.parse(storage.get('cct_players')), [{ id: 'other-device' }], 'other sections from the server are applied');
});

test('write helpers require a signed-in staff session', async () => {
  const { db } = loadDb({ token: false, fetchImpl: async () => ok({}) });
  db.ensureSeedData();
  await assert.rejects(() => db.addTeam('Rebels'), /Unauthorized/);
  await assert.rejects(() => db.deletePlayer('p_off_1'), /Unauthorized/);
  await assert.rejects(() => db.updateTeam('team_falcons', { name: 'X' }), /Unauthorized/);
  await assert.rejects(() => db.createMatch({}), /Unauthorized/);
});

test('an expired session is not treated as staff', () => {
  const { db } = loadDb({ token: false, fetchImpl: async () => ok({}) });
  db.currentUser = { name: 'x', role: 'admin', token: 't', exp: Date.now() - 1 };
  assert.equal(db.isStaff(), false);
  assert.equal(db.isAdmin(), false);
});

test('matches scored by an older version are recovered once, then pushed (one-time migration)', async () => {
  const remote = { updatedAt: 100, players: [{ id: 'p' }], teams: [{ id: 't' }], matches: [] };
  const { db, storage, calls } = loadDb({
    fetchImpl: async (u, o) => (o.method === 'POST'
      ? ok({ status: 'ok', updatedAt: 200, data: { updatedAt: 200, players: [{ id: 'p' }], teams: [{ id: 't' }] } })
      : ok(remote))
  });
  storage.set('cct_matches', JSON.stringify([{ id: 'm_old', createdAt: 1, status: 'done' }]));
  await db.pullFromCloud();
  await new Promise((r) => setTimeout(r, 10));

  const sent = posts(calls);
  assert.equal(sent.length, 1);
  assert.deepEqual(JSON.parse(sent[0].body).sections.matches.map((m) => m.id), ['m_old']);
  assert.deepEqual(JSON.parse(storage.get('cct_matches')).map((m) => m.id), ['m_old'], 'local match kept');
  assert.deepEqual(db.getDirty(), []);

  // second run must not resurrect anything
  storage.set('cct_matches', JSON.stringify([]));
  await db.pullFromCloud();
  assert.equal(posts(calls).length, 1);
});

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
  assert.deepEqual(second.body.data.matches, [{ id: 'm1' }], 'merged matches are returned so the client can adopt them');

  const stored = JSON.parse(blobStore.body);
  assert.deepEqual(stored.players, [{ id: 'p1' }]);
  assert.deepEqual(stored.matches, [{ id: 'm1' }]);

  const get = await call(sync, { method: 'GET' });
  assert.equal(get.body.status, 'ok');
});

test('sync merges matches by id and remembers deletions', async () => {
  const token = await signIn();
  const headers = { authorization: `Bearer ${token}` };
  const t0 = Date.now();

  await call(sync, { method: 'POST', headers, body: { sections: { matches: [{ id: 'a', createdAt: 1, updatedAt: t0 }, { id: 'b', createdAt: 2, updatedAt: t0 }] } } });
  // a second device that only knows match "c" must not drop a and b
  const res = await call(sync, { method: 'POST', headers, body: { sections: { matches: [{ id: 'c', createdAt: 3, updatedAt: t0 }] } } });
  const ids = res.body.data.matches.map((m) => m.id);
  ['a', 'b', 'c'].forEach((id) => assert.ok(ids.includes(id), `match ${id} kept`));

  // newest copy of a match wins
  const upd = await call(sync, { method: 'POST', headers, body: { sections: { matches: [{ id: 'a', createdAt: 1, updatedAt: t0 + 5, result: 'new' }] } } });
  assert.equal(upd.body.data.matches.find((m) => m.id === 'a').result, 'new');
  const stale = await call(sync, { method: 'POST', headers, body: { sections: { matches: [{ id: 'a', createdAt: 1, updatedAt: t0 - 5, result: 'old' }] } } });
  assert.equal(stale.body.data.matches.find((m) => m.id === 'a').result, 'new');

  // deletions stick even if a stale device re-sends the match
  const del = await call(sync, { method: 'POST', headers, body: { sections: {}, deleted: { matches: ['b'] } } });
  assert.equal(del.statusCode, 200);
  const resend = await call(sync, { method: 'POST', headers, body: { sections: { matches: [{ id: 'b', createdAt: 2, updatedAt: t0 + 99 }] } } });
  assert.ok(!resend.body.data.matches.some((m) => m.id === 'b'));

  assert.equal((await call(sync, { method: 'POST', headers, body: { sections: {}, deleted: { matches: 'nope' } } })).statusCode, 400);
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
    setTimeout() { return 0; },
    clearTimeout() {},
    Date, JSON, Math, Number, String, Array, Boolean, Promise, Error, Set, Object,
    fetch: async (url, opts = {}) => {
      calls.push({ url: String(url), method: opts.method || 'GET', body: opts.body, headers: opts.headers });
      return fetchImpl(String(url), opts);
    }
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'js', 'seed.js'), 'utf8'), sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'js', 'engine.js'), 'utf8'), sandbox);
  const engine = vm.runInContext('CricketEngine', sandbox);
  const db = vm.runInContext(fs.readFileSync(path.join(ROOT, 'js', 'db.js'), 'utf8') + '\n;AppDB', sandbox);
  if (token) {
    db.currentUser = { name: 'Test', role: 'umpire', token: 't', exp: Date.now() + 3600e3 };
  }
  return { db, storage, calls, engine };
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

test('a pull merges matches by id and never drops a local match', async () => {
  const remote = { updatedAt: 100, players: [{ id: 'rp' }], teams: [{ id: 'rt' }], matches: [{ id: 'remote-match', createdAt: 1 }] };
  const { db, storage } = loadDb({ token: false, fetchImpl: async () => ok(remote) });
  storage.set('cct_matches', JSON.stringify([{ id: 'local-live-match', createdAt: 2 }]));
  await db.pullFromCloud();
  const ids = JSON.parse(storage.get('cct_matches')).map((m) => m.id).sort();
  assert.deepEqual(ids, ['local-live-match', 'remote-match']);
  assert.deepEqual(JSON.parse(storage.get('cct_players')), [{ id: 'rp' }]);
  assert.deepEqual(db.getDirty(), ['matches'], 'the local-only match is queued for upload');
});

test('a pull does not overwrite players/teams that have unsent local edits', async () => {
  const remote = { updatedAt: 100, players: [{ id: 'rp' }], teams: [{ id: 'rt' }], matches: [] };
  const { db, storage } = loadDb({ token: false, fetchImpl: async () => ok(remote) });
  storage.set('cct_teams', JSON.stringify([{ id: 'my-edit' }]));
  db.markDirty(['teams']);
  await db.pullFromCloud();
  assert.deepEqual(JSON.parse(storage.get('cct_teams')), [{ id: 'my-edit' }]);
  assert.deepEqual(JSON.parse(storage.get('cct_players')), [{ id: 'rp' }]);
});

test('deleting a match sends its id so it is not resurrected by merging', async () => {
  const { db, storage, calls } = loadDb({
    fetchImpl: async (u, o) => (o.method === 'POST'
      ? ok({ status: 'ok', updatedAt: 9, data: { updatedAt: 9, matches: [], deletedMatchIds: ['m_gone'] } })
      : ok({ updatedAt: 10, players: [], teams: [], matches: [{ id: 'm_gone', createdAt: 1 }], deletedMatchIds: ['m_gone'] }))
  });
  storage.set('cct_matches', JSON.stringify([{ id: 'm_gone', createdAt: 1 }]));
  await db.deleteMatch('m_gone');
  await new Promise((r) => setTimeout(r, 10));
  const sent = posts(calls);
  assert.equal(sent.length, 1);
  assert.deepEqual(JSON.parse(sent[0].body).deleted.matches, ['m_gone']);
  assert.deepEqual(db.getPendingDeletedMatches(), [], 'cleared after the server confirmed');

  await db.pullFromCloud(); // remote still lists the match, but its deleted-id list wins
  assert.deepEqual(JSON.parse(storage.get('cct_matches') || '[]'), []);
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

test('past matches from final scores give the right results, points and NRR', async () => {
  const { db, storage, engine } = loadDb({ fetchImpl: async () => ok({}) });
  db.ensureSeedData();

  const m1 = await db.addPastMatch({
    teamA: 'Dominators', teamB: 'Falcons', overs: 8,
    inn1: { runs: 44, wickets: 2, balls: 48 }, inn2: { runs: 45, wickets: 3, balls: 21 },
    playedAt: new Date('2026-10-17T06:30').getTime()
  });
  assert.equal(m1.result, 'Falcons won by 7 wickets (27 balls left)');

  const m2 = await db.addPastMatch({
    teamA: 'Sitare Strikers', teamB: 'Power Smashers', overs: 8,
    inn1: { runs: 50, wickets: 5, balls: 48 }, inn2: { runs: 54, wickets: 5, balls: 41 },
    playedAt: new Date('2026-10-17T08:43').getTime()
  });
  assert.equal(m2.result, 'Power Smashers won by 5 wickets (7 balls left)');

  const matches = JSON.parse(storage.get('cct_matches'));
  const table = engine.calculatePointsTable(matches, JSON.parse(storage.get('cct_teams')));
  const row = (name) => table.find((r) => r.teamName === name);
  assert.deepEqual([row('Falcons').played, row('Falcons').won, row('Falcons').points, row('Falcons').nrrFormatted], [1, 1, 2, '+7.357']);
  assert.deepEqual([row('Dominators').played, row('Dominators').lost, row('Dominators').points, row('Dominators').nrrFormatted], [1, 1, 0, '-7.357']);
  assert.deepEqual([row('Power Smashers').points, row('Power Smashers').nrrFormatted], [2, '+1.652']);
  assert.deepEqual([row('Sitare Strikers').points, row('Sitare Strikers').nrrFormatted], [0, '-1.652']);
  assert.deepEqual(db.getDirty(), ['matches'], 'queued for upload');

  // validation
  await assert.rejects(() => db.addPastMatch({ teamA: 'Falcons', teamB: 'Falcons', overs: 8, inn1: {}, inn2: {}, playedAt: 1 }), /different teams/);
  await assert.rejects(() => db.addPastMatch({ teamA: 'Falcons', teamB: 'Dominators', overs: 8, inn1: { runs: 1, wickets: 0, balls: 49 }, inn2: { runs: 1, wickets: 0, balls: 1 }, playedAt: 1 }), /cannot exceed/);
});

test('adding a past match requires staff sign-in', async () => {
  const { db } = loadDb({ token: false, fetchImpl: async () => ok({}) });
  db.ensureSeedData();
  await assert.rejects(() => db.addPastMatch({}), /Unauthorized/);
});

// ---------------------------------------------------------------------------
// Engine + data features added later
// ---------------------------------------------------------------------------
test('table: head-to-head is the last tie-break (after points, NRR and wins)', () => {
  const { engine } = loadDb({ fetchImpl: async () => ok({}) });
  const mk = (a, b, ra, rb) => ({
    id: a + b, teamA: a, teamB: b, overs: 8, status: 'done', createdAt: 1, balls: [],
    summary: { inn1: { runs: ra, wickets: 0, balls: 48 }, inn2: { runs: rb, wickets: 0, balls: 48 } }
  });
  // A beat B 50-40; A lost to C 40-50; B beat D 50-40  => A and B level on points, NRR and wins
  const matches = [mk('A', 'B', 50, 40), mk('C', 'A', 50, 40), mk('B', 'D', 50, 40)];
  const teams = ['B', 'A', 'C', 'D'].map((n) => ({ id: n, name: n })); // B listed first on purpose
  const table = engine.calculatePointsTable(matches, teams).map((r) => r.teamName);
  assert.deepEqual(table.slice(1, 3), ['A', 'B'], 'A beat B, so A ranks above B');
});

test('run out with runs completed: runs count for the team and striker, not the bowler wicket', () => {
  const { engine } = loadDb({ fetchImpl: async () => ok({}) });
  const balls = [{ innings: 1, batterId: 'p1', bowlerId: 'b1', runs: 2, extraType: null, isWicket: true, wicketType: 'runout', outPlayerId: 'p2', isLegal: true }];
  const st = engine.replayInnings(balls, ['p1', 'p2', 'p3'], ['b1'], 8);
  assert.equal(st.totalRuns, 2);
  assert.equal(st.wickets, 1);
  assert.equal(st.batters.p1.runs, 2);
  assert.equal(st.batters.p2.isOut, true);
  assert.equal(st.bowlers.b1.wickets, 0, 'run out is not credited to the bowler');
  assert.equal(st.bowlers.b1.runsConceded, 2);
  assert.equal(engine.createBallBadge(balls[0], 2, true).text, '2W');
});

test('undo snapshots are kept only for recent balls and dropped when the match finishes', async () => {
  const { db, storage } = loadDb({ fetchImpl: async () => ok({}) });
  const balls = Array.from({ length: 40 }, (_, i) => ({ id: 'b' + i, innings: 1, runs: 1, snapshot: { strikerId: 'x' } }));
  storage.set('cct_matches', JSON.stringify([{ id: 'm1', status: 'live', balls: [] }]));
  await db.updateMatch('m1', { balls });
  let saved = JSON.parse(storage.get('cct_matches'))[0].balls;
  assert.equal(saved.filter((b) => b.snapshot).length, db.UNDO_DEPTH);
  assert.ok(saved[39].snapshot && !saved[0].snapshot);

  await db.updateMatch('m1', { status: 'done', balls });
  saved = JSON.parse(storage.get('cct_matches'))[0].balls;
  assert.equal(saved.filter((b) => b.snapshot).length, 0);

  // finishing with a status-only patch (as the app does) strips the stored balls too
  storage.set('cct_matches', JSON.stringify([{ id: 'm2', status: 'live', balls }]));
  await db.updateMatch('m2', { status: 'done', result: 'x' });
  saved = JSON.parse(storage.get('cct_matches'))[0].balls;
  assert.equal(saved.filter((b) => b.snapshot).length, 0);
  assert.equal(saved.length, 40, 'no ball is lost, only the undo data');
});

test('fixtures: staff only, validated, sorted by time, queued for sync and accepted from the cloud', async () => {
  const { db, storage } = loadDb({ fetchImpl: async () => ok({}) });
  db.ensureSeedData();
  const visitor = loadDb({ token: false, fetchImpl: async () => ok({}) });
  visitor.db.ensureSeedData();
  await assert.rejects(() => visitor.db.addFixture({}), /Unauthorized/);

  await assert.rejects(() => db.addFixture({ teamA: 'Falcons', teamB: 'Falcons', scheduledAt: 1 }), /different teams/);
  await assert.rejects(() => db.addFixture({ teamA: 'Falcons', teamB: 'Nobody', scheduledAt: 1 }), /existing teams/);
  await assert.rejects(() => db.addFixture({ teamA: 'Falcons', teamB: 'Dominators' }), /date and time/);

  const late = await db.addFixture({ teamA: 'Falcons', teamB: 'Dominators', scheduledAt: 2000, note: ' Final ' });
  await db.addFixture({ teamA: 'Sitare Strikers', teamB: 'Power Smashers', scheduledAt: 1000 });
  const list = JSON.parse(storage.get('cct_fixtures'));
  assert.deepEqual(list.map((f) => f.scheduledAt), [1000, 2000]);
  assert.equal(list[1].note, 'Final');
  assert.ok(db.getDirty().includes('fixtures'));

  await db.deleteFixture(late.id);
  assert.equal(JSON.parse(storage.get('cct_fixtures')).length, 1);

  // another device's fixtures arrive via sync, including an emptied list
  const other = loadDb({ token: false, fetchImpl: async () => ok({}) });
  other.db.applyRemote({ updatedAt: 5, fixtures: [{ id: 'f1', teamA: 'A', teamB: 'B', scheduledAt: 1 }] });
  assert.equal(JSON.parse(other.storage.get('cct_fixtures')).length, 1);
  other.db.applyRemote({ updatedAt: 6, fixtures: [] });
  assert.equal(JSON.parse(other.storage.get('cct_fixtures')).length, 0);
});

test('polling is fast while a match is live or staff are signed in, slow otherwise', async () => {
  const idle = loadDb({ token: false, fetchImpl: async () => ok({}) });
  assert.equal(idle.db._pollDelay(), idle.db.CLOUD.POLL_IDLE_MS);
  idle.storage.set('cct_matches', JSON.stringify([{ id: 'm', status: 'live' }]));
  assert.equal(idle.db._pollDelay(), idle.db.CLOUD.POLL_LIVE_MS);
  const staff = loadDb({ fetchImpl: async () => ok({}) });
  assert.equal(staff.db._pollDelay(), staff.db.CLOUD.POLL_LIVE_MS);
});

test('refreshNow records when the server was last reached', async () => {
  const { db } = loadDb({ token: false, fetchImpl: async () => ok({ updatedAt: 3, players: [], teams: [], matches: [] }) });
  assert.equal(db.lastSyncOkAt, 0);
  await db.refreshNow();
  assert.ok(db.lastSyncOkAt > 0);
});

test('sync API accepts fixtures as a section', async () => {
  const token = await signIn();
  const res = await call(sync, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: { sections: { fixtures: [{ id: 'f1', teamA: 'A', teamB: 'B' }] } } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(blobStore.body).fixtures, [{ id: 'f1', teamA: 'A', teamB: 'B' }]);
});

// ---------------------------------------------------------------------------
// Qualification ("Q") is only given when it is mathematically certain
// ---------------------------------------------------------------------------
test('Q: only teams certain to finish in the top N whatever the remaining results', () => {
  const { engine } = loadDb({ fetchImpl: async () => ok({}) });
  const row = (teamName, points) => ({ teamName, points });

  // A has 6; the best any single rival can do is 6 and two rivals cannot both reach it (B-C is a match)
  let table = [row('A', 6), row('B', 2), row('C', 2), row('D', 0)];
  let rem = [['B', 'C'], ['B', 'D'], ['C', 'D']];
  assert.deepEqual([...engine.computeQualification(table, rem, 2)], ['A']);

  // level on points with matches left: nobody is certain
  table = [row('A', 4), row('B', 4), row('C', 2), row('D', 0)];
  rem = [['A', 'C'], ['B', 'D']];
  assert.deepEqual([...engine.computeQualification(table, rem, 2)], []);

  // league finished: the final order decides (tie already settled by the table order)
  table = [row('A', 4), row('B', 4), row('C', 2), row('D', 0)];
  assert.deepEqual([...engine.computeQualification(table, [], 1)], ['A']);
  assert.deepEqual([...engine.computeQualification(table, [], 2)].sort(), ['A', 'B']);

  // a team can be certain even though it has matches left (clear points lead)
  table = [row('A', 8), row('B', 2), row('C', 2), row('D', 2)];
  rem = [['A', 'B'], ['C', 'D'], ['B', 'C']];
  assert.ok(engine.computeQualification(table, rem, 2).has('A'));

  // nothing to decide when everyone qualifies
  assert.equal(engine.computeQualification(table, rem, 4).size, 4);
});

test('Q: with the real standings so far nobody is certain yet, and finishing the league settles it', () => {
  const { engine } = loadDb({ fetchImpl: async () => ok({}) });
  const mk = (a, b, ra, rb) => ({
    id: a + b, teamA: a, teamB: b, overs: 8, status: 'done', createdAt: 1, balls: [],
    summary: { inn1: { runs: ra, wickets: 0, balls: 48 }, inn2: { runs: rb, wickets: 0, balls: 48 } }
  });
  const teams = ['Falcons', 'Sitare Strikers', 'Dominators', 'Power Smashers'].map((n) => ({ id: n, name: n }));
  // 4 of the 6 round-robin matches played (same shape as the live tournament)
  let matches = [mk('Falcons', 'Sitare Strikers', 40, 50), mk('Dominators', 'Power Smashers', 40, 50), mk('Sitare Strikers', 'Power Smashers', 40, 50), mk('Dominators', 'Falcons', 40, 50)];
  let table = engine.calculatePointsTable(matches, teams);
  let remaining = engine.getRemainingLeagueMatches(matches, teams, [], 1);
  assert.equal(remaining.length, 2);
  assert.deepEqual(Array.from(remaining, (r) => Array.from(r).sort().join(' v ')).sort(), ['Dominators v Sitare Strikers', 'Falcons v Power Smashers']);
  assert.equal(engine.computeQualification(table, remaining, 2).size, 0);

  // the league finishes: Power Smashers win again and Sitare Strikers beat Dominators
  matches = matches.concat([mk('Falcons', 'Power Smashers', 40, 50), mk('Dominators', 'Sitare Strikers', 40, 50)]);
  table = engine.calculatePointsTable(matches, teams);
  remaining = engine.getRemainingLeagueMatches(matches, teams, [], 1);
  assert.equal(remaining.length, 0);
  const q = engine.computeQualification(table, remaining, 2);
  assert.deepEqual([...q].sort(), Array.from(table.slice(0, 2), (r) => r.teamName).sort());
});

test('remaining league matches: round robin gaps plus extra scheduled fixtures; live matches are not finished', () => {
  const { engine } = loadDb({ fetchImpl: async () => ok({}) });
  const teams = ['A', 'B', 'C'].map((n) => ({ id: n, name: n }));
  const done = { id: '1', teamA: 'A', teamB: 'B', status: 'done' };
  assert.equal(engine.getRemainingLeagueMatches([done], teams, [], 1).length, 2);
  assert.equal(engine.getRemainingLeagueMatches([done], teams, [], 2).length, 5);
  // an extra fixture for a pair that already played once
  const fx = [{ teamA: 'A', teamB: 'B' }, { teamA: 'A', teamB: 'B' }];
  assert.equal(engine.getRemainingLeagueMatches([done], teams, fx, 1).length, 3);
  const live = { id: '2', teamA: 'A', teamB: 'C', status: 'live' };
  assert.equal(engine.getRemainingLeagueMatches([done, live], teams, [], 1).length, 2);
});

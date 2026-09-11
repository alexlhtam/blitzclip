import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { makeServer } from './server.js';

process.env.BLITZCLIP_FAKE_DB = '1';

let base, server;
before(async () => { server = makeServer(); await new Promise(r => server.listen(0, r)); base = `http://localhost:${server.address().port}`; });
after(() => server.close());

// A minimal cookie jar so the tests behave like a browser.
function client() {
  let cookie = '';
  return async (path, { method = 'GET', body, headers = {}, raw } = {}) => {
    const h = { ...headers, cookie, origin: base };
    let payload = raw;
    if (body !== undefined) { h['content-type'] = 'application/json'; payload = JSON.stringify(body); }
    const res = await fetch(base + path, { method, headers: h, body: payload });
    const sc = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    for (const c of sc) { const [kv] = c.split(';'); if (kv.endsWith('=')) cookie = ''; else cookie = kv; }
    let data = null; try { data = await res.json(); } catch {}
    return { status: res.status, data };
  };
}

const parsed = { tankId: 9297, vehicleCode: 'GB48_FV215b_183', vehicle: 'FV215b 183', map: 'rock', player: 'alex', duration: 254.8, error: null,
  shots: [{ clock: 53.9, damage: 1204, cumulative: 1204, ammo: 1, hitType: 3 }, { clock: 108.1, damage: 344, cumulative: 1548, ammo: 1, hitType: 4, kill: true }, { clock: 194, damage: 0, roll: 950, noDamage: true, cumulative: null, ammo: 0, hitType: 4 }] };

test('anonymous requests are refused, signup/login/logout work', async () => {
  const c = client();
  assert.equal((await c('/api/replays')).status, 401);
  assert.equal((await c('/api/auth/me')).data.user, null);

  let r = await c('/api/auth/signup', { method: 'POST', body: { email: 'not-an-email', password: 'longenough' } });
  assert.equal(r.status, 400);
  r = await c('/api/auth/signup', { method: 'POST', body: { email: 'Alex@Example.com', password: 'short' } });
  assert.equal(r.status, 400);
  r = await c('/api/auth/signup', { method: 'POST', body: { email: 'Alex@Example.com', password: 'correct horse' } });
  assert.equal(r.status, 201); assert.equal(r.data.user.email, 'alex@example.com');
  r = await c('/api/auth/me'); assert.equal(r.data.user.email, 'alex@example.com');

  r = await c('/api/auth/signup', { method: 'POST', body: { email: 'alex@example.com', password: 'correct horse' } });
  assert.equal(r.status, 409);

  r = await c('/api/auth/logout', { method: 'POST' }); assert.equal(r.status, 200);
  assert.equal((await c('/api/auth/me')).data.user, null);

  r = await c('/api/auth/login', { method: 'POST', body: { email: 'alex@example.com', password: 'wrong' } }); assert.equal(r.status, 401);
  r = await c('/api/auth/login', { method: 'POST', body: { email: ' ALEX@example.com ', password: 'correct horse' } }); assert.equal(r.status, 200);
  assert.equal((await c('/api/auth/me')).data.user.id, r.data.user.id);
});

test('cross-site POSTs are refused', async () => {
  const res = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.example' }, body: '{}' });
  assert.equal(res.status, 403);
});

test('replays: upload, store, dedupe, list, patch, delete — scoped per user', async () => {
  const a = client(), b = client();
  await a('/api/auth/signup', { method: 'POST', body: { email: 'a@example.com', password: 'password-a' } });
  await b('/api/auth/signup', { method: 'POST', body: { email: 'b@example.com', password: 'password-b' } });

  const file = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(2000, 7)]);
  const sha = createHash('sha256').update(file).digest('hex');

  let r = await a('/api/replays/upload', { method: 'POST', raw: file, headers: { 'x-file-sha256': 'deadbeef' } });
  assert.equal(r.status, 400);
  r = await a('/api/replays/upload', { method: 'POST', raw: file, headers: { 'x-file-sha256': sha.replace(/^./, sha[0] === '0' ? '1' : '0') } });
  assert.equal(r.status, 400, 'hash mismatch is rejected');
  r = await a('/api/replays/upload', { method: 'POST', raw: file, headers: { 'x-file-sha256': sha, 'content-type': 'application/octet-stream' } });
  assert.equal(r.status, 201); assert.ok(r.data.url); const blobUrl = r.data.url;

  r = await a('/api/replays', { method: 'POST', body: { sha256: sha, file_name: '20260911_1225_GB48_FV215b_183.wotbreplay', file_size: file.length, blob_url: blobUrl, parser_version: 'test', parsed } });
  assert.equal(r.status, 201); assert.equal(r.data.existing, false);
  const id = r.data.replay.id;
  assert.equal(r.data.replay.max_shot, 1204); assert.equal(r.data.replay.total_damage, 1548); assert.equal(r.data.replay.kills, 1);
  assert.equal(r.data.replay.status, 'new'); assert.equal(r.data.replay.shots.length, 3);
  assert.match(r.data.replay.battle_time, /^2026-09-11T/);

  r = await a('/api/replays', { method: 'POST', body: { sha256: sha, file_name: 'copy.wotbreplay', file_size: file.length, parsed } });
  assert.equal(r.status, 200); assert.equal(r.data.existing, true); assert.equal(r.data.replay.id, id);

  r = await a('/api/replays'); assert.equal(r.data.replays.length, 1);
  r = await b('/api/replays'); assert.equal(r.data.replays.length, 0, 'other users cannot see it');
  r = await b(`/api/replays/${id}`); assert.equal(r.status, 404);
  r = await b(`/api/replays/${id}`, { method: 'DELETE' }); assert.equal(r.status, 404);

  r = await a(`/api/replays/${id}`, { method: 'PATCH', body: { status: 'bogus' } }); assert.equal(r.status, 400);
  r = await a(`/api/replays/${id}`, { method: 'PATCH', body: { status: 'shortlisted', note: 'record this one' } });
  assert.equal(r.status, 200); assert.equal(r.data.replay.status, 'shortlisted'); assert.equal(r.data.replay.note, 'record this one');
  r = await a(`/api/replays/${id}`); assert.equal(r.data.replay.status, 'shortlisted');

  r = await a('/api/replays', { method: 'POST', body: { sha256: 'zz', file_name: 'x', file_size: 1, parsed } }); assert.equal(r.status, 400);

  r = await a(`/api/replays/${id}`, { method: 'DELETE' }); assert.equal(r.status, 200);
  r = await a('/api/replays'); assert.equal(r.data.replays.length, 0);
});

test('tank table is per user', async () => {
  const c = client();
  await c('/api/auth/signup', { method: 'POST', body: { email: 't@example.com', password: 'password-t' } });
  let r = await c('/api/tanks'); assert.equal(r.data.tanks, null);
  const tanks = [{ tank_id: 9297, name: 'FV215b 183', max_roll: { AP: 1187, HESH: 1512, HE: 1737 } }];
  r = await c('/api/tanks', { method: 'PUT', body: { tanks } }); assert.equal(r.status, 200);
  r = await c('/api/tanks'); assert.deepEqual(r.data.tanks, tanks);
  r = await c('/api/tanks', { method: 'PUT', body: { tanks: 'nope' } }); assert.equal(r.status, 400);
  r = await c('/api/tanks', { method: 'PUT', body: { tanks: null } }); assert.equal(r.status, 200);
  r = await c('/api/tanks'); assert.equal(r.data.tanks, null);
});

test('client upload token exchange requires a session', async () => {
  const c = client();
  let r = await c('/api/replays/client-upload', { method: 'POST', body: { type: 'blob.generate-client-token', payload: { pathname: 'replays/1/x.wotbreplay' } } });
  assert.equal(r.status, 401);
  await c('/api/auth/signup', { method: 'POST', body: { email: 'u@example.com', password: 'password-u' } });
  r = await c('/api/replays/client-upload', { method: 'POST', body: { type: 'blob.generate-client-token', payload: { pathname: 'replays/1/x.wotbreplay' } } });
  assert.equal(r.status, 200); assert.ok(r.data.clientToken);
});

// The web app's side of the WoTInspector finder: a run stores its hits in the database, the page's
// API lists them, and the refresh route is guarded (cron secret / sign-in + cooldown).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.BLITZCLIP_FAKE_DB = '1';
const { makeServer } = await import('./server.js');
const { refresh, listCandidates, lastRun, MANUAL_COOLDOWN_MS } = await import('../lib/wotinspector-db.js');
const { makeWiClient } = await import('../service/scrape-wotinspector.js');
const fakedb = await import('../lib/fakedb.js');

let base, server;
before(async () => { fakedb._reset(); server = makeServer(); await new Promise(r => server.listen(0, r)); base = `http://localhost:${server.address().port}`; });
after(() => server.close());

// One FV215b 183 battle with a 1500 premium-HE hit (99 % of 1513) and one under the damage floor.
function fakeWi() {
  const seen = [];
  const fetchImpl = async url => {
    url = String(url); seen.push(url);
    const json = o => new Response(JSON.stringify(o));
    if (url.includes('page=1')) return json({ next: null, results: [
      { id: 'big', vehicle_id: 9297, damage_made: 2400, enemies_destroyed: 1, player_name: 'sam' },
      { id: 'small', vehicle_id: 9297, damage_made: 300, enemies_destroyed: 0, player_name: 'kim' },
    ] });
    if (url.endsWith('/big/')) return json({ id: 'big', protagonist: 2, battle: {
      players_data: [{ dbid: 2, entity_id: 100, vehicle_id: 9297, gun_id: 1, name: 'sam' }, { dbid: 3, entity_id: 300, vehicle_id: 9297, name: 'v', hitpoints_left: 600, killed_by: 0 }],
      shots: [{ time: 40, shooter: 100, target: 300, damage: 1500, nominal_damage: 1210, ammo_type: 3, is_premium_ammo: true }] } });
    if (url.includes('page=')) return json({ next: null, results: [] });
    return new Response('{}', { status: 404 });
  };
  return { fetchImpl, seen };
}

test('a run stores its hits and the run; the API lists them, max rolls first', async () => {
  const { fetchImpl, seen } = fakeWi();
  const res = await refresh({ trigger: 'cron', client: makeWiClient({ fetchImpl, rps: 1e6 }) });
  assert.equal(res.ran, true);
  assert.deepEqual([res.run.stats.analysed, res.run.stats.hits, res.run.stats.skipped], [1, 1, 1]);
  assert.ok(!seen.some(u => u.includes('/small/')));
  const [c] = await listCandidates();
  assert.deepEqual([c.id, c.tank, c.best_roll.damage, c.max_roll, c.view_url], ['big', 'FV215b (183)', 1500, true, 'https://replays.wotinspector.com/en/blitz/view/big/']);
  assert.ok((await lastRun()).finished_at);

  const r = await (await fetch(base + '/api/wotinspector')).json();
  assert.deepEqual(r.candidates.map(x => x.id), ['big']);
  assert.equal(r.last_run.trigger, 'cron');

  // a second run fetches only the list page: both replays are remembered
  const again = fakeWi();
  await refresh({ trigger: 'cron', client: makeWiClient({ fetchImpl: again.fetchImpl, rps: 1e6 }) });
  assert.deepEqual(again.seen.map(u => new URL(u).pathname), ['/v2/replays/']);
});

test('refresh is guarded: cron needs the secret, "Check now" needs sign-in and waits out the cooldown', async () => {
  process.env.CRON_SECRET = 's3cret';
  assert.equal((await fetch(base + '/api/wotinspector/refresh')).status, 401);
  assert.equal((await fetch(base + '/api/wotinspector/refresh', { headers: { authorization: 'Bearer nope' } })).status, 401);
  delete process.env.CRON_SECRET;
  assert.equal((await fetch(base + '/api/wotinspector/refresh', { headers: { 'user-agent': 'curl/8' } })).status, 401);
  assert.equal((await fetch(base + '/api/wotinspector/refresh', { method: 'POST', headers: { origin: base } })).status, 401);

  const signup = await fetch(base + '/api/auth/signup', { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ email: 'wi@example.com', password: 'correct horse' }) });
  const cookie = signup.headers.getSetCookie()[0].split(';')[0];
  const res = await fetch(base + '/api/wotinspector/refresh', { method: 'POST', headers: { origin: base, cookie } });
  assert.equal(res.status, 429); // the cron just ran
  assert.match((await res.json()).reason, /try again in \d+ min/);

  // after the cooldown a manual check runs (no network here: the fake client answers)
  const t0 = Date.now();
  fakedb._setNow(() => t0);
  const later = await refresh({ trigger: 'manual', client: makeWiClient({ fetchImpl: fakeWi().fetchImpl, rps: 1e6 }), now: () => t0 + MANUAL_COOLDOWN_MS + 1000 });
  fakedb._setNow(null);
  assert.equal(later.ran, true);
});

test('a WoTInspector that never answers still ends the run inside its budget, and the run is recorded', async () => {
  const hang = (url, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason)));
  const t = Date.now();
  const res = await refresh({ trigger: 'cron', client: makeWiClient({ fetchImpl: hang, rps: 1e6, retryDelay: 1 }), budgetMs: 300, log: () => {} });
  assert.ok(Date.now() - t < 2000, 'returned well before a function timeout');
  assert.equal(res.ran, true);
  assert.match(res.run.stats.stopped, /no answer|no time left|out of time/);
  assert.ok((await lastRun()).finished_at);
});

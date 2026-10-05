import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseReplay } from '../lib/replay-parser.js';
import { buildTankIndex, gunFor, hasClipGun, bestRoll, oneClipKills } from '../lib/highlights.js';
import { prefilter, analyse, run, makeWiClient, normSummary, parseArgs } from '../service/scrape-wotinspector.js';
import { buildReplay, makeReplay, packet, sub20, hp, hit, ev, AUTHOR } from './fixture.js';

// A clip tank (3-shell autoloader on its top gun, single-shot alternate) and the targets it meets.
const SHARED = [
  { tank_id: 5000, name: 'Clipper', hp: 1500, gun: 'Auto 100', gun_type: 'autoloader', clip: 3, clip_reload: 20, gun_id: 77, max_roll: { AP: 300, APCR: 300, HE: 400 },
    guns: [{ name: 'Single 90', gun_type: 'single', clip: 1, gun_id: 76, max_roll: { AP: 250, APCR: 250, HE: 330 } }] },
  { tank_id: 9297, name: 'FV215b 183', hp: 2100, gun: '183 mm L4', gun_type: 'single', clip: 1, gun_id: 1, max_roll: { AP: 1187, 'HE (prem)': 1512, HE: 1737 } },
  { tank_id: 6000, name: 'Target', hp: 900, gun_type: 'single', clip: 1, max_roll: { AP: 200 } },
  { tank_id: 6001, name: 'Small target', hp: 700, gun_type: 'single', clip: 1, max_roll: { AP: 200 } },
];
const tanks = buildTankIndex(SHARED);

// Author shots: [clock, victim, damage, hpAfter, slot]. Emits the hit record, HP update and the
// cumulative damage event the parser pairs them with.
function authorShots(list) {
  let cum = 0; const out = [];
  for (const [clock, victim, damage, hpAfter, slot = 0] of list) {
    cum += damage;
    out.push(hit(clock, AUTHOR, victim, 3, 0x0c | slot, damage, true), hp(clock, victim, hpAfter, AUTHOR, false));
    if (hpAfter === 0) out.push(ev(clock + 0.1, 3, 1));
    out.push(ev(clock + 0.1, 1, cum));
  }
  return out;
}
const byClock = pkts => pkts.map(p => [p.readFloatLE(8), p]).sort((a, b) => a[0] - b[0]).map(x => x[1]);

function clipReplay() {
  return buildReplay({ playerVehicleName: 'X1_Clipper', vehicleCompDescriptor: 5000, mapName: 'mines', playerName: 'alex', battleDuration: 300 }, byClock([
    packet(0.5, sub20),
    hp(5, 200, 900, 0, false), hp(5, 300, 900, 0, false), hp(5, 202, 900, 0, false), hp(5, 204, 500, 0, false),
    hp(40, 300, 800, 400, false), // someone else chips 300 first
    ...authorShots([
      [30, 200, 400, 500, 2], [32.5, 200, 300, 200, 0], [35, 200, 200, 0, 0],   // ✓ 100-to-0 in three, the first a max-roll HE
      [45, 300, 300, 500], [47, 300, 300, 200], [49, 300, 200, 0],               // ✗ not from full HP
      [60, 201, 225, 675], [62, 201, 225, 450], [64, 201, 225, 225], [66, 201, 225, 0], // ✗ four shots > clip
      [100, 202, 300, 600], [102, 202, 300, 300], [132, 202, 300, 0],            // ✗ 30 s gap — a reload happened
      [150, 203, 350, 350, 2], [152, 203, 350, 0, 2],                                  // ✓ no sighting; start recovered from the hit = 700
      [170, 204, 250, 250], [172, 204, 250, 0],                                  // ✗ was at 500 / 900 when the author found it
    ]),
  ]));
}
const VICTIMS = new Map([[200, 900], [300, 900], [201, 900], [202, 900], [203, 700], [204, 900]]);
const toAb = b => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);

test('gunFor: override beats the replay gun, which beats the table', () => {
  assert.equal(gunFor(tanks.get(5000)).source, 'table');
  assert.equal(gunFor(tanks.get(5000)).clip, 3);
  const alt = gunFor(tanks.get(5000), { gunId: 76 });
  assert.deepEqual([alt.name, alt.gun_type, alt.clip, alt.source], ['Single 90', 'single', 1, 'replay']);
  // a partial personal override marks the tank's gun as a 4-shell autoloader whatever the replay mounted
  const withOv = buildTankIndex(SHARED, [{ tank_id: 5000, gun_type: 'autoloader', clip: 4 }]);
  const ov = gunFor(withOv.get(5000), { gunId: 76 });
  assert.deepEqual([ov.clip, ov.source, ov.max_roll.HE], [4, 'override', 400]);
  // a manual table entry with a gun type is an override too
  assert.equal(gunFor({ tank_id: 1, manual: true, gun_type: 'single', max_roll: { AP: 1 } }, { gunId: 9 }).source, 'override');
  // no gun type anywhere → treated as single-shot, marked unknown
  const unk = gunFor({ tank_id: 2, name: 'old', max_roll: { AP: 100 } });
  assert.deepEqual([unk.gun_type, unk.clip, unk.source], ['single', 1, 'unknown']);
  assert.equal(hasClipGun(tanks.get(5000)), true);
  assert.equal(hasClipGun(tanks.get(9297)), false);
  assert.equal(hasClipGun(buildTankIndex(SHARED, [{ tank_id: 5000, gun_type: 'single', clip: 1 }]).get(5000)), false);
});

test('one-clip 100-to-0: full HP, within one clip, nobody else involved', async () => {
  const r = await parseReplay('c.wotbreplay', toAb(clipReplay()), { raw: true });
  assert.equal(r.raw.author, AUTHOR);
  const kills = oneClipKills(r.raw, gunFor(tanks.get(5000)), { victimHp: VICTIMS });
  assert.deepEqual(kills.map(k => [k.victim, k.shots, k.start_hp, k.verified]), [[200, 3, 900, true], [203, 2, 700, true]]);
  assert.equal(kills[0].duration, 5);
  // without the players' HP they are unverified, and damage taken out of the author's sight can't be
  // ruled out: 204 (found at 500 / 900) slips through — which is why the scraper passes victimHp
  assert.deepEqual(oneClipKills(r.raw, gunFor(tanks.get(5000))).map(k => [k.victim, k.verified]), [[200, false], [203, false], [204, false]]);
  // a single-shot gun never makes one-clip kills
  assert.deepEqual(oneClipKills(r.raw, gunFor(tanks.get(5000), { gunId: 76 })), []);
  // a longer clip lets the four-shot kill through
  assert.deepEqual(oneClipKills(r.raw, { ...gunFor(tanks.get(5000)), clip: 4 }, { victimHp: VICTIMS }).map(k => k.victim), [200, 201, 203]);
});

test('bestRoll scores each shot against the shell it fired', async () => {
  const r = await parseReplay('c.wotbreplay', toAb(clipReplay()), { raw: true });
  const best = bestRoll(r.shots, gunFor(tanks.get(5000)));
  assert.deepEqual([best.damage, best.pct, best.shell, best.known], [400, 100, 'HE', true]);
  const fv = await parseReplay('f.wotbreplay', toAb(makeReplay()));
  const b2 = bestRoll(fv.shots, gunFor(tanks.get(9297)));
  assert.equal(b2.damage, 1204);
  assert.equal(b2.shell, 'HE (prem)');
  assert.equal(Math.round(b2.pct), 80);
});

test('prefilter: single-shot tanks need the damage threshold; clip tanks also pass on a kill', () => {
  const s = (tank_id, damage, kills = 0) => normSummary({ id: 'x', vehicle_descr: tank_id, damage_made: damage, enemies_destroyed: kills });
  // FV215b 183: floor = max(1000, 95% of 1187) = 1128
  assert.equal(prefilter(s(9297, 1100), tanks).keep, false);
  assert.match(prefilter(s(9297, 1100), tanks).skip, /1100 < 1128/);
  assert.deepEqual(prefilter(s(9297, 1128), tanks).why, ['roll']);
  assert.equal(prefilter(s(9297, 900, 3), tanks).keep, false); // kills don't matter for a single-shot gun
  assert.deepEqual(prefilter(s(5000, 400, 1), tanks).why, ['clip']);
  assert.equal(prefilter(s(5000, 400, 0), tanks).keep, false);
  assert.deepEqual(prefilter(s(9297, 600), tanks, { minDamage: 500, minRollPct: 50 }).why, ['roll']);
  assert.equal(prefilter(s(12345, 2000), tanks).keep, true); // unknown tank: absolute floor only
});

// ---------- the scraper end to end, against a fake WoTInspector ----------

function fakeWi() {
  const files = { a: clipReplay(), b: makeReplay() };
  const list = [
    { id: 'a', vehicle_descr: 5000, damage_made: 2350, enemies_destroyed: 6, player_name: 'alex', download_url: 'https://dl.example/a' },
    { id: 'b', vehicle_descr: 9297, damage_made: 1800, enemies_destroyed: 1, player_name: 'sam', download_url: 'https://dl.example/b' },
    { id: 'c', vehicle_descr: 9297, damage_made: 700, enemies_destroyed: 0, player_name: 'kim', download_url: 'https://dl.example/c' },
  ];
  const details = {
    a: { _id: 'a', p: 1, d: [{ id: 1, ei: AUTHOR, vi: 5000, gi: 77, n: 'alex' }, ...[...VICTIMS].map(([e, hpFull], i) => ({ id: 10 + i, ei: e, vi: hpFull === 700 ? 6001 : 6000, n: 'enemy' + e }))] },
    b: { id: 'b', protagonist: 2, players_data: [{ dbid: 2, entity_id: AUTHOR, vehicle_descr: 9297, gun_id: 1 }] },
  };
  const seen = [];
  let throttled = false;
  const fetchImpl = async url => {
    url = String(url); seen.push(url);
    const json = (o, status = 200, headers = {}) => new Response(JSON.stringify(o), { status, headers });
    if (url.includes('page=1')) {
      if (!throttled) { throttled = true; return json({}, 429, { 'retry-after': '0.001' }); }
      return json({ next: null, results: list });
    }
    const m = url.match(/replays\/(\w+)\/$/); if (m) return json(details[m[1]]);
    const f = url.match(/dl\.example\/(\w+)/); if (f) return new Response(files[f[1]]);
    return json({}, 404);
  };
  return { fetchImpl, seen };
}

test('scraper: lists, prefilters, downloads candidates, scores them, and remembers what it saw', async () => {
  const { mkdtemp, readFile, readdir } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const out = await mkdtemp(join(tmpdir(), 'wi-'));
  const { fetchImpl, seen } = fakeWi();
  const client = makeWiClient({ fetchImpl, rps: 1e6, retryDelay: 1 });
  const res = await run({ client, tanks, out, pages: 3, minRollPct: 75 }); // the FV's 1204 HESH is 80 % of 1512
  assert.deepEqual(res.stats, { listed: 3, already: 0, skipped: 1, analysed: 2, hits: 2, errors: 0 });
  assert.ok(!seen.some(u => u.includes('/c')), 'the replay under threshold is never fetched');
  const [b, a] = res.candidates; // max rolls rank first, biggest damage first
  assert.equal(b.id, 'b'); assert.equal(b.best_roll.damage, 1204); assert.equal(b.max_roll, true); assert.equal(b.gun.source, 'replay');
  assert.equal(a.id, 'a'); assert.equal(a.gun.clip, 3);
  assert.deepEqual(a.one_clip.map(k => [k.victim_name, k.victim_tank, k.verified]), [['enemy200', 'Target', true], ['enemy203', 'Small target', true]]);
  assert.deepEqual((await readdir(join(out, 'replays'))).sort(), ['a_Clipper.wotbreplay', 'b_FV215b_183.wotbreplay']);
  assert.deepEqual(Object.keys(JSON.parse(await readFile(join(out, 'seen.json'), 'utf8'))).sort(), ['a', 'b', 'c']);

  // second run: nothing is fetched again except the list page
  const again = makeWiClient({ fetchImpl, rps: 1e6, retryDelay: 1 });
  const before = seen.length;
  const res2 = await run({ client: again, tanks, out, pages: 3 });
  assert.equal(res2.stats.already, 3);
  assert.equal(seen.length - before, 1);
  assert.equal(res2.candidates.length, 2);
});

test('parseArgs', () => {
  const o = parseArgs(['--pages', '2', '--min-damage', '1500', '--filter', 'vehicle_id=9297', '--overrides', 'mine.json', '--dry-run']);
  assert.deepEqual([o.pages, o.minDamage, o.filters, o.overridesPath, o.dryRun, o.minRollPct], [2, 1500, { vehicle_id: '9297' }, 'mine.json', true, 95]);
  assert.throws(() => parseArgs(['--nope']), /Unknown argument/);
});

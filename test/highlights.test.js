import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseReplay } from '../lib/replay-parser.js';
import { buildTankIndex, gunFor, hasClipGun, bestRoll, oneClipKills, bestRollFromShots, oneClipKillsFromShots, killsFromPlayers, maxRollOf } from '../lib/highlights.js';
import { prefilter, run, makeWiClient, normSummary, normDetails, listUrl, parseArgs } from '../service/scrape-wotinspector.js';
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

// WoTInspector's per-shot list: [time, shooter, target, damage, nominal, ammo_type, premium].
const shot = ([time, shooter, target, damage, nominal, ammo_type = 0, premium = false]) =>
  ({ time, shooter, target, damage, nominal_damage: nominal, has_damage: damage > 0, ammo_type, is_premium_ammo: premium, shell_id: 1 });
const OTHER = 300;
// The clipper's battle: 200 and 203 are clean one-clips; 201 was chipped first by someone else; 202
// took four hits (clip 3); 204 had a reload-length gap; 205 was finished by fire (shots don't add up).
const CLIP_SHOTS = [
  [10, AUTHOR, 200, 300, 240], [11.5, AUTHOR, 200, 300, 240], [13, AUTHOR, 200, 300, 240],
  [20, OTHER, 201, 100, 200], [21, AUTHOR, 201, 300, 240], [22, AUTHOR, 201, 300, 240], [23, AUTHOR, 201, 200, 240],
  [30, AUTHOR, 202, 200, 240], [31, AUTHOR, 202, 200, 240], [32, AUTHOR, 202, 200, 240], [33, AUTHOR, 202, 300, 240],
  [60, AUTHOR, 203, 350, 300, 3], [61, AUTHOR, 203, 350, 300, 3],
  [70, AUTHOR, 204, 300, 240], [95, AUTHOR, 204, 300, 240], [96, AUTHOR, 204, 300, 240],
  [100, AUTHOR, 205, 300, 240], [101, AUTHOR, 205, 300, 240],
].map(shot);
const CLIP_PLAYERS = [
  { dbid: 1, entity_id: AUTHOR, vehicle_id: 5000, gun_id: 77, name: 'alex', hitpoints_left: 400, killed_by: 0 },
  ...[200, 201, 202, 203, 204, 205].map((e, i) => ({ dbid: 10 + i, entity_id: e, vehicle_id: e === 203 ? 6001 : 6000, gun_id: 1, name: 'enemy' + e, hitpoints_left: 0, killed_by: AUTHOR })),
];
// The FV's battle: a 1204 HESH kill shot, a 0-damage event at listed 950 (the kind the replay parser
// once read as a 1020 hit) and someone else's big hit — only the first may score.
const FV_SHOTS = [[40, AUTHOR, OTHER, 0, 950], [41, AUTHOR, OTHER, 1204, 1210, 3, true], [42, 400, AUTHOR, 2000, 1000]].map(shot);
const FV_PLAYERS = [
  { dbid: 2, entity_id: AUTHOR, vehicle_id: 9297, gun_id: 1, name: 'sam', hitpoints_left: 0, killed_by: 400 },
  { dbid: 3, entity_id: OTHER, vehicle_id: 6000, gun_id: 1, name: 'victim', hitpoints_left: 0, killed_by: AUTHOR },
];

test('bestRollFromShots: damage over 1.25 × listed damage, own shells only, kill shots are lower bounds', () => {
  const players = FV_PLAYERS.map(p => ({ entity: p.entity_id, hp_left: p.hitpoints_left, killed_by: p.killed_by }));
  const kills = killsFromPlayers(players);
  const r = bestRollFromShots(FV_SHOTS, AUTHOR, { gun: gunFor(tanks.get(9297)), kills });
  assert.deepEqual([r.damage, r.max, r.shell, r.premium, r.atLeast, r.over_max], [1204, 1513, 'HE (prem)', true, true, 0]);
  assert.equal(Math.round(r.pct * 10) / 10, 79.6);
  assert.equal(bestRollFromShots([shot([1, AUTHOR, 9, 0, 950])], AUTHOR), null); // a 0-damage event never scores
  assert.deepEqual([bestRollFromShots(CLIP_SHOTS, AUTHOR).shell, bestRollFromShots(CLIP_SHOTS.filter(s => s.ammo_type === 3), AUTHOR).shell], ['AP', 'HE']); // no gun: named by ammo type
  assert.deepEqual([maxRollOf(1210), maxRollOf(310)], [1513, 388]);
  // above its max roll isn't a roll: left out and counted
  const boosted = bestRollFromShots([shot([1, AUTHOR, 9, 465, 260, 2]), shot([2, AUTHOR, 9, 300, 260, 2])], AUTHOR);
  assert.deepEqual([boosted.damage, boosted.over_max], [300, 1]);
});

test('oneClipKillsFromShots: whole kill by the shooter, within one clip, no reload gap', () => {
  const kills = killsFromPlayers(CLIP_PLAYERS.map(p => ({ entity: p.entity_id, hp_left: p.hitpoints_left, killed_by: p.killed_by })));
  const gun = gunFor(tanks.get(5000));
  const k = oneClipKillsFromShots(CLIP_SHOTS, AUTHOR, gun, { kills, victimHp: VICTIMS });
  assert.deepEqual(k.map(x => [x.victim, x.shots, x.damage, x.verified]), [[200, 3, 900, true], [203, 2, 700, true], [205, 2, 600, false]]);
  assert.deepEqual(oneClipKillsFromShots(CLIP_SHOTS, AUTHOR, { ...gun, clip: 4 }, { kills, victimHp: VICTIMS }).map(x => x.victim), [200, 202, 203, 205]);
  assert.deepEqual(oneClipKillsFromShots(CLIP_SHOTS, AUTHOR, gun, { victimHp: VICTIMS }), []); // nobody known destroyed
  assert.deepEqual(oneClipKillsFromShots(CLIP_SHOTS, AUTHOR, gunFor(tanks.get(9297))), []); // single-shot gun
});

function fakeWi() {
  const files = { a: new Uint8Array([1, 2, 3]), b: new Uint8Array([4, 5]) };
  // Shapes as the live API returns them: list items carry vehicle_descr/vehicle_id but no download
  // link; details nest players and shots under battle and carry download_url at the top.
  const list = [
    { id: 'a', platform: 'blitz', vehicle_id: 5000, vehicle_descr: 5000, damage_made: 2350, enemies_destroyed: 6, player_name: 'alex' },
    { id: 'b', platform: 'blitz', vehicle_id: 9297, vehicle_descr: 9297, damage_made: 1800, enemies_destroyed: 1, player_name: 'sam' },
    { id: 'c', platform: 'blitz', vehicle_id: 9297, vehicle_descr: 9297, damage_made: 700, enemies_destroyed: 0, player_name: 'kim' },
  ];
  const details = {
    a: { id: 'a', protagonist: 1, download_url: 'https://dl.example/a', battle: { players_data: CLIP_PLAYERS, shots: CLIP_SHOTS } },
    b: { id: 'b', protagonist: 2, download_url: 'https://dl.example/b', battle: { players_data: FV_PLAYERS, shots: FV_SHOTS } },
  };
  const seen = [];
  let throttled = false;
  const fetchImpl = async url => {
    url = String(url); seen.push(url);
    const json = (o, status = 200, headers = {}) => new Response(JSON.stringify(o), { status, headers });
    if (url.includes('/v2/replays/?') && url.includes('page=1')) {
      assert.ok(url.includes('platform=blitz'), 'the list asks for Blitz only');
      if (!throttled) { throttled = true; return json({}, 429, { 'retry-after': '0.001' }); }
      return json({ next: null, results: list });
    }
    const m = url.match(/\/v2\/replays\/(\w+)\/$/); if (m) return json(details[m[1]]);
    const f = url.match(/dl\.example\/(\w+)/); if (f) return new Response(files[f[1]]);
    return json({}, 404);
  };
  return { fetchImpl, seen };
}

test('scraper: lists, prefilters, scores candidates from their details, and remembers what it saw', async () => {
  const { mkdtemp, readFile, readdir } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const out = await mkdtemp(join(tmpdir(), 'wi-'));
  const { fetchImpl, seen } = fakeWi();
  const client = makeWiClient({ fetchImpl, rps: 1e6, retryDelay: 1 });
  const res = await run({ client, tanks, out, pages: 3, minRollPct: 75 }); // the FV's 1204 HESH is 80 % of 1513
  assert.deepEqual(res.stats, { listed: 3, already: 0, skipped: 1, analysed: 2, hits: 2, errors: 0 });
  assert.ok(!seen.some(u => u.includes('/c/')), 'the replay under threshold is never fetched');
  assert.ok(!seen.some(u => u.includes('dl.example')), 'nothing is downloaded by default');
  const [b, a] = res.candidates; // max rolls rank first, biggest damage first
  assert.equal(b.id, 'b'); assert.equal(b.best_roll.damage, 1204); assert.equal(b.best_roll.atLeast, true); assert.equal(b.max_roll, true);
  assert.deepEqual([b.gun.name, b.gun.source, b.file, b.download_url], ['183 mm L4', 'replay', null, 'https://dl.example/b']);
  assert.equal(a.id, 'a'); assert.equal(a.gun.clip, 3); assert.equal(a.gun.name, 'Auto 100');
  assert.deepEqual(a.one_clip.map(k => [k.victim_name, k.victim_tank, k.verified]), [['enemy200', 'Target', true], ['enemy203', 'Small target', true], ['enemy205', 'Target', false]]);
  assert.deepEqual(Object.keys(JSON.parse(await readFile(join(out, 'seen.json'), 'utf8'))).sort(), ['a', 'b', 'c']);
  assert.deepEqual(await readdir(out), ['candidates.json', 'seen.json']);

  // second run: nothing is fetched again except the list page
  const again = makeWiClient({ fetchImpl, rps: 1e6, retryDelay: 1 });
  const before = seen.length;
  const res2 = await run({ client: again, tanks, out, pages: 3 });
  assert.equal(res2.stats.already, 3);
  assert.equal(seen.length - before, 1);
  assert.equal(res2.candidates.length, 2);

  // --download also saves each hit's replay
  const out2 = await mkdtemp(join(tmpdir(), 'wi-'));
  const res3 = await run({ client: makeWiClient({ fetchImpl, rps: 1e6, retryDelay: 1 }), tanks, out: out2, pages: 3, minRollPct: 75, download: true });
  assert.deepEqual((await readdir(join(out2, 'replays'))).sort(), ['a_Clipper.wotbreplay', 'b_FV215b_183.wotbreplay']);
  assert.deepEqual(res3.candidates.map(c => c.file), ['b_FV215b_183.wotbreplay', 'a_Clipper.wotbreplay']);
});

test('normDetails: real nested players, and the short-alias shape as a fallback', () => {
  const real = normDetails({ id: 'x', protagonist: 7, vehicle_id: 9297, vehicle_descr: 9297, download_url: 'https://dl/x', battle: { players_data: [{ dbid: 7, entity_id: 42, vehicle_id: 9297, gun_id: 13908, name: 'me' }] } });
  assert.deepEqual([real.tank_id, real.download_url, real.me], [9297, 'https://dl/x', { dbid: 7, entity: 42, tank_id: 9297, gun_id: 13908, name: 'me', hp_left: null, killed_by: 0 }]);
  const short = normDetails({ _id: 'y', p: 1, dlu: 'https://dl/y', d: [{ id: 1, ei: 5, vi: 5000, gi: 77, n: 'a' }] });
  assert.deepEqual([short.id, short.download_url, short.me.entity, short.me.tank_id, short.me.gun_id], ['y', 'https://dl/y', 5, 5000, 77]);
  assert.equal(listUrl(2, { vehicle_id: 9297 }), 'https://api.wotinspector.com/v2/replays/?page=2&platform=blitz&vehicle_id=9297');
});

test('parseArgs', () => {
  const o = parseArgs(['--pages', '2', '--min-damage', '1500', '--filter', 'vehicle_id=9297', '--overrides', 'mine.json', '--dry-run']);
  assert.deepEqual([o.pages, o.minDamage, o.filters, o.overridesPath, o.dryRun, o.minRollPct], [2, 1500, { vehicle_id: '9297' }, 'mine.json', true, 95]);
  assert.throws(() => parseArgs(['--nope']), /Unknown argument/);
});

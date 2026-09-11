import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTable, makeClient, maxRoll, mergeManual, parseArgs, shellMap, pickTopGun, WgError } from '../service/fetch-tanks.js';

// A tiny fake of api.wotblitz.eu: two tanks, one with a stock and a top gun and two turrets.
const shells = (...pairs) => pairs.map(([type, damage]) => ({ type, damage, penetration: 100 }));
const VEHICLES = {
  9297: { tank_id: 9297, name: 'FV215b 183', nation: 'uk', tier: 10, type: 'AT-SPG', is_premium: false,
    default_profile: { hp: 2100, gun: { name: '183 mm L4', tier: 10 }, shells: shells(['ARMOR_PIERCING', 950], ['HIGH_EXPLOSIVE', 1210], ['HIGH_EXPLOSIVE', 1390]) },
    modules_tree: { 1: { module_id: 1, name: '183 mm L4', type: 'vehicleGun', is_default: true, price_xp: 0 }, 2: { module_id: 2, name: 'FV215b 183', type: 'vehicleTurret', is_default: true, price_xp: 0 } } },
  10497: { tank_id: 10497, name: 'KV-2', nation: 'ussr', tier: 6, type: 'heavyTank', is_premium: false,
    default_profile: { hp: 860, gun: { name: '107 mm ZiS-6', tier: 7 }, shells: shells(['ARMOR_PIERCING', 300], ['ARMOR_PIERCING_CR', 300], ['HIGH_EXPLOSIVE', 360]) },
    modules_tree: {
      10: { module_id: 10, name: '107 mm ZiS-6', type: 'vehicleGun', is_default: false, price_xp: 4000 },
      11: { module_id: 11, name: '152 mm M-10', type: 'vehicleGun', is_default: true, price_xp: 0 },
      20: { module_id: 20, name: 'KV-2 stock', type: 'vehicleTurret', is_default: true, price_xp: 0 },
      21: { module_id: 21, name: 'KV-2 top', type: 'vehicleTurret', is_default: false, price_xp: 2000 },
    } },
};
// Profiles by tank/gun/turret; a missing pair is what the real API answers INCOMPATIBLE_MODULE_IDS for
// (the 152 mm only mounts on the top turret, the 107 mm only on the stock one).
const M10 = shells(['ARMOR_PIERCING', 700], ['HOLLOW_CHARGE', 700], ['HIGH_EXPLOSIVE', 910]);
const PROFILES = {
  '9297/1/2': { hp: 2100, gun: { name: '183 mm L4', tier: 10 }, shells: VEHICLES[9297].default_profile.shells },
  '10497/10/20': { hp: 860, gun: { name: '107 mm ZiS-6', tier: 7 }, shells: VEHICLES[10497].default_profile.shells },
  '10497/11/21': { hp: 1250, gun: { name: '152 mm M-10', tier: 6 }, shells: M10 },
};

function fakeApi({ failFirst = 0, appId = 'good' } = {}) {
  const seen = [];
  let failures = 0;
  const ok = data => new Response(JSON.stringify({ status: 'ok', data }), { status: 200 });
  const err = (code, message) => new Response(JSON.stringify({ status: 'error', error: { code, message } }), { status: 200 });
  const fetchImpl = async url => {
    url = new URL(url);
    seen.push(url.pathname + '?' + url.searchParams);
    if (url.searchParams.get('application_id') !== appId) return err(407, 'INVALID_APPLICATION_ID');
    if (failures < failFirst) { failures++; return err(407, 'REQUEST_LIMIT_EXCEEDED'); }
    if (url.pathname === '/wotb/encyclopedia/info/') return ok({ game_version: '11.20.0', vehicle_nations: { uk: 'U.K.', ussr: 'U.S.S.R.' } });
    if (url.pathname === '/wotb/encyclopedia/vehicles/') {
      const nation = url.searchParams.get('nation');
      const only = url.searchParams.get('tank_id')?.split(',').map(Number);
      const data = {};
      for (const v of Object.values(VEHICLES)) if (v.nation === nation && (!only || only.includes(v.tank_id))) data[v.tank_id] = v;
      return ok(data);
    }
    if (url.pathname === '/wotb/encyclopedia/vehicleprofile/') {
      const id = url.searchParams.get('tank_id');
      const key = `${id}/${url.searchParams.get('gun_id')}/${url.searchParams.get('turret_id')}`;
      return PROFILES[key] ? ok({ [id]: { tank_id: Number(id), ...PROFILES[key] } }) : err(404, 'INCOMPATIBLE_MODULE_IDS');
    }
    return err(404, 'METHOD_NOT_FOUND');
  };
  return { fetchImpl, seen };
}

test('max roll is floor(1.25 × alpha), matching the page defaults', () => {
  assert.equal(maxRoll(640), 800); assert.equal(maxRoll(545), 681); assert.equal(maxRoll(910), 1137); assert.equal(maxRoll(950), 1187);
});

test('shell labels follow slot order and are made unique', () => {
  assert.deepEqual(shellMap(VEHICLES[9297].default_profile.shells), { AP: 950, 'HE (prem)': 1210, HE: 1390 });
  assert.deepEqual(shellMap(shells(['ARMOR_PIERCING', 640], ['ARMOR_PIERCING', 545], ['HIGH_EXPLOSIVE', 960]), maxRoll), { AP: 800, 'AP (prem)': 681, HE: 1200 });
  assert.deepEqual(Object.keys(shellMap(shells(['MYSTERY', 1], ['MYSTERY', 2], ['MYSTERY', 3]))), ['MYSTERY', 'MYSTERY (prem)', 'MYSTERY (HE)']);
  assert.deepEqual(Object.keys(shellMap(shells(['HIGH_EXPLOSIVE', 1], ['HOLLOW_CHARGE', 2]))), ['HE', 'HEAT']);
});

test('the scored gun is the one with the biggest standard-shell alpha, then the priciest', () => {
  const derp = { price_xp: 0, gun: { tier: 6 }, shells: shells(['ARMOR_PIERCING', 700]) };
  const top = pickTopGun([{ price_xp: 4000, gun: { tier: 7 }, shells: shells(['ARMOR_PIERCING', 300]) }, derp]);
  assert.equal(top, derp);
  const pricier = { price_xp: 9, shells: shells(['ARMOR_PIERCING', 300]) };
  assert.equal(pickTopGun([{ price_xp: 1, shells: shells(['ARMOR_PIERCING', 300]) }, pricier]), pricier);
});

test('builds the table from the API with top gun and top turret', async () => {
  const { fetchImpl, seen } = fakeApi();
  const client = makeClient({ appId: 'good', fetchImpl, rps: 1000, retryDelay: 1 });
  const { tanks, meta } = await buildTable({ client });
  assert.equal(meta.game_version, '11.20.0');
  assert.equal(tanks.length, 2);
  assert.equal(tanks[0].name, 'FV215b 183'); // tier 10 first

  const kv2 = tanks.find(t => t.tank_id === 10497);
  assert.deepEqual(kv2.max_roll, { AP: 875, HEAT: 875, HE: 1137 });
  assert.deepEqual(kv2.alpha, { AP: 700, HEAT: 700, HE: 910 });
  assert.equal(kv2.gun, '152 mm M-10');
  assert.equal(kv2.hp, 1250);
  assert.equal(kv2.tier, 6);
  assert.equal(kv2.premium, false);
  assert.equal(kv2.note, '700 / 700 / 910 · 152 mm M-10');
  assert.equal(kv2.warning, undefined);
  assert.deepEqual(kv2.guns, [{ name: '107 mm ZiS-6', max_roll: { AP: 375, APCR: 375, HE: 450 }, alpha: { AP: 300, APCR: 300, HE: 360 } }]);
  assert.equal(tanks.find(t => t.tank_id === 9297).guns, undefined);

  const fv = tanks.find(t => t.tank_id === 9297);
  assert.deepEqual(fv.max_roll, { AP: 1187, 'HE (prem)': 1512, HE: 1737 });
  assert.equal(fv.hp, 2100);

  // 1 info + 2 nations + 1×1 + 2×2 gun×turret combinations
  assert.equal(seen.length, 8);
  assert.equal(meta.requests, 8);
});

test('--stock skips the module lookups and says so', async () => {
  const { fetchImpl, seen } = fakeApi();
  const { tanks } = await buildTable({ client: makeClient({ appId: 'good', fetchImpl, rps: 1000, retryDelay: 1 }), stock: true });
  const kv2 = tanks.find(t => t.tank_id === 10497);
  assert.deepEqual(kv2.max_roll, { AP: 375, APCR: 375, HE: 450 });
  assert.equal(kv2.hp, 860);
  assert.match(kv2.note, /stock$/);
  assert.equal(seen.length, 3);
});

test('--tank restricts the table', async () => {
  const { fetchImpl } = fakeApi();
  const { tanks } = await buildTable({ client: makeClient({ appId: 'good', fetchImpl, rps: 1000, retryDelay: 1 }), only: new Set([9297]) });
  assert.deepEqual(tanks.map(t => t.tank_id), [9297]);
});

test('rate-limit errors are retried, a bad application id is not', async () => {
  const { fetchImpl } = fakeApi({ failFirst: 2 });
  const log = [];
  const { tanks } = await buildTable({ client: makeClient({ appId: 'good', fetchImpl, rps: 1000, retryDelay: 1, log: m => log.push(m) }), stock: true });
  assert.equal(tanks.length, 2);
  assert.ok(log.some(m => /REQUEST_LIMIT_EXCEEDED/.test(m)));

  const bad = makeClient({ appId: 'wrong', fetchImpl: fakeApi().fetchImpl, rps: 1000, retryDelay: 1 });
  await assert.rejects(buildTable({ client: bad, stock: true }), e => e instanceof WgError && e.wgMessage === 'INVALID_APPLICATION_ID');
});

test('a failed profile lookup falls back to stock with a warning instead of dropping the tank', async () => {
  const { fetchImpl } = fakeApi();
  const broken = async url => (new URL(url).searchParams.get('gun_id') === '11' ? new Response('boom', { status: 500 }) : fetchImpl(url));
  const { tanks } = await buildTable({ client: makeClient({ appId: 'good', fetchImpl: broken, rps: 1000, retryDelay: 1 }) });
  const kv2 = tanks.find(t => t.tank_id === 10497);
  assert.match(kv2.warning, /HTTP 500/);
  assert.equal(kv2.hp, 860);
});

test('manual entries in the previous file survive a refresh', () => {
  const fresh = [{ tank_id: 1, name: 'A', tier: 5, max_roll: { AP: 1 } }];
  const previous = [{ tank_id: 1, name: 'old A', tier: 5, max_roll: { AP: 9 } }, { tank_id: 26113, name: 'Missing from API', tier: 10, max_roll: { AP: 1000 }, manual: true }];
  const merged = mergeManual(fresh, previous);
  assert.deepEqual(merged.map(t => t.name), ['Missing from API', 'A']);
  assert.equal(mergeManual(fresh, null), fresh);
});

test('argument parsing', () => {
  const o = parseArgs(['--region', 'na', '--stock', '--tank', '9297,14129', '--out', 'x.json', '--app-id', 'k']);
  assert.equal(o.region, 'na'); assert.equal(o.stock, true); assert.deepEqual([...o.tank], [9297, 14129]); assert.equal(o.out, 'x.json'); assert.equal(o.appId, 'k');
  assert.throws(() => parseArgs(['--nope']));
});

test('a gun that mounts on no turret is skipped with a log line, not a failure', async () => {
  const { fetchImpl } = fakeApi();
  const log = [];
  const noM10 = async url => (new URL(url).searchParams.get('gun_id') === '11' ? fetchImpl(String(url).replace('gun_id=11', 'gun_id=99')) : fetchImpl(url));
  const { tanks } = await buildTable({ client: makeClient({ appId: 'good', fetchImpl: noM10, rps: 1000, retryDelay: 1 }), log: m => log.push(m) });
  const kv2 = tanks.find(t => t.tank_id === 10497);
  assert.equal(kv2.gun, '107 mm ZiS-6');
  assert.equal(kv2.warning, undefined);
  assert.ok(log.some(m => /152 mm M-10 fits no turret/.test(m)));
});

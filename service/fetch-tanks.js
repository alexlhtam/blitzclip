#!/usr/bin/env node
// Populate data/tanks.json from Wargaming's World of Tanks Blitz encyclopedia API.
//
//   WG_APPLICATION_ID=… node service/fetch-tanks.js [--region eu] [--out data/tanks.json]
//                                                   [--stock] [--tank 9297,14129] [--concurrency 4]
//
// One entry per vehicle, in the exact shape the page's tank table accepts (tank_id, name,
// max_roll keyed by shell in SLOT order — standard, premium, HE), plus the fields the roadmap
// filters need (tier, nation, type, premium, hp) and the raw alpha per shell.
//
// The encyclopedia's default_profile is the STOCK configuration. Unless --stock is given, the
// script also asks /vehicleprofile/ for every gun × turret combination in the module tree and
// reports the biggest-alpha gun's shells (the gun that makes clips) and the highest HP, keeping
// the other guns in `guns` so a shot can be re-scored against them.
//
// No dependencies; Node 22 (global fetch). Needs a free application id from
// https://developers.wargaming.net — a "mobile" application (a "server" one is bound to fixed
// IPs and answers INVALID_APPLICATION_ID from anywhere else; the old demo id is dead).

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

export const HOSTS = { eu: 'https://api.wotblitz.eu', na: 'https://api.wotblitz.com', asia: 'https://api.wotblitz.asia' };
export const SHELL_LABEL = { ARMOR_PIERCING: 'AP', ARMOR_PIERCING_CR: 'APCR', HOLLOW_CHARGE: 'HEAT', HIGH_EXPLOSIVE: 'HE' };
const SLOT_SUFFIX = [' (std)', ' (prem)', ' (HE)'];
const FALLBACK_NATIONS = ['ussr', 'germany', 'usa', 'china', 'france', 'uk', 'japan', 'european', 'other'];

/** Blitz rolls ±25 %, so the biggest single shot is 1.25 × alpha, rounded down (matches the page defaults). */
export const maxRoll = alpha => Math.floor(alpha * 1.25);

// ---------- WG API client ----------

export class WgError extends Error {
  constructor(code, message, field) { super(`WG API ${code} ${message}${field ? ' (' + field + ')' : ''}`); this.code = code; this.wgMessage = message; }
}

/** Serialise calls to at most `rps` requests per second with `concurrency` in flight; retry the transient errors. */
export function makeClient({ appId, region = 'eu', fetchImpl = globalThis.fetch, concurrency = 4, rps = 8, retryDelay = 500, log = () => {} }) {
  const host = HOSTS[region];
  if (!host) throw new Error(`Unknown region "${region}" — use ${Object.keys(HOSTS).join(', ')}`);
  let inFlight = 0, lastStart = 0;
  const queue = [];
  const gap = 1000 / rps;
  let requests = 0;

  const pump = () => {
    if (!queue.length || inFlight >= concurrency) return;
    const start = Math.max(Date.now(), lastStart + gap); // reserve the slot now so parallel jobs don't burst
    lastStart = start;
    const job = queue.shift();
    inFlight++;
    setTimeout(job, start - Date.now());
  };

  const call = (path, params) => new Promise((resolve, reject) => {
    queue.push(async () => {
      try { resolve(await withRetry(() => once(path, params))); }
      catch (e) { reject(e); }
      finally { inFlight--; pump(); }
    });
    pump();
  });

  async function once(path, params) {
    const url = new URL(`/wotb/${path}/`, host);
    url.searchParams.set('application_id', appId);
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    requests++;
    const res = await fetchImpl(url, { headers: { accept: 'application/json' } });
    if (!res.ok && res.status !== 200) throw Object.assign(new Error(`HTTP ${res.status} from ${url.pathname}`), { transient: res.status >= 500 || res.status === 429 });
    const body = await res.json();
    if (body.status === 'error') {
      const { code, message, field } = body.error || {};
      const transient = message === 'REQUEST_LIMIT_EXCEEDED' || message === 'SOURCE_NOT_AVAILABLE';
      throw Object.assign(new WgError(code, message, field), { transient });
    }
    return body;
  }

  async function withRetry(fn, tries = 5) {
    for (let attempt = 1; ; attempt++) {
      try { return await fn(); }
      catch (e) {
        const transient = e.transient || e.name === 'TypeError'; // TypeError = fetch network failure
        if (!transient || attempt >= tries) throw e;
        const delay = retryDelay * 2 ** attempt;
        log(`  retry ${attempt}/${tries - 1} in ${delay} ms: ${e.message}`);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }

  return { call, get requests() { return requests; } };
}

// ---------- table building ----------

/** Shells in slot order → { AP: 950, "HE (prem)": 1210, HE: 1390 } (labels made unique by slot). */
export function shellMap(shells, fn = d => d) {
  const bases = shells.map((s, i) => SHELL_LABEL[s.type] || s.type || `shell ${i + 1}`);
  const out = {};
  shells.forEach((s, i) => {
    // When a type appears twice the bare name goes to its natural slot — the HE slot for HE (HESH
    // also reports HIGH_EXPLOSIVE), the standard slot for everything else (a premium AP on a KV-2)
    // — and the other occurrences are marked by slot.
    let label = bases[i];
    const home = label === 'HE' ? bases.lastIndexOf(label) : bases.indexOf(label);
    if (bases.indexOf(label) !== bases.lastIndexOf(label) && i !== home) label += SLOT_SUFFIX[i] ?? ` ${i + 1}`;
    while (label in out) label += '*';
    out[label] = fn(Number(s.damage));
  });
  return out;
}

const modulesOf = (v, type) => Object.values(v.modules_tree || {}).filter(m => m && m.type === type);

/**
 * The gun the table scores against: the one with the biggest standard-shell alpha — that's the gun
 * that makes clips, and on derp tanks (KV-2, T49) it is the stock one, so "most XP" would pick wrong.
 * Ties → most XP to research, then highest gun tier.
 */
export function pickTopGun(profiles) {
  return [...profiles].sort((a, b) =>
    (stdAlpha(b.shells) - stdAlpha(a.shells)) || ((b.price_xp ?? 0) - (a.price_xp ?? 0)) || ((b.gun?.tier ?? 0) - (a.gun?.tier ?? 0)))[0];
}
const stdAlpha = shells => Number(shells?.[0]?.damage) || 0;

/**
 * Gun type from the encyclopedia: a gun with clip_capacity > 1 is an autoloader (shots per clip,
 * seconds to reload the whole clip); anything else fires one shell per reload. The page and
 * service/scrape-wotinspector.js trust this, with the tank's override (a manual or personal entry
 * carrying gun_type / clip) winning — see gunFor() in lib/highlights.js.
 */
export function gunInfo(p) {
  const clip = Number(p?.gun?.clip_capacity) || 1;
  const info = { gun_type: clip > 1 ? 'autoloader' : 'single', clip };
  if (clip > 1 && Number(p.gun.clip_reload_time) > 0) info.clip_reload = Number(p.gun.clip_reload_time);
  if (p?.module_id) info.gun_id = p.module_id;
  return info;
}

export function toEntry(v, { gunProfile, hp, gunName, stock, guns = [] }) {
  const shells = gunProfile.shells || [];
  const alpha = shellMap(shells);
  const entry = {
    tank_id: v.tank_id,
    name: v.name,
    nation: v.nation,
    tier: v.tier,
    type: v.type,
    premium: Boolean(v.is_premium || v.is_collectible),
    hp,
    gun: gunName || '',
    ...gunInfo(gunProfile),
    max_roll: shellMap(shells, maxRoll),
    alpha,
    note: [Object.values(alpha).join(' / '), gunName, stock ? 'stock' : ''].filter(Boolean).join(' · '),
  };
  // every other gun the tank can mount, so a shot bigger than the chosen gun's max roll can be re-scored
  const others = guns.filter(g => g !== gunProfile && (g.shells || []).length);
  if (others.length) entry.guns = others.map(g => ({ name: g.name || g.gun?.name || '', ...gunInfo(g), max_roll: shellMap(g.shells, maxRoll), alpha: shellMap(g.shells) }));
  if (!shells.length) entry.warning = 'no shells in the encyclopedia';
  return entry;
}

/**
 * Fetch every vehicle and return { tanks: [...entries sorted by tier desc, name], meta }.
 * `only` restricts to a set of tank_ids (quick smoke tests); `stock` skips the module lookups.
 */
export async function buildTable({ client, stock = false, only = null, language = 'en', log = () => {} }) {
  const info = await client.call('encyclopedia/info', { language, fields: 'game_version,vehicle_nations' }).catch(() => null);
  const nations = info?.data?.vehicle_nations ? Object.keys(info.data.vehicle_nations) : FALLBACK_NATIONS;

  const vehicles = [];
  for (const nation of nations) {
    const res = await client.call('encyclopedia/vehicles', { nation, language, tank_id: only ? [...only].join(',') : undefined });
    for (const v of Object.values(res.data || {})) if (v && v.tank_id) vehicles.push(v);
    log(`${nation}: ${Object.keys(res.data || {}).length} vehicles`);
  }
  if (only) for (const id of only) if (!vehicles.some(v => v.tank_id === id)) log(`warning: tank_id ${id} is not in the ${language} encyclopedia`);

  const tanks = await Promise.all(vehicles.map(async v => {
    const dp = v.default_profile || {};
    if (stock) return toEntry(v, { gunProfile: dp, hp: dp.hp, gunName: dp.gun?.name, stock: true });

    const guns = modulesOf(v, 'vehicleGun');
    const turrets = modulesOf(v, 'vehicleTurret');
    try {
      // A gun only mounts on some turrets (the top gun usually needs the top turret), and the API
      // answers INCOMPATIBLE_MODULE_IDS for a pair that doesn't fit — so try every gun × turret
      // combination, keep what mounts, and take HP from the same answers.
      let hp = dp.hp || 0;
      const gunProfiles = [];
      for (const g of guns) {
        const fits = await Promise.all((turrets.length ? turrets : [null]).map(async t => {
          try {
            const r = await client.call('encyclopedia/vehicleprofile', { tank_id: v.tank_id, gun_id: g.module_id, turret_id: t?.module_id, language });
            return r.data?.[v.tank_id] || null;
          } catch (e) {
            if (e instanceof WgError && e.wgMessage === 'INCOMPATIBLE_MODULE_IDS') return null;
            throw e;
          }
        }));
        const ok = fits.filter(Boolean);
        for (const p of ok) hp = Math.max(hp, p.hp || 0);
        if (ok.length) gunProfiles.push({ ...ok[0], price_xp: g.price_xp || 0, name: g.name, module_id: g.module_id });
        else log(`warning: ${v.name} (${v.tank_id}): gun ${g.name} fits no turret — skipped`);
      }
      if (!gunProfiles.length) gunProfiles.push({ ...dp, price_xp: 0, name: dp.gun?.name });
      const top = pickTopGun(gunProfiles);
      return toEntry(v, { gunProfile: top, hp, gunName: top.name || top.gun?.name, guns: gunProfiles });
    } catch (e) {
      log(`warning: ${v.name} (${v.tank_id}) falling back to the stock profile: ${e.message}`);
      return { ...toEntry(v, { gunProfile: dp, hp: dp.hp, gunName: dp.gun?.name, stock: true }), warning: e.message };
    }
  }));

  tanks.sort((a, b) => (b.tier - a.tier) || a.name.localeCompare(b.name));
  return { tanks, meta: { game_version: info?.data?.game_version ?? null, count: tanks.length, requests: client.requests } };
}

/** Entries in the previous file with `"manual": true` are kept (added or overriding) — for tanks the API is missing. */
export function mergeManual(fresh, previous) {
  const manual = (previous || []).filter(t => t && t.manual);
  if (!manual.length) return fresh;
  const byId = new Map(fresh.map(t => [t.tank_id, t]));
  for (const t of manual) byId.set(t.tank_id, t);
  return [...byId.values()].sort((a, b) => ((b.tier ?? 0) - (a.tier ?? 0)) || String(a.name).localeCompare(String(b.name)));
}

export const toText = list => '[\n' + list.map(t => '  ' + JSON.stringify(t)).join(',\n') + '\n]\n';

// ---------- CLI ----------

export function parseArgs(argv) {
  const opts = { region: 'eu', out: 'data/tanks.json', stock: false, concurrency: 4, language: 'en', tank: null, appId: process.env.WG_APPLICATION_ID };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], next = () => argv[++i];
    if (a === '--region') opts.region = next();
    else if (a === '--out') opts.out = next();
    else if (a === '--stock') opts.stock = true;
    else if (a === '--concurrency') opts.concurrency = Number(next());
    else if (a === '--language') opts.language = next();
    else if (a === '--tank') opts.tank = new Set(next().split(',').map(Number).filter(Number.isInteger));
    else if (a === '--app-id') opts.appId = next();
    else if (a === '--help' || a === '-h') opts.help = true;
    else throw new Error(`Unknown argument ${a}`);
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log('Usage: WG_APPLICATION_ID=… node service/fetch-tanks.js [--region eu|na|asia] [--out data/tanks.json] [--stock] [--tank id,id] [--concurrency 4] [--language en]');
    return;
  }
  if (!opts.appId) { console.error('Set WG_APPLICATION_ID (free at https://developers.wargaming.net) or pass --app-id.'); process.exit(2); }

  const log = m => console.error(m);
  const client = makeClient({ appId: opts.appId, region: opts.region, concurrency: opts.concurrency, log });
  const t0 = Date.now();
  const { tanks, meta } = await buildTable({ client, stock: opts.stock, only: opts.tank, language: opts.language, log });

  let previous = null;
  try { previous = JSON.parse(await readFile(opts.out, 'utf8')); } catch {}
  const merged = mergeManual(tanks, previous);

  await mkdir(dirname(opts.out), { recursive: true });
  await writeFile(opts.out, toText(merged));
  const metaPath = opts.out.replace(/\.json$/, '') + '.meta.json';
  await writeFile(metaPath, JSON.stringify({ ...meta, region: opts.region, stock: opts.stock, generated_at: new Date().toISOString(), source: HOSTS[opts.region] + '/wotb/encyclopedia/' }, null, 2) + '\n');

  const warned = merged.filter(t => t.warning).length;
  console.error(`${merged.length} tanks → ${opts.out} (${meta.requests} requests, ${((Date.now() - t0) / 1000).toFixed(1)} s, game ${meta.game_version ?? '?'}${warned ? `, ${warned} with warnings` : ''})`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(e => { console.error(e.message); process.exit(1); });
}

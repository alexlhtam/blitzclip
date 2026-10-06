#!/usr/bin/env node
// Source content from WoTInspector's public Blitz replay list: find max-damage rolls (the priority)
// and one-clip 100-to-0 kills, and list them with a link to each replay.
// The list is api.wotinspector.com/v2/replays/?platform=blitz — without the platform filter it is
// mostly WoT PC battles.
//
//   node service/scrape-wotinspector.js [--pages 5] [--out out/wotinspector] [--overrides my-tanks.json]
//                                       [--min-damage 1000] [--min-roll-pct 95] [--max-gap 8]
//                                       [--filter key=value ...] [--rps 0.25] [--dry-run] [--download]
//
// Two stages, so we don't over-analyse:
//   1. List pages (one request per 50-ish replays). Each summary has the tank, total damage and
//      kills. A single-shot tank is kept only if its total damage could contain a max roll: at
//      least --min-damage AND at least --min-roll-pct of its smallest shell's max roll. A tank
//      that can mount a clip gun is also kept if it killed anything (a 100-to-0 needs a kill).
//   2. For each candidate: the replay's details — which gun was mounted, who was in the battle, who
//      killed whom, and every shell fired (battle.shots: listed and dealt damage) — scored by the
//      *FromShots functions in lib/highlights.js. Nothing is downloaded: hits are listed in
//      <out>/candidates.json with their view_url; --download also saves the .wotbreplay to
//      <out>/replays/ (opt-in, robots.txt disallows replays.wotinspector.com/download). Every
//      replay looked at is remembered in <out>/seen.json so the next run skips it.
//
// Gun type: data/tanks.json (WG encyclopedia, service/fetch-tanks.js), overridden by its manual
// entries and by --overrides (the page's personal overrides, "Copy JSON") — see gunFor().
//
// No dependencies; Node 22. Be polite: WoTInspector is a community site. The default pace is one
// request every 4 s, 429 / Retry-After is honoured, and nothing is fetched twice.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildTankIndex, gunFor, hasClipGun, bestRollFromShots, oneClipKillsFromShots, killsFromPlayers, ONE_CLIP_DEFAULTS } from '../lib/highlights.js';

// The site's own endpoint. The list mixes every game unless asked for Blitz, and robots.txt
// disallows the older /v2/blitz/replays path, so list and details both go through /v2/replays/.
export const WI_API = 'https://api.wotinspector.com/v2/replays/';
export const WI_PLATFORM = 'blitz';
export const WI_VIEW = 'https://replays.wotinspector.com/en/blitz/view/';
const USER_AGENT = 'blitzclip-content-finder (+https://github.com/alexlhtam/blitzclip)';

export const DEFAULTS = { pages: 5, startPage: 1, minDamage: 1000, minRollPct: 95, maxGap: ONE_CLIP_DEFAULTS.maxGap, rps: 0.25 };

// ---------- WoTInspector client ----------

/** Paced, retrying GET client. `fetchImpl` is injectable for tests. */
export function makeWiClient({ fetchImpl = globalThis.fetch, rps = DEFAULTS.rps, retryDelay = 2000, tries = 4, log = () => {}, sleep = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
  const gap = 1000 / rps;
  let next = 0, requests = 0;
  async function get(url, as = 'json') {
    for (let attempt = 1; ; attempt++) {
      const wait = next - Date.now();
      next = Math.max(Date.now(), next) + gap;
      if (wait > 0) await sleep(wait);
      requests++;
      let res, err;
      try { res = await fetchImpl(url, { headers: { 'user-agent': USER_AGENT, accept: as === 'json' ? 'application/json' : '*/*' } }); }
      catch (e) { err = e; }
      if (res && res.ok) return as === 'json' ? res.json() : new Uint8Array(await res.arrayBuffer());
      const transient = err || res.status === 429 || res.status >= 500;
      if (!transient || attempt >= tries) throw new Error(err ? `${err.message} (${url})` : `HTTP ${res.status} from ${url}`);
      const retryAfter = res && Number(res.headers.get('retry-after'));
      const delay = retryAfter > 0 ? retryAfter * 1000 : retryDelay * 2 ** attempt;
      log(`  retry ${attempt}/${tries - 1} in ${Math.round(delay / 1000)} s: ${err ? err.message : 'HTTP ' + res.status}`);
      await sleep(delay);
    }
  }
  return { get, get requests() { return requests; } };
}

/** One list page, Blitz only; --filter pairs are appended (and may override platform). */
export function listUrl(page, filters = {}) {
  const u = new URL(WI_API);
  u.searchParams.set('page', String(page));
  u.searchParams.set('platform', WI_PLATFORM);
  for (const [k, v] of Object.entries(filters)) u.searchParams.set(k, String(v));
  return u.href;
}

// WoTInspector's list uses long field names; the details endpoint has been seen with the short
// aliases too (dm, vi, d, ei, gi…). Normalise both.
const pick = (o, ...keys) => { for (const k of keys) if (o && o[k] !== undefined && o[k] !== null) return o[k]; return undefined; };

export function normSummary(s) {
  const id = String(pick(s, 'id', '_id') ?? '');
  return {
    id,
    tank_id: Number(pick(s, 'vehicle_descr', 'vehicle_id', 'vi')) || 0,
    player: pick(s, 'player_name', 'pn') || '',
    title: pick(s, 'title', 't') || '',
    damage: Number(pick(s, 'damage_made', 'dm')) || 0,
    kills: Number(pick(s, 'enemies_destroyed', 'ek')) || 0,
    map_id: pick(s, 'map_id', 'mi') ?? null,
    download_url: pick(s, 'download_url', 'dlu') || null,
    view_url: pick(s, 'details_url', 'deu') || (id ? WI_VIEW + id + '/' : null),
    battle_time: pick(s, 'battle_start_time', 'bts') || null,
  };
}

/** Per-replay details URL. */
export const detailsUrl = id => new URL(encodeURIComponent(id) + '/', WI_API).href;

// Real Blitz details nest the players under `battle` (battle.players_data); each player has
// dbid, entity_id, vehicle_id, gun_id and name, and `protagonist` (a dbid) sits at the top level.
export function normDetails(d) {
  const players = (pick(d?.battle, 'players_data', 'd') || pick(d, 'players_data', 'd') || []).map(p => ({
    dbid: Number(pick(p, 'dbid', 'id')) || 0,
    entity: Number(pick(p, 'entity_id', 'ei')) || null,
    tank_id: Number(pick(p, 'vehicle_id', 'vehicle_descr', 'vi')) || 0,
    gun_id: Number(pick(p, 'gun_id', 'gi')) || null,
    name: pick(p, 'name', 'n') || '',
    hp_left: pick(p, 'hitpoints_left') ?? null,
    killed_by: Number(pick(p, 'killed_by')) || 0, // an entity id
  }));
  const shots = pick(d?.battle, 'shots') || pick(d, 'shots') || [];
  const protagonist = Number(pick(d, 'protagonist', 'p')) || 0;
  return { ...normSummary(d), protagonist, players, shots, duration: Number(pick(d, 'battle_duration')) || 0, me: players.find(p => p.dbid === protagonist) || null };
}

// ---------- stage 1: prefilter on the list summary ----------

/** Smallest max roll across the gun's shells (a max roll on any shell is content). */
const smallestMax = mr => typeof mr === 'number' ? mr : Math.min(...Object.values(mr || {}).map(Number).filter(n => n > 0));

/**
 * Decide from the list summary alone whether a replay is worth downloading.
 * → { keep, why: [...reasons kept], skip: reason } — `why` holds 'roll' and/or 'clip'.
 */
export function prefilter(summary, tanks, { minDamage = DEFAULTS.minDamage, minRollPct = DEFAULTS.minRollPct } = {}) {
  const tank = tanks.get(summary.tank_id);
  const why = [];
  const gun = gunFor(tank);
  const floor = gun ? Math.max(minDamage, Math.ceil(smallestMax(gun.max_roll) * minRollPct / 100) || 0) : minDamage;
  if (summary.damage >= floor) why.push('roll');
  if (hasClipGun(tank) && summary.kills > 0) why.push('clip');
  if (why.length) return { keep: true, why, floor };
  return { keep: false, why, floor, skip: !tank ? 'tank not in table' : `damage ${summary.damage} < ${floor}${hasClipGun(tank) ? ', no kills' : ''}` };
}

// ---------- stage 2: analyse one replay ----------

/**
 * Score a replay from its details alone: WoTInspector's per-shot list (battle.shots) gives every
 * shell's listed and dealt damage, so nothing is downloaded. The tank table (+ overrides) only
 * supplies the gun type / clip of the gun the details say was mounted, and victims' full HP.
 */
export function analyse({ details, tanks, minRollPct = DEFAULTS.minRollPct, maxGap = DEFAULTS.maxGap }) {
  const me = details.me;
  if (!me || !me.entity) throw new Error('uploader not in the player list');
  const tankId = me.tank_id || details.tank_id;
  const tank = tanks.get(tankId);
  const gun = gunFor(tank, { gunId: me.gun_id });
  const kills = killsFromPlayers(details.players);
  const roll = bestRollFromShots(details.shots, me.entity, { gun, kills });
  const victimHp = new Map();
  for (const p of details.players) if (p.entity && tanks.get(p.tank_id)?.hp) victimHp.set(p.entity, tanks.get(p.tank_id).hp);
  const clips = oneClipKillsFromShots(details.shots, me.entity, gun, { kills, victimHp, maxGap });
  for (const c of clips) { const p = details.players.find(x => x.entity === c.victim); if (p) { c.victim_name = p.name; c.victim_tank = tanks.get(p.tank_id)?.name || `#${p.tank_id}`; } }
  const maxRoll = roll && roll.pct >= minRollPct ? roll : null;
  return {
    hit: !!(maxRoll || clips.length),
    tank: tank?.name || `#${tankId}`, tank_id: tankId,
    gun: gun && { name: gun.name, type: gun.gun_type, clip: Number.isFinite(gun.clip) ? gun.clip : null, source: gun.source },
    best_roll: roll && { ...roll, pct: Math.round(roll.pct * 10) / 10 },
    max_roll: !!maxRoll,
    one_clip: clips,
    map_id: details.map_id, duration: details.duration,
  };
}

// ---------- run ----------

async function readJson(path, fallback) { try { return JSON.parse(await readFile(path, 'utf8')); } catch { return fallback; } }

export async function run({ client, tanks, out, pages = DEFAULTS.pages, startPage = DEFAULTS.startPage, filters = {}, dryRun = false, download = false, log = () => {}, ...opts }) {
  const seenPath = join(out, 'seen.json'), candPath = join(out, 'candidates.json');
  const seen = await readJson(seenPath, {});
  const candidates = await readJson(candPath, []);
  const stats = { listed: 0, already: 0, skipped: 0, analysed: 0, hits: 0, errors: 0 };
  if (!dryRun) await mkdir(download ? join(out, 'replays') : out, { recursive: true });

  for (let page = startPage; page < startPage + pages; page++) {
    let body;
    try { body = await client.get(listUrl(page, filters)); }
    catch (e) { log(`page ${page}: ${e.message} — stopping`); break; }
    const results = (body.results || []).map(r => ({ ...normSummary(r), raw: r })).filter(s => s.id);
    log(`page ${page}: ${results.length} replays`);
    for (const s of results) {
      stats.listed++;
      if (seen[s.id]) { stats.already++; continue; }
      const pre = prefilter(s, tanks, opts);
      if (!pre.keep) { stats.skipped++; seen[s.id] = { skip: pre.skip }; continue; }
      if (dryRun) { log(`  would analyse ${s.id} (${tanks.get(s.tank_id)?.name || '#' + s.tank_id}, ${s.damage} dmg, ${s.kills} kills: ${pre.why.join('+')})`); continue; }
      try {
        const details = normDetails({ ...s.raw, ...(await client.get(detailsUrl(s.id))) });
        const res = analyse({ details, tanks, ...opts });
        stats.analysed++;
        seen[s.id] = { hit: res.hit };
        if (res.hit) {
          stats.hits++;
          const url = details.download_url || s.download_url;
          let file = null;
          if (download && url) { // opt-in: robots.txt disallows replays.wotinspector.com/download
            try {
              const bytes = await client.get(url, 'bytes');
              file = `${s.id}_${(res.tank || 'tank').replace(/[^\w.-]+/g, '_')}.wotbreplay`;
              await writeFile(join(out, 'replays', file), bytes);
            } catch (e) { log(`  ${s.id}: download failed (${e.message})`); }
          }
          candidates.push({ id: s.id, view_url: details.view_url || s.view_url, download_url: url || null, file, player: s.player, title: s.title, damage: s.damage, kills: s.kills, battle_time: s.battle_time, ...res, found_at: new Date().toISOString() });
          log(`  ✓ ${res.tank}: ${res.max_roll ? `max roll ${res.best_roll.damage} (${res.best_roll.pct}%)` : ''}${res.max_roll && res.one_clip.length ? ' + ' : ''}${res.one_clip.length ? `${res.one_clip.length} one-clip kill(s)` : ''}`);
        }
      } catch (e) {
        stats.errors++; seen[s.id] = { error: e.message }; log(`  ${s.id}: ${e.message}`);
      }
    }
    if (!dryRun) { await writeFile(seenPath, JSON.stringify(seen) + '\n'); await writeFile(candPath, JSON.stringify(rank(candidates), null, 2) + '\n'); }
    if (!body.next) break;
  }
  return { stats, candidates: rank(candidates), requests: client.requests };
}

/** Max rolls first (biggest damage, then %), then one-clip kills. */
export const rank = list => [...list].sort((a, b) => (b.max_roll - a.max_roll) || ((b.best_roll?.damage || 0) - (a.best_roll?.damage || 0)) || (b.one_clip.length - a.one_clip.length));

// ---------- CLI ----------

export function parseArgs(argv) {
  const opts = { ...DEFAULTS, out: 'out/wotinspector', tanksPath: 'data/tanks.json', overridesPath: null, filters: {}, dryRun: false, download: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], next = () => argv[++i], num = () => { const v = Number(next()); if (!Number.isFinite(v)) throw new Error(`${a} needs a number`); return v; };
    if (a === '--pages') opts.pages = num();
    else if (a === '--start-page') opts.startPage = num();
    else if (a === '--out') opts.out = next();
    else if (a === '--tanks') opts.tanksPath = next();
    else if (a === '--overrides') opts.overridesPath = next();
    else if (a === '--min-damage') opts.minDamage = num();
    else if (a === '--min-roll-pct') opts.minRollPct = num();
    else if (a === '--max-gap') opts.maxGap = num();
    else if (a === '--rps') opts.rps = num();
    else if (a === '--filter') { const [k, ...v] = next().split('='); opts.filters[k] = v.join('='); }
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--download') opts.download = true;
    else if (a === '--help' || a === '-h') opts.help = true;
    else throw new Error(`Unknown argument ${a}`);
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { console.log(USAGE); return; }
  const shared = JSON.parse(await readFile(opts.tanksPath, 'utf8'));
  const overrides = opts.overridesPath ? JSON.parse(await readFile(opts.overridesPath, 'utf8')) : [];
  const tanks = buildTankIndex(shared, overrides);
  const log = m => console.error(m);
  const client = makeWiClient({ rps: opts.rps, log });
  const { stats, candidates, requests } = await run({ client, tanks, out: opts.out, pages: opts.pages, startPage: opts.startPage, filters: opts.filters, dryRun: opts.dryRun, download: opts.download,
    minDamage: opts.minDamage, minRollPct: opts.minRollPct, maxGap: opts.maxGap, log });
  console.error(`${stats.listed} listed · ${stats.already} seen before · ${stats.skipped} under threshold · ${stats.analysed} analysed · ${stats.hits} new hits · ${stats.errors} errors · ${requests} requests`);
  if (!opts.dryRun) console.error(`${candidates.length} candidates in ${join(opts.out, 'candidates.json')}${opts.download ? `, replays in ${join(opts.out, 'replays')}/` : ' (open view_url to download a replay, or re-run with --download)'}`);
}
const USAGE = 'Usage: node service/scrape-wotinspector.js [--pages 5] [--start-page 1] [--out out/wotinspector] [--tanks data/tanks.json] [--overrides my-tanks.json] [--min-damage 1000] [--min-roll-pct 95] [--max-gap 8] [--filter key=value] [--rps 0.25] [--dry-run] [--download]';

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(e => { console.error(e.message); process.exit(1); });
}

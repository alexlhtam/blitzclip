// Highlight detection on a parsed replay: the best max-damage roll, and one-clip 100-to-0 kills.
// Pure functions, no I/O — used by service/scrape-wotinspector.js and testable on synthetic
// replays. The scraper scores from WoTInspector's per-shot data (the *FromShots functions at the end).
//
// Gun type comes from the shared tank table (data/tanks.json, built from WG's encyclopedia by
// service/fetch-tanks.js), with the tank's override winning: a manual entry in the table or a
// personal override (the page's "Copy JSON" export) that carries gun_type / clip is trusted over
// the encyclopedia and over the gun the replay says was mounted.

/** Shared table + overrides → Map(tank_id → entry). An override's fields are laid over the shared entry, so a partial one ({tank_id, gun_type, clip}) works. */
export function buildTankIndex(shared = [], overrides = []) {
  const byId = new Map();
  for (const t of shared) if (t && t.tank_id) byId.set(+t.tank_id, t);
  for (const o of overrides) {
    if (!o || !o.tank_id) continue;
    byId.set(+o.tank_id, { ...(byId.get(+o.tank_id) || {}), ...o, tank_id: +o.tank_id, override: true });
  }
  return byId;
}

const isOverride = t => !!(t && (t.override || t.manual) && t.gun_type);
const shape = (g, source) => ({
  name: g.gun ?? g.name ?? '', // a table entry's `name` is the tank's; its gun is `gun` (alternates only have `name`)
  gun_type: g.gun_type || 'single',
  clip: Number(g.clip) > 0 ? Number(g.clip) : g.gun_type === 'autoloader' ? Infinity : 1, // an autoloader override without a clip size: any number of shots
  clip_reload: Number(g.clip_reload) || null,
  max_roll: g.max_roll || {},
  source,
});

/**
 * The gun a replay was played with, as { name, gun_type, clip, clip_reload, max_roll, source }.
 * Order: the tank's override (manual / personal entry with gun_type) → the gun the replay reports
 * (gunId, matched against the table's chosen gun and its alternates) → the table's chosen gun →
 * unknown (scored as a single-shot gun with whatever max_roll the entry has).
 */
export function gunFor(tank, { gunId = null } = {}) {
  if (!tank) return null;
  if (isOverride(tank)) return shape(tank, 'override');
  if (gunId) {
    if (+tank.gun_id === +gunId) return shape(tank, 'replay');
    const alt = (tank.guns || []).find(g => +g.gun_id === +gunId);
    if (alt) return shape(alt, 'replay');
  }
  return shape(tank, tank.gun_type ? 'table' : 'unknown');
}

/** Can this tank mount a clip gun at all (chosen gun, any alternate, or its override)? */
export function hasClipGun(tank) {
  if (!tank) return false;
  if (isOverride(tank)) return tank.gun_type !== 'single' && (Number(tank.clip) || 2) > 1;
  return [tank, ...(tank.guns || [])].some(g => g.gun_type === 'autoloader' || Number(g.clip) > 1);
}

const shellList = maxRoll => typeof maxRoll === 'number' ? [{ name: '', max: maxRoll }] : Object.entries(maxRoll || {}).map(([name, max]) => ({ name, max: Number(max) }));

/**
 * Score every direct hit against the max roll of the shell it fired (the slot the replay recorded;
 * otherwise the tightest shell it fits — same rule as the page). Returns the best shot by % of max:
 * { damage, pct, shell, known, atLeast, clock } or null.
 */
export function bestRoll(shots, gun) {
  const shells = shellList(gun?.max_roll);
  if (!shells.length) return null;
  const isHE = sh => /HE/i.test(sh.name);
  let best = null;
  for (const s of shots || []) {
    if (!(s.damage > 0) || s.fire) continue;
    let shell, known = false;
    if (Number.isInteger(s.ammo) && shells[s.ammo]) { shell = shells[s.ammo]; known = true; }
    else {
      let cands = shells;
      if (s.hitType === 4 && shells.some(isHE)) cands = shells.filter(isHE);
      const asc = cands.slice().sort((a, b) => a.max - b.max);
      shell = asc.find(sh => sh.max >= s.damage) || asc[asc.length - 1];
    }
    const pct = 100 * s.damage / shell.max;
    if (!best || pct > best.pct || (pct === best.pct && s.damage > best.damage)) best = { damage: s.damage, pct, shell: shell.name, known, atLeast: !!s.kill, clock: s.clock };
  }
  return best;
}

export const ONE_CLIP_DEFAULTS = { maxGap: 8, hpTolerance: 0.01 };

/**
 * One-clip 100-to-0 kills: an enemy that took no damage from anyone before the author's first hit
 * on it (so it was at full HP), then was destroyed by the author with at most `clip` direct hits,
 * no gap between them long enough to reload a new clip (the gun's clip_reload when known, else
 * `maxGap` seconds), and nobody else damaging it in between. The author's own fire ticks are
 * allowed; they don't count as shots.
 *
 * `raw` is parseReplay(…, { raw: true }).raw. `victimHp` (optional) maps victim entity → the tank's
 * max HP (from WoTInspector's player list + the tank table); with it the starting HP is checked
 * against the tank's full HP and the moment is marked `verified`.
 */
export function oneClipKills(raw, gun, { victimHp = new Map(), maxGap = ONE_CLIP_DEFAULTS.maxGap, hpTolerance = ONE_CLIP_DEFAULTS.hpTolerance } = {}) {
  if (!raw || raw.author === null || raw.author === undefined || !gun || !(gun.clip > 1)) return [];
  const author = raw.author;
  const gapLimit = gun.clip_reload || maxGap;
  const byVictim = new Map();
  for (const e of raw.hpEvents) { if (!byVictim.has(e.victim)) byVictim.set(e.victim, []); byVictim.get(e.victim).push(e); }

  const out = [];
  for (const [victim, events] of byVictim) {
    if (victim === author) continue;
    let prev, start, hits = [], clean = true, done = false, touched = false;
    for (const e of events) {
      const known = prev !== undefined;
      const delta = known ? prev - e.hp : null;
      prev = e.hp;
      if (done) break;
      if (known && delta <= 0) continue; // sighting / no change
      if (!known && e.attacker === 0) continue; // first sighting carries the HP, no damage
      if (e.attacker !== author) { clean = false; break; } // someone else got there first, or chipped in
      if (!touched) {
        touched = true;
        if (known) start = e.hp + delta;
        else { // no earlier HP for this victim: recover it from the hit record that caused this drop
          const h = nearestHit(raw.hits, author, victim, e.clock);
          start = h ? e.hp + h.damage : null;
        }
      }
      if (!e.dot) hits.push(e.clock);
      if (e.hp === 0) done = true;
    }
    if (!clean || !done || !hits.length || hits.length > gun.clip) continue;
    if (hits.some((c, i) => i && c - hits[i - 1] >= gapLimit)) continue;
    const full = victimHp.get(victim) || null;
    if (full && start !== null && start < full * (1 - hpTolerance)) continue; // damaged before the author saw it
    out.push({ victim, start_hp: start, full_hp: full, verified: !!(full && start !== null), shots: hits.length, clip: gun.clip, clock: hits[0], end: hits[hits.length - 1], duration: +(hits[hits.length - 1] - hits[0]).toFixed(2) });
  }
  return out.sort((a, b) => a.clock - b.clock);
}

function nearestHit(hits, author, victim, clock) {
  let best = null, bestDt = 0.5;
  for (const h of hits || []) if (h.shooter === author && h.victim === victim && h.applied && Math.abs(h.clock - clock) < bestDt) { best = h; bestDt = Math.abs(h.clock - clock); }
  return best;
}

// ---------- from WoTInspector's per-shot data (replay details JSON, battle.shots) ----------
// Each shot: { time, shooter, target, shell_id, ammo_type, is_premium_ammo, nominal_damage, damage,
// has_damage, … } with shooter/target as entity ids. Only shells are listed — no fire, ramming or
// ammo-rack events — so nothing but a shell hit can score.

/** Max roll of a shell: listed damage + 25 %, rounded (live replays show 388 from a 310 shell). */
export const maxRollOf = nominal => Math.round(1.25 * nominal);

/**
 * Entities destroyed by each player: Map(target entity → killer entity), from players_data
 * (hitpoints_left ≤ 0 and killed_by, an entity id).
 */
export function killsFromPlayers(players = []) {
  const kills = new Map();
  for (const p of players) if (p && p.entity && p.killed_by && p.hp_left !== null && p.hp_left <= 0) kills.set(p.entity, p.killed_by);
  return kills;
}

const damaging = shots => (shots || []).filter(s => s && s.damage > 0).sort((a, b) => a.time - b.time);

/** The shot that destroyed each target: its last damaging shot, when the killer fired it. Set of shots. */
function killShots(shots, kills) {
  const last = new Map();
  for (const s of damaging(shots)) last.set(s.target, s);
  const out = new Set();
  for (const [target, s] of last) if (kills.get(target) === s.shooter) out.add(s);
  return out;
}

/**
 * Best max-damage roll by `shooter`: the damaging shot with the highest damage / max roll of the
 * shell it fired (max roll = round(1.25 × nominal_damage)). A shot that destroyed its target is
 * `atLeast` (the damage is capped at the HP it had left). A shot above its max roll isn't a roll
 * (a damage-boosting ability, presumably) and is left out; `over_max` counts them. The shell is
 * named from `gun.max_roll` when one entry has that max (±1, the table floors), else by ammo type.
 * Returns { damage, nominal, max, pct, shell, ammo_type, premium, atLeast, over_max, time, target } or null.
 */
export function bestRollFromShots(shots, shooter, { gun = null, kills = new Map() } = {}) {
  const finals = killShots(shots, kills);
  const named = shellList(gun?.max_roll);
  let best = null, overMax = 0;
  for (const s of damaging(shots)) {
    if (s.shooter !== shooter || !(s.nominal_damage > 0)) continue;
    const max = maxRollOf(s.nominal_damage);
    if (s.damage > max) { overMax++; continue; }
    const pct = 100 * s.damage / max;
    if (best && !(pct > best.pct || (pct === best.pct && s.damage > best.damage))) continue;
    const shell = named.find(sh => Math.abs(sh.max - max) <= 1)?.name || AMMO_TYPES[s.ammo_type] || `ammo ${s.ammo_type}`;
    best = { damage: s.damage, nominal: s.nominal_damage, max, pct, shell, ammo_type: s.ammo_type, premium: !!s.is_premium_ammo, atLeast: finals.has(s), time: s.time, target: s.target };
  }
  if (best) best.over_max = overMax;
  return best;
}
// WoTInspector's ammo_type, as seen on known shells: 0 AP, 2 APCR, 3 HE (HESH too), 5 HEAT.
const AMMO_TYPES = { 0: 'AP', 2: 'APCR', 3: 'HE', 5: 'HEAT' };

/**
 * One-clip 100-to-0 kills by `shooter` from the shot list: a target whose every damaging shot came
 * from the shooter (so nobody touched it before or between), destroyed by the shooter, with at most
 * `gun.clip` hits and no gap between them as long as a clip reload (`gun.clip_reload`, else `maxGap`
 * seconds). `victimHp` (Map target entity → the tank's full HP, from the tank table) marks it
 * `verified` when the shooter's damage covers the full HP; the shot list only holds what the
 * recording player saw, and fire / ram damage isn't in it, so a kill that doesn't add up is kept
 * as unverified rather than dropped.
 */
export function oneClipKillsFromShots(shots, shooter, gun, { kills = new Map(), victimHp = new Map(), maxGap = ONE_CLIP_DEFAULTS.maxGap, hpTolerance = ONE_CLIP_DEFAULTS.hpTolerance } = {}) {
  if (!gun || !(gun.clip > 1)) return [];
  const gapLimit = gun.clip_reload || maxGap;
  const byTarget = new Map();
  for (const s of damaging(shots)) { if (!byTarget.has(s.target)) byTarget.set(s.target, []); byTarget.get(s.target).push(s); }
  const out = [];
  for (const [target, list] of byTarget) {
    if (target === shooter || kills.get(target) !== shooter) continue;
    if (list.some(s => s.shooter !== shooter)) continue;
    if (list.length > gun.clip) continue;
    const times = list.map(s => s.time);
    if (times.some((t, i) => i && t - times[i - 1] >= gapLimit)) continue;
    const dealt = list.reduce((a, s) => a + s.damage, 0);
    const full = victimHp.get(target) || null;
    out.push({ victim: target, damage: dealt, full_hp: full, verified: !!(full && dealt >= full * (1 - hpTolerance)), shots: list.length, clip: gun.clip, clock: times[0], end: times[times.length - 1], duration: +(times[times.length - 1] - times[0]).toFixed(2) });
  }
  return out.sort((a, b) => a.clock - b.clock);
}

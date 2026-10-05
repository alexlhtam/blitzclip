// Highlight detection on a parsed replay: the best max-damage roll, and one-clip 100-to-0 kills.
// Pure functions, no I/O — used by service/scrape-wotinspector.js and testable on synthetic replays.
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
  name: g.name ?? g.gun ?? '',
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

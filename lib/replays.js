// Validation and SQL for stored replays.

import { q, one } from './db.js';

export const REPLAY_COLUMNS = 'id, sha256, file_name, file_size, blob_url, blob_pathname, tank_id, vehicle_code, vehicle, map, player, duration, max_shot, total_damage, kills, shots, error, parser_version, battle_time, status, note, created_at';
export const STATUSES = ['new', 'shortlisted', 'recorded', 'published', 'rejected'];

const str = (v, max = 200) => (v === undefined || v === null) ? null : String(v).slice(0, max);
const int = v => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : null);
const isSha = s => typeof s === 'string' && /^[0-9a-f]{64}$/.test(s);

/** Turn the browser's parse result into the row we store. Throws on bad input. */
export function summaryFromBody(body) {
  if (!body || typeof body !== 'object') throw new Error('Body must be an object');
  if (!isSha(body.sha256)) throw new Error('sha256 must be a 64-char hex string');
  if (!body.file_name || typeof body.file_name !== 'string') throw new Error('file_name is required');
  const size = int(body.file_size);
  if (size === null || size < 0) throw new Error('file_size is required');
  const p = body.parsed || {};
  const shots = Array.isArray(p.shots) ? p.shots : [];
  if (JSON.stringify(shots).length > 512 * 1024) throw new Error('shot list too large');
  const cleanShots = shots.map(s => ({
    clock: Number(s.clock) || 0, damage: int(s.damage) ?? 0, cumulative: s.cumulative === null || s.cumulative === undefined ? null : int(s.cumulative),
    ammo: Number.isInteger(s.ammo) ? s.ammo : null, hitType: Number.isInteger(s.hitType) ? s.hitType : null,
    ...(s.kill ? { kill: true } : {}), ...(s.fire ? { fire: true, ticks: int(s.ticks) ?? 0, victim: int(s.victim) } : {}),
    ...(s.noDamage ? { noDamage: true, roll: int(s.roll) ?? 0 } : {}),
    ...(s.victim !== undefined && s.victim !== null && !s.fire ? { victim: int(s.victim) } : {}),
    // HP before and after, and the victim's full pool — what the clip-kill detector reads back
    ...(!s.fire && s.hp !== undefined && s.hp !== null ? { hp: int(s.hp) } : {}),
    ...(!s.fire && s.prevHp !== undefined ? { prevHp: s.prevHp === null ? null : int(s.prevHp) } : {}),
    ...(!s.fire && s.pool !== undefined ? { pool: s.pool === null ? null : int(s.pool) } : {}),
  }));
  const damaging = cleanShots.filter(s => s.damage > 0 && !s.fire);
  const maxShot = damaging.length ? Math.max(...damaging.map(s => s.damage)) : null;
  const total = cleanShots.length ? Math.max(...cleanShots.map(s => s.cumulative || 0)) : 0;
  const kills = cleanShots.filter(s => s.kill).length;
  let battleTime = null;
  const m = body.file_name.match(/(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})/); // 20260911_1225_GB48_FV215b_183.wotbreplay
  if (m) { const d = new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:00`); if (!isNaN(d)) battleTime = d.toISOString(); }
  return {
    sha256: body.sha256, file_name: body.file_name.slice(0, 300), file_size: size,
    blob_url: str(body.blob_url, 1000), blob_pathname: str(body.blob_pathname, 500),
    tank_id: int(p.tankId), vehicle_code: str(p.vehicleCode, 100), vehicle: str(p.vehicle, 100), map: str(p.map, 100), player: str(p.player, 100),
    duration: Number(p.duration) || null, max_shot: maxShot, total_damage: total, kills,
    shots: cleanShots, error: str(p.error, 300), parser_version: str(body.parser_version, 40), battle_time: battleTime,
  };
}

export async function insertReplay(userId, s) {
  const { rows } = await q(
    `INSERT INTO replays (user_id, sha256, file_name, file_size, blob_url, blob_pathname, tank_id, vehicle_code, vehicle, map, player, duration, max_shot, total_damage, kills, shots, error, parser_version, battle_time)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16::jsonb, $17, $18, $19)
     ON CONFLICT (user_id, sha256) DO NOTHING
     RETURNING ${REPLAY_COLUMNS}`,
    [userId, s.sha256, s.file_name, s.file_size, s.blob_url, s.blob_pathname, s.tank_id, s.vehicle_code, s.vehicle, s.map, s.player, s.duration, s.max_shot, s.total_damage, s.kills, JSON.stringify(s.shots), s.error, s.parser_version, s.battle_time]);
  if (rows[0]) return { replay: rows[0], existing: false };
  let existing = await one(`SELECT ${REPLAY_COLUMNS} FROM replays WHERE user_id = $1 AND sha256 = $2`, [userId, s.sha256]);
  if (existing && !existing.blob_url && s.blob_url) {
    // the row was saved without its file (Blob storage not configured then, or the upload failed) — attach it
    existing = await one(`UPDATE replays SET blob_url = $1, blob_pathname = $2, file_size = $3 WHERE user_id = $4 AND id = $5 AND blob_url IS NULL RETURNING ${REPLAY_COLUMNS}`, [s.blob_url, s.blob_pathname, s.file_size, userId, existing.id]) || existing;
  }
  return { replay: existing, existing: true };
}

export const listReplays = userId => q(`SELECT ${REPLAY_COLUMNS} FROM replays WHERE user_id = $1 ORDER BY created_at DESC, id DESC`, [userId]).then(r => r.rows);
export const getReplay = (userId, id) => one(`SELECT ${REPLAY_COLUMNS} FROM replays WHERE user_id = $1 AND id = $2`, [userId, id]);
export const listHashes = userId => q('SELECT sha256 FROM replays WHERE user_id = $1', [userId]).then(r => r.rows.map(x => x.sha256));
export const updateReplay = (userId, id, { status = null, note = null }) =>
  one(`UPDATE replays SET status = COALESCE($1, status), note = COALESCE($2, note) WHERE user_id = $3 AND id = $4 RETURNING ${REPLAY_COLUMNS}`, [status, note, userId, id]);
export const deleteReplay = (userId, id) => one('DELETE FROM replays WHERE user_id = $1 AND id = $2 RETURNING blob_url', [userId, id]);

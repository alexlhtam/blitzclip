// .wotbreplay parser, shared by the page (index.html imports it) and the offline services
// (service/scrape-wotinspector.js). Ported from the verified Python decoding layer of blitzparser.
// Browser and Node 22 both provide DecompressionStream, Blob and Response, so there are no dependencies.
const ZIP_EOCD = 0x06054b50, ZIP_CDIR = 0x02014b50, ZIP_LOCAL = 0x04034b50;
async function inflateRaw(bytes) {
  const ds = new DecompressionStream('deflate-raw');
  const stream = new Blob([bytes]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
export async function readZip(buf) {
  const u8 = new Uint8Array(buf), dv = new DataView(buf);
  let eocd = -1;
  for (let i = u8.length - 22; i >= Math.max(0, u8.length - 65557); i--) if (dv.getUint32(i, true) === ZIP_EOCD) { eocd = i; break; }
  if (eocd < 0) throw new Error('not a .wotbreplay archive');
  const count = dv.getUint16(eocd + 10, true);
  let pos = dv.getUint32(eocd + 16, true);
  const entries = {}, dec = new TextDecoder();
  for (let n = 0; n < count; n++) {
    if (dv.getUint32(pos, true) !== ZIP_CDIR) throw new Error('corrupt archive');
    const method = dv.getUint16(pos + 10, true), csize = dv.getUint32(pos + 20, true);
    const nlen = dv.getUint16(pos + 28, true), elen = dv.getUint16(pos + 30, true), clen = dv.getUint16(pos + 32, true);
    const lho = dv.getUint32(pos + 42, true);
    entries[dec.decode(u8.subarray(pos + 46, pos + 46 + nlen))] = { method, csize, lho };
    pos += 46 + nlen + elen + clen;
  }
  return {
    async read(name) {
      const e = entries[name]; if (!e) return null;
      if (dv.getUint32(e.lho, true) !== ZIP_LOCAL) throw new Error('corrupt archive');
      const start = e.lho + 30 + dv.getUint16(e.lho + 26, true) + dv.getUint16(e.lho + 28, true);
      const data = u8.subarray(start, start + e.csize);
      if (e.method === 0) return data;
      if (e.method === 8) return inflateRaw(data);
      throw new Error('unsupported compression');
    },
  };
}
function headerEnd(data) {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let pos = 12;
  for (let k = 0; k < 2; k++) { let len = data[pos]; pos += 1; if (len === 0xff) { len = dv.getUint16(pos, true); pos += 3; } pos += len; }
  return pos + 1;
}
export function* packets(data) {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let pos = headerEnd(data);
  while (pos + 12 <= data.length) {
    const len = dv.getUint32(pos, true), type = dv.getUint32(pos + 4, true), clock = dv.getFloat32(pos + 8, true);
    pos += 12; if (pos + len > data.length) break;
    yield { type, clock, payload: data.subarray(pos, pos + len) }; pos += len;
  }
}
export function extractShots(data) {
  let gameEntity = null; const events = [];
  for (const p of packets(data)) {
    if (p.type !== 8 || p.payload.length < 8) continue;
    const dv = new DataView(p.payload.buffer, p.payload.byteOffset, p.payload.byteLength);
    const entity = dv.getUint32(0, true), sub = dv.getUint32(4, true);
    if (gameEntity === null && sub === 20) gameEntity = entity;
    if (sub === 12 && p.payload.length >= 18) {
      const m = p.payload.subarray(12);
      const mdv = new DataView(m.buffer, m.byteOffset, m.byteLength);
      // event 1 = damage dealt (cumulative u16 @4); event 3 = enemy destroyed by the author,
      // emitted at the same clock as the damage event that killed it.
      if (m[0] === 1 || m[0] === 3) events.push({ entity, ev: m[0], clock: p.clock, cum: mdv.getUint16(4, true) });
    }
  }
  if (gameEntity === null) return [];
  const shots = []; let prevCum = 0, pendingKill = false;
  for (const e of events) {
    if (e.entity !== gameEntity) continue;
    if (e.ev === 3) { pendingKill = true; continue; }
    const delta = e.cum - prevCum;
    if (delta > 0) { shots.push({ clock: e.clock, damage: delta, cumulative: e.cum, kill: pendingKill }); prevCum = e.cum; }
    pendingKill = false;
  }
  return shots;
}
// Direct-hit packets (sub_type 8, 33-byte payload): shooter, victim, ammo slot, damage.
export function extractHits(data) {
  const hits = [];
  for (const p of packets(data)) {
    if (p.type !== 8 || p.payload.length !== 33) continue;
    const dv = new DataView(p.payload.buffer, p.payload.byteOffset, p.payload.byteLength);
    if (dv.getUint32(4, true) !== 8) continue;
    // byte 20 = damage-applied flag; when 0 the damage field is the shell's listed alpha.
    // byte 17 = shell id: (gun block << 2) | slot; low two bits 0/1/2 = standard/premium/HE
    // (3 appears on some tanks — treated as unknown). Verified on FV215b 183 and BZT-70.
    const hitType = p.payload[21], slot = p.payload[29] & 3;
    hits.push({ clock: p.clock, shooter: dv.getUint32(12, true), victim: dv.getUint32(16, true), hitType, ammo: slot < 3 ? slot : null, damage: dv.getUint16(30, true), applied: p.payload[32] !== 0 });
  }
  return hits;
}
// HP updates (sub_type 1, 7-byte method data on the victim entity): u16 HP remaining,
// u32 attacker, u8 flag (1 = damage over time, i.e. fire). The author's deltas sum to the
// results-screen damage exactly, fire included.
export function extractHpUpdates(data) {
  const out = [];
  for (const p of packets(data)) {
    if (p.type !== 8 || p.payload.length !== 19) continue;
    const dv = new DataView(p.payload.buffer, p.payload.byteOffset, p.payload.byteLength);
    if (dv.getUint32(4, true) !== 1) continue;
    out.push({ clock: p.clock, victim: dv.getUint32(0, true), hp: dv.getUint16(12, true), attacker: dv.getUint32(14, true), dot: p.payload[18] === 1 });
  }
  return out;
}
// The author is the shooter whose applied hit damages best cover the cumulative deltas.
export function findAuthor(shots, hits) {
  const byShooter = new Map();
  for (const h of hits) { if (!byShooter.has(h.shooter)) byShooter.set(h.shooter, []); byShooter.get(h.shooter).push(h); }
  let best = null, bestScore = 0;
  for (const [shooter, list] of byShooter) {
    const pool = list.filter(h => h.applied).map(h => h.damage); let score = 0;
    for (const s of shots) { const i = pool.indexOf(s.damage); if (i >= 0) { score++; pool.splice(i, 1); } }
    if (score > bestScore) { bestScore = score; best = shooter; }
  }
  return bestScore >= Math.max(1, Math.ceil(shots.length / 2)) ? best : null;
}
// Shot list from HP updates: direct hits (paired with the hit record for shell/type), fire
// ticks grouped per victim, kills where HP reaches 0, and the author's no-damage hits.
export function shotsFromHp(hpEvents, author, hits) {
  const hp = new Map(), rows = [], unusedHits = hits.filter(h => h.shooter === author);
  let fire = null;
  const closeFire = () => { if (fire) { rows.push(fire); fire = null; } };
  for (const e of hpEvents) {
    const prev = hp.get(e.victim); hp.set(e.victim, e.hp);
    if (e.attacker !== author) continue;
    if (e.dot) {
      if (prev === undefined) continue;
      const delta = prev - e.hp; if (delta <= 0) continue;
      if (fire && (fire.victim !== e.victim || e.clock - fire.lastClock > 4)) closeFire();
      if (!fire) fire = { clock: e.clock, lastClock: e.clock, victim: e.victim, damage: 0, ticks: 0, fire: true, kill: false, ammo: null, hitType: null, cumulative: null };
      fire.damage += delta; fire.ticks += 1; fire.lastClock = e.clock; if (e.hp === 0) fire.kill = true;
      continue;
    }
    closeFire();
    let hi = -1, best = 0.5;
    unusedHits.forEach((h, i) => { if (h.applied && h.victim === e.victim && Math.abs(h.clock - e.clock) < best) { best = Math.abs(h.clock - e.clock); hi = i; } });
    const h = hi >= 0 ? unusedHits.splice(hi, 1)[0] : null;
    const delta = prev !== undefined ? prev - e.hp : (h ? h.damage : 0);
    if (delta <= 0) continue;
    rows.push({ clock: e.clock, damage: delta, kill: e.hp === 0, ammo: h ? h.ammo : null, hitType: h ? h.hitType : null, cumulative: null, victim: e.victim });
  }
  closeFire();
  for (const h of unusedHits) if (!h.applied) rows.push({ clock: h.clock, damage: 0, roll: h.damage, noDamage: true, cumulative: null, ammo: h.ammo, hitType: h.hitType, kill: false });
  rows.sort((a, b) => a.clock - b.clock);
  let cum = 0; for (const r of rows) { cum += r.damage; r.cumulative = cum; }
  return rows;
}
// Fallback when a replay has no HP updates: pair damage deltas with the author's hit records.
export function assignAmmo(shots, hits, hpEvents) {
  const plain = shots.map(s => ({ ...s, ammo: null }));
  if (!shots.length || !hits.length) return plain;
  const author = findAuthor(shots, hits);
  if (author === null) return plain;
  if (hpEvents && hpEvents.some(e => e.attacker === author)) return shotsFromHp(hpEvents, author, hits);
  const unused = hits.filter(h => h.shooter === author);
  const out = shots.map(s => {
    const i = unused.findIndex(h => h.applied && h.damage === s.damage);
    if (i < 0) return { ...s, ammo: null };
    const [h] = unused.splice(i, 1);
    return { ...s, clock: h.clock, ammo: h.ammo, hitType: h.hitType };
  });
  for (const h of unused) if (!h.applied) out.push({ clock: h.clock, damage: 0, roll: h.damage, noDamage: true, cumulative: null, ammo: h.ammo, hitType: h.hitType, kill: false });
  return out.sort((a, b) => a.clock - b.clock);
}
export function prettyVehicle(code) { return code ? code.replace(/^[A-Za-z]{1,3}\d{1,4}_/, '').replace(/_/g, ' ') : ''; }
// `raw: true` also returns the decoded streams the highlight finder needs (lib/highlights.js):
// the author's entity id, every HP update and every direct-hit record.
export async function parseReplay(name, buf, { raw = false } = {}) {
  const zip = await readZip(buf);
  const out = { file: name, vehicle: '', vehicleCode: '', map: '', player: '', duration: 0, tankId: 0, shots: [], error: null };
  const metaBytes = await zip.read('meta.json');
  if (metaBytes) {
    try {
      const meta = JSON.parse(new TextDecoder().decode(metaBytes));
      const key = Object.keys(meta).find(k => k.toLowerCase() === 'playervehiclename');
      out.vehicleCode = key ? String(meta[key]) : '';
      out.vehicle = prettyVehicle(out.vehicleCode) || (meta.vehicleCompDescriptor ? 'tank #' + meta.vehicleCompDescriptor : 'unknown tank');
      out.tankId = +meta.vehicleCompDescriptor || 0;
      out.map = meta.mapName || ''; out.player = meta.playerName || ''; out.duration = +meta.battleDuration || 0;
    } catch (e) { out.error = 'meta.json unreadable'; }
  }
  const stream = await zip.read('data.wotreplay');
  if (!stream) { out.error = 'no battle data inside the archive'; return out; }
  const shots = extractShots(stream), hits = extractHits(stream), hpEvents = extractHpUpdates(stream);
  out.shots = assignAmmo(shots, hits, hpEvents);
  if (raw) out.raw = { author: findAuthor(shots, hits), hits, hpEvents };
  if (!out.shots.length) out.error = out.error || 'no damage events found in this replay';
  return out;
}


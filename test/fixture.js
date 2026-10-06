// Builds a tiny synthetic .wotbreplay (stored zip: meta.json + data.wotreplay) whose packet
// stream exercises the page's parser: one author with two direct hits, the second a kill.
// Layout of the packets mirrors what index.html decodes — see the comments there.

import { writeFileSync } from 'node:fs';

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) { c = (crc ^ buf[n]) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crc = (crc >>> 8) ^ c; }
  return (crc ^ 0xffffffff) >>> 0;
}
function storedZip(entries) {
  const locals = [], centrals = []; let offset = 0;
  for (const [name, data] of entries) {
    const n = Buffer.from(name), crc = crc32(data);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0, 8); lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(n.length, 26);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0, 10); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(n.length, 28); ch.writeUInt32LE(offset, 42);
    locals.push(lh, n, data); centrals.push(ch, n); offset += lh.length + n.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22); eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10); eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

export function packet(clock, payload) {
  const h = Buffer.alloc(12); h.writeUInt32LE(payload.length, 0); h.writeUInt32LE(8, 4); h.writeFloatLE(clock, 8);
  return Buffer.concat([h, payload]);
}
const u32 = v => { const b = Buffer.alloc(4); b.writeUInt32LE(v); return b; };
const u16 = v => { const b = Buffer.alloc(2); b.writeUInt16LE(v); return b; };

export const GAME = 1, AUTHOR = 100, VICTIM = 200;
export const sub20 = Buffer.concat([u32(GAME), u32(20), Buffer.alloc(8)]);
export const hp = (clock, victim, hpLeft, attacker, dot) => packet(clock, Buffer.concat([u32(victim), u32(1), Buffer.alloc(4), u16(hpLeft), u32(attacker), Buffer.from([dot ? 1 : 0])]));
export const hit = (clock, shooter, victim, type, shellId, damage, applied) => { const p = Buffer.alloc(33); u32(victim).copy(p, 0); u32(8).copy(p, 4); u32(shooter).copy(p, 12); u32(victim).copy(p, 16); p[21] = type; p[29] = shellId; u16(damage).copy(p, 30); p[32] = applied ? 1 : 0; return packet(clock, p); };
export const ev = (clock, evType, cum) => { const m = Buffer.alloc(6); m[0] = evType; u16(cum).copy(m, 4); return packet(clock, Buffer.concat([u32(GAME), u32(12), Buffer.alloc(4), m])); };

const HEADER = Buffer.concat([Buffer.alloc(12), Buffer.from([3]), Buffer.from('abc'), Buffer.from([2]), Buffer.from('xy'), Buffer.alloc(1)]);

/** Any replay: meta.json + a packet stream of the given packets (built with hp / hit / ev / sub20 above). */
export function buildReplay(meta, packets) {
  return storedZip([['meta.json', Buffer.from(JSON.stringify(meta))], ['data.wotreplay', Buffer.concat([HEADER, ...packets])]]);
}

export function makeReplay({ seed = 0 } = {}) {
  const stream = Buffer.concat([
    HEADER,
    packet(0.5, sub20),
    hp(10, VICTIM, 1800, 0, false),                 // first sighting of the victim's HP
    hit(53.9, AUTHOR, VICTIM, 3, 0x0d, 1204, true),  // HESH (slot 1) pen for 1204
    hp(53.9, VICTIM, 596, AUTHOR, false),
    ev(55.1, 1, 1204),
    hit(108.1, AUTHOR, VICTIM, 3, 0x0d, 596, true),  // killing blow: damage == remaining HP
    hp(108.1, VICTIM, 0, AUTHOR, false),
    ev(109.3, 3, 1), ev(109.3, 1, 1800),
    hit(194.0, AUTHOR, VICTIM, 1, 0x0c, 950, false), // ricochet with AP (slot 0)
  ]);
  const meta = { playerVehicleName: 'GB48_FV215b_183', vehicleCompDescriptor: 9297, mapName: 'rock', playerName: 'alex', battleDuration: 254.8, seed };
  return storedZip([['meta.json', Buffer.from(JSON.stringify(meta))], ['data.wotreplay', stream]]);
}

if (process.argv[1] && process.argv[1].endsWith('fixture.js')) {
  const out = process.argv[2] || 'test/20260911_1225_GB48_FV215b_183.wotbreplay';
  writeFileSync(out, makeReplay()); console.log('wrote', out);
}

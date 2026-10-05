// Clip-kill detection, run against the page's own parser.
//
// The detector lives in index.html (the page is a single file), so the test lifts the parser
// block out of the HTML and evaluates it — the same code the browser runs, not a copy. Each
// case is a synthetic replay from test/fixture.js whose packet stream is written by hand, so
// the expected answer is known exactly.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeReplay } from './fixture.js';
import { summaryFromBody } from '../lib/replays.js';

const html = readFileSync('index.html', 'utf8');
const start = html.indexOf('// ---------- parser'), end = html.indexOf('// ---------- app ----------');
assert.ok(start > 0 && end > start, 'parser block found in index.html');
const parser = new Function(html.slice(start, end) + '\nreturn { parseReplay, findClips, shellBursts };')();

const parse = async scenario => {
  const b = makeReplay(scenario ? { scenario } : {});
  return parser.parseReplay('20260911_1225_GB48_FV215b_183.wotbreplay', b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
};
const clipsOf = async scenario => parser.findClips((await parse(scenario)).shots);

test('a magazine that takes a full-health tank to zero is a clip kill', async () => {
  const clips = await clipsOf('clip');
  assert.equal(clips.length, 1);
  const c = clips[0];
  assert.equal(c.kind, 'clip');
  assert.equal(c.shells, 3);
  assert.equal(c.magazine, 3);
  assert.equal(c.damage, 1600);
  assert.equal(c.fullHp, 1600);
  assert.equal(c.startHp, 1600);
  assert.equal(c.outside, 0);
  assert.deepEqual(c.reasons, []);
  assert.ok(Math.abs(c.duration - 4.4) < 0.01, 'kill 4.4 s after the first shell');
  assert.ok(Math.abs(c.inPoint - 54) < 0.01, 'in-point six seconds before the first shell');
});

test('a team-mate chipping in downgrades it to a near clip and says so', async () => {
  const [c] = await clipsOf('assist');
  assert.equal(c.kind, 'near');
  assert.equal(c.outside, 100);
  assert.equal(c.ownFire, false);
  assert.equal(c.startHp, 1600);
  assert.match(c.reasons.join(' '), /from someone else/);
});

test('a target that was already damaged is not a clip kill', async () => {
  const [c] = await clipsOf('chipped');
  assert.equal(c.kind, 'loose');
  assert.equal(c.fullHp, 1600, 'the pool is still recovered from the first hit anyone landed');
  assert.equal(c.startHp, 1400);
  assert.equal(Math.round(c.startPct), 88);
  assert.match(c.reasons.join(' '), /started at 88%/);
});

test('a fast single-shot gun is not mistaken for a magazine', async () => {
  const [c] = await clipsOf('singleshot');
  assert.equal(c.kind, 'loose');
  assert.equal(c.startHp, 1600, 'it did kill from full health — only the timing rules it out');
  assert.match(c.reasons.join(' '), /too slow for a magazine/);
});

test('two far-apart shots are not a clip, and the default fixture claims nothing', async () => {
  const r = await parse(null);
  assert.equal(r.shots.filter(s => s.damage > 0).length, 2);
  assert.deepEqual(parser.findClips(r.shots).filter(c => c.kind !== 'loose'), []);
  assert.equal(parser.shellBursts(r.shots).length, 3, 'two hits and a ricochet, each its own burst');
});

test('the HP fields survive a round trip through the library, so a stored replay scores the same', async () => {
  const r = await parse('clip');
  const stored = summaryFromBody({
    sha256: 'a'.repeat(64), file_name: r.file, file_size: 1234,
    parsed: { tankId: r.tankId, vehicleCode: r.vehicleCode, vehicle: r.vehicle, map: r.map, player: r.player, duration: r.duration, shots: r.shots, error: r.error },
  });
  const before = parser.findClips(r.shots), after = parser.findClips(JSON.parse(JSON.stringify(stored.shots)));
  assert.deepEqual(after, before);
  assert.equal(after[0].kind, 'clip');
});

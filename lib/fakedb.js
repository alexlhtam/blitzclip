// In-memory stand-in for Postgres used by the local test harness (BLITZCLIP_FAKE_DB=1).
// It understands exactly the statements in api/ — it is not a SQL engine.

const users = [];
const replays = [];
const wiSeen = new Map(), wiCandidates = new Map(), wiRuns = [];
let nextUser = 1, nextReplay = 1;

const norm = s => s.replace(/\s+/g, ' ').trim().toLowerCase();

export async function fakeQuery(text, params = []) {
  const t = norm(text);
  if (t.startsWith('create table') || t.startsWith('create index')) return { rows: [] };

  if (t.startsWith('insert into users')) {
    const [email, password_hash] = params;
    if (users.some(u => u.email === email)) { const e = new Error('duplicate key value violates unique constraint "users_email_key"'); e.code = '23505'; throw e; }
    const u = { id: nextUser++, email, password_hash, tanks: null, created_at: new Date() };
    users.push(u); return { rows: [{ id: u.id, email: u.email }] };
  }
  if (t.startsWith('select id, email, password_hash from users where email')) return { rows: users.filter(u => u.email === params[0]).map(u => ({ id: u.id, email: u.email, password_hash: u.password_hash })) };
  if (t.startsWith('select id, email, tanks from users where id')) return { rows: users.filter(u => u.id === Number(params[0])).map(u => ({ id: u.id, email: u.email, tanks: u.tanks })) };
  if (t.startsWith('update users set tanks')) { const u = users.find(u => u.id === Number(params[1])); if (u) u.tanks = params[0] === null ? null : JSON.parse(params[0]); return { rows: [] }; }

  if (t.startsWith('insert into replays')) {
    const [user_id, sha256, file_name, file_size, blob_url, blob_pathname, tank_id, vehicle_code, vehicle, map, player, duration, max_shot, total_damage, kills, shots, error, parser_version, battle_time] = params;
    const existing = replays.find(r => r.user_id === Number(user_id) && r.sha256 === sha256);
    if (existing) return { rows: [] }; // ON CONFLICT DO NOTHING
    const r = { id: nextReplay++, user_id: Number(user_id), sha256, file_name, file_size, blob_url, blob_pathname, tank_id, vehicle_code, vehicle, map, player, duration, max_shot, total_damage, kills, shots: JSON.parse(shots), error, parser_version, battle_time: battle_time ? new Date(battle_time) : null, status: 'new', note: null, created_at: new Date() };
    replays.push(r); return { rows: [publicRow(r)] };
  }
  if (t.startsWith('select') && t.includes('from replays where user_id = $1 and sha256')) return { rows: replays.filter(r => r.user_id === Number(params[0]) && r.sha256 === params[1]).map(publicRow) };
  if (t.startsWith('select') && t.includes('from replays where user_id = $1 and id = $2')) return { rows: replays.filter(r => r.user_id === Number(params[0]) && r.id === Number(params[1])).map(publicRow) };
  if (t.startsWith('select') && t.includes('from replays where user_id = $1 order by')) return { rows: replays.filter(r => r.user_id === Number(params[0])).sort((a, b) => b.created_at - a.created_at || b.id - a.id).map(publicRow) };
  if (t.startsWith('select sha256 from replays where user_id')) return { rows: replays.filter(r => r.user_id === Number(params[0])).map(r => ({ sha256: r.sha256 })) };
  if (t.startsWith('update replays set status')) {
    const r = replays.find(r => r.user_id === Number(params[2]) && r.id === Number(params[3]));
    if (!r) return { rows: [] };
    if (params[0] !== null) r.status = params[0];
    if (params[1] !== null) r.note = params[1];
    return { rows: [publicRow(r)] };
  }
  if (t.startsWith('update replays set blob_url')) {
    const r = replays.find(r => r.user_id === Number(params[3]) && r.id === Number(params[4]) && r.blob_url === null);
    if (!r) return { rows: [] };
    r.blob_url = params[0]; r.blob_pathname = params[1]; r.file_size = params[2]; return { rows: [publicRow(r)] };
  }
  if (t.startsWith('delete from replays where user_id = $1 and id = $2')) {
    const i = replays.findIndex(r => r.user_id === Number(params[0]) && r.id === Number(params[1]));
    if (i < 0) return { rows: [] };
    const [r] = replays.splice(i, 1); return { rows: [{ blob_url: r.blob_url }] };
  }
  // WoTInspector finder (lib/wotinspector-db.js)
  if (t.startsWith('select id from wi_seen where id = any')) return { rows: params[0].filter(id => wiSeen.has(id)).map(id => ({ id })) };
  if (t.startsWith('insert into wi_seen')) { for (const { id, verdict } of JSON.parse(params[0])) if (!wiSeen.has(id)) wiSeen.set(id, verdict); return { rows: [] }; }
  if (t.startsWith('insert into wi_candidates')) { for (const { id, data } of JSON.parse(params[0])) wiCandidates.set(id, { data, found_at: wiCandidates.get(id)?.found_at || new Date() }); return { rows: [] }; }
  if (t.startsWith('select data from wi_candidates')) return { rows: [...wiCandidates.values()].sort((a, b) => b.found_at - a.found_at).slice(0, Number(params[0])).map(c => ({ data: c.data })) };
  if (t.startsWith('select id, trigger, started_at, finished_at, stats from wi_runs')) return { rows: wiRuns.slice(-1) };
  if (t.startsWith('insert into wi_runs')) { const r = { id: wiRuns.length + 1, trigger: params[0], started_at: new Date(fakeNow()), finished_at: null, stats: null }; wiRuns.push(r); return { rows: [{ id: r.id, started_at: r.started_at }] }; }
  if (t.startsWith('update wi_runs set finished_at')) { const r = wiRuns.find(r => r.id === Number(params[1])); if (r) { r.finished_at = new Date(fakeNow()); r.stats = JSON.parse(params[0]); } return { rows: [] }; }
  throw new Error('fakedb: unhandled statement: ' + t.slice(0, 80));
}

function publicRow(r) { const { user_id, ...rest } = r; return { ...rest }; }

// Tests can move the fake clock that stamps wi_runs (cooldowns are measured against it).
let fakeNow = () => Date.now();
export function _setNow(fn) { fakeNow = fn || (() => Date.now()); }

export function _reset() { users.length = 0; replays.length = 0; nextUser = 1; nextReplay = 1; wiSeen.clear(); wiCandidates.clear(); wiRuns.length = 0; }

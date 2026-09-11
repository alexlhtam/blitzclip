import { route, readJson, json, error } from '../../lib/http.js';
import { summaryFromBody, insertReplay, listReplays } from '../../lib/replays.js';

// GET  /api/replays  → every stored replay for the signed-in user (newest first)
// POST /api/replays  → store a parsed replay summary (idempotent on sha256)
export const GET = route(async (request, user) => json({ replays: await listReplays(user.id) }, { headers: { 'cache-control': 'no-store' } }), { auth: true });

export const POST = route(async (request, user) => {
  const body = await readJson(request, 1 << 20);
  let summary;
  try { summary = summaryFromBody(body); } catch (e) { return error(400, e.message); }
  const { replay, existing } = await insertReplay(user.id, summary);
  return json({ replay, existing }, { status: existing ? 200 : 201 });
}, { auth: true });

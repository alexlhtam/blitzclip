import { q } from '../lib/db.js';
import { route, readJson, json, error } from '../lib/http.js';

// Per-user tank max-roll table. null = "use the page defaults".
export const GET = route(async (request, user) => json({ tanks: user.tanks ?? null }, { headers: { 'cache-control': 'no-store' } }), { auth: true });

export const PUT = route(async (request, user) => {
  const { tanks } = await readJson(request, 256 * 1024);
  if (tanks !== null && !Array.isArray(tanks)) return error(400, 'tanks must be an array or null');
  await q('UPDATE users SET tanks = $1::jsonb WHERE id = $2', [tanks === null ? null : JSON.stringify(tanks), user.id]);
  return json({ ok: true });
}, { auth: true });

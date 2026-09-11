import { route, readJson, json, error, idFromUrl } from '../../lib/http.js';
import { getReplay, updateReplay, deleteReplay, STATUSES } from '../../lib/replays.js';
import { deleteBlob } from '../../lib/blob.js';

// GET    /api/replays/:id  → one replay
// PATCH  /api/replays/:id  → { status?, note? }
// DELETE /api/replays/:id  → removes the row and the stored .wotbreplay
export const GET = route(async (request, user) => {
  const r = await getReplay(user.id, idFromUrl(request));
  return r ? json({ replay: r }, { headers: { 'cache-control': 'no-store' } }) : error(404, 'No such replay');
}, { auth: true });

export const PATCH = route(async (request, user) => {
  const body = await readJson(request, 64 * 1024);
  const status = body.status === undefined ? null : String(body.status);
  if (status !== null && !STATUSES.includes(status)) return error(400, 'status must be one of ' + STATUSES.join(', '));
  const note = body.note === undefined ? null : String(body.note).slice(0, 2000);
  const r = await updateReplay(user.id, idFromUrl(request), { status, note });
  return r ? json({ replay: r }) : error(404, 'No such replay');
}, { auth: true });

export const DELETE = route(async (request, user) => {
  const r = await deleteReplay(user.id, idFromUrl(request));
  if (!r) return error(404, 'No such replay');
  await deleteBlob(r.blob_url);
  return json({ ok: true });
}, { auth: true });

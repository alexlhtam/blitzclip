import { route, error, idFromUrl } from '../../../lib/http.js';
import { getReplay } from '../../../lib/replays.js';
import { fetchBlob } from '../../../lib/blob.js';

// GET /api/replays/:id/file → the stored .wotbreplay (the Blob store is private; this proxies it
// with the function's credentials after checking the replay belongs to the signed-in user).
export const GET = route(async (request, user) => {
  const r = await getReplay(user.id, idFromUrl(request));
  if (!r) return error(404, 'No such replay');
  if (!r.blob_url) return error(404, 'The replay file was not stored for this battle');
  const blob = await fetchBlob(r.blob_url, request);
  if (!blob) return error(404, 'The stored file is missing');
  const name = r.file_name.replace(/[^\w.\-]+/g, '_');
  return new Response(blob.body, { status: 200, headers: { 'content-type': 'application/zip', 'content-disposition': `attachment; filename="${name}"`, 'cache-control': 'private, max-age=0' } });
}, { auth: true });

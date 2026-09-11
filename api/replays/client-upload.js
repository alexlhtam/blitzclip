import { route, readJson, json, error } from '../../lib/http.js';
import { clientUploadHandler, isBlobConfigured } from '../../lib/blob.js';
import { currentUser } from '../../lib/auth.js';

// POST /api/replays/client-upload — Vercel Blob client-upload token exchange, so the browser can
// send large replays straight to Blob (functions cap request bodies at 4.5 MB).
// The same URL receives Blob's signed "upload completed" callback, which carries no session.
export const POST = route(async request => {
  if (!isBlobConfigured()) return error(503, 'Replay file storage is not configured (add a Blob store to the Vercel project)');
  const body = await readJson(request, 64 * 1024);
  let userId = null;
  if (body.type !== 'blob.upload-completed') {
    const user = await currentUser(request);
    if (!user) return error(401, 'Sign in to do that');
    userId = user.id;
  }
  try {
    return json(await clientUploadHandler({ body, request, userId }));
  } catch (e) {
    return error(400, e.message);
  }
});

import { currentUser } from '../../lib/auth.js';
import { isBlobConfigured, blobDiagnostics } from '../../lib/blob.js';
import { route, json } from '../../lib/http.js';

// Who am I? Also tells the page whether raw-replay storage is available.
export const GET = route(async request => {
  const user = await currentUser(request);
  const out = { user: user ? { id: user.id, email: user.email } : null, blob: isBlobConfigured() };
  if (new URL(request.url).searchParams.has('diag')) out.diag = await blobDiagnostics(request);
  return json(out, { headers: { 'cache-control': 'no-store' } });
});

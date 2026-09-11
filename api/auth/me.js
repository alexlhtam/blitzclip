import { currentUser } from '../../lib/auth.js';
import { isBlobConfigured } from '../../lib/blob.js';
import { route, json } from '../../lib/http.js';

// Who am I? Also tells the page whether raw-replay storage is available.
export const GET = route(async request => {
  const user = await currentUser(request);
  return json({ user: user ? { id: user.id, email: user.email } : null, blob: isBlobConfigured() }, { headers: { 'cache-control': 'no-store' } });
});

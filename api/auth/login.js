import { one } from '../../lib/db.js';
import { verifyPassword, makeSession } from '../../lib/auth.js';
import { route, readJson, json, error, withSession } from '../../lib/http.js';

export const POST = route(async request => {
  const { email, password } = await readJson(request, 4096);
  const e = String(email || '').trim().toLowerCase();
  const user = await one('SELECT id, email, password_hash FROM users WHERE email = $1', [e]);
  const ok = user && typeof password === 'string' && await verifyPassword(password, user.password_hash);
  if (!ok) return error(401, 'Wrong email or password');
  return withSession(json({ user: { id: user.id, email: user.email } }), makeSession(user), request);
});

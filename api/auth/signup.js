import { q } from '../../lib/db.js';
import { hashPassword, makeSession, validEmail, validPassword } from '../../lib/auth.js';
import { route, readJson, json, error, withSession } from '../../lib/http.js';

export const POST = route(async request => {
  const { email, password } = await readJson(request, 4096);
  const e = String(email || '').trim().toLowerCase();
  if (!validEmail(e)) return error(400, 'Enter a valid email address');
  if (!validPassword(password)) return error(400, 'Password must be at least 8 characters');
  if (process.env.SIGNUP_ALLOWLIST && !process.env.SIGNUP_ALLOWLIST.split(',').map(s => s.trim().toLowerCase()).includes(e)) return error(403, 'Sign-ups are limited to invited emails');
  let row;
  try {
    ({ rows: [row] } = await q('INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id, email', [e, await hashPassword(password)]));
  } catch (err) {
    if (err.code === '23505' || /users_email_key|duplicate key/.test(err.message)) return error(409, 'An account with that email already exists — sign in instead');
    throw err;
  }
  return withSession(json({ user: { id: row.id, email: row.email } }, { status: 201 }), makeSession(row), request);
});

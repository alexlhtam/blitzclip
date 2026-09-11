// Email + password accounts with HMAC-signed session cookies. No dependencies.
//
// Password hashes: scrypt (N=2^15, r=8, p=1), stored as "scrypt$<salt b64url>$<hash b64url>".
// Session cookie: "<payload b64url>.<hmac b64url>" where payload = {uid, email, exp}.
// AUTH_SECRET must be set in production (any long random string).

import { scrypt, randomBytes, timingSafeEqual, createHmac } from 'node:crypto';
import { promisify } from 'node:util';
import { one } from './db.js';

const scryptAsync = promisify(scrypt);
const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const SESSION_DAYS = 30;
export const COOKIE = 'bc_session';

const b64u = buf => Buffer.from(buf).toString('base64url');
const unb64u = s => Buffer.from(s, 'base64url');

export function secret() {
  const s = process.env.AUTH_SECRET;
  if (s && s.length >= 16) return s;
  if (process.env.NODE_ENV !== 'production' || process.env.BLITZCLIP_FAKE_DB === '1') return 'dev-secret-not-for-production';
  throw new Error('AUTH_SECRET is not set (add a long random string to the Vercel project environment).');
}

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = await scryptAsync(password.normalize('NFKC'), salt, 64, SCRYPT);
  return `scrypt$${b64u(salt)}$${b64u(hash)}`;
}

export async function verifyPassword(password, stored) {
  const [algo, saltB, hashB] = String(stored || '').split('$');
  if (algo !== 'scrypt' || !saltB || !hashB) return false;
  const expected = unb64u(hashB);
  const actual = await scryptAsync(password.normalize('NFKC'), unb64u(saltB), expected.length, SCRYPT);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function sign(payloadB64) {
  return b64u(createHmac('sha256', secret()).update(payloadB64).digest());
}

export function makeSession(user) {
  const payload = b64u(JSON.stringify({ uid: user.id, email: user.email, exp: Date.now() + SESSION_DAYS * 864e5 }));
  return `${payload}.${sign(payload)}`;
}

export function readSession(token) {
  if (!token) return null;
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return null;
  const expected = sign(payload);
  const a = Buffer.from(sig), b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const data = JSON.parse(unb64u(payload).toString('utf8'));
    if (!data.uid || !data.exp || data.exp < Date.now()) return null;
    return { uid: Number(data.uid), email: data.email };
  } catch { return null; }
}

export function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function sessionCookie(token, { clear = false, secure = true } = {}) {
  const attrs = ['Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (secure) attrs.push('Secure');
  attrs.push(clear ? 'Max-Age=0' : `Max-Age=${SESSION_DAYS * 86400}`);
  return `${COOKIE}=${clear ? '' : token}; ${attrs.join('; ')}`;
}

/** Session from a Request, or null. */
export function sessionFromRequest(request) {
  return readSession(parseCookies(request.headers.get('cookie'))[COOKIE]);
}

/** Full user row for the current session, or null (also null if the account was deleted). */
export async function currentUser(request) {
  const s = sessionFromRequest(request);
  if (!s) return null;
  return one('SELECT id, email, tanks FROM users WHERE id = $1', [s.uid]);
}

export function validEmail(e) { return typeof e === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && e.length <= 254; }
export function validPassword(p) { return typeof p === 'string' && p.length >= 8 && p.length <= 200; }

// Small helpers for the Web-API style handlers under api/.

import { currentUser, sessionCookie } from './auth.js';
import { DbError, isConfigured } from './db.js';

export const json = (data, init = {}) => Response.json(data, init);
export const error = (status, message, extra = {}) => Response.json({ error: message, ...extra }, { status });

export function isSecure(request) {
  const proto = request.headers.get('x-forwarded-proto') || new URL(request.url).protocol.replace(':', '');
  return proto === 'https';
}

export async function readJson(request, limit = 1 << 20) {
  const len = Number(request.headers.get('content-length') || 0);
  if (len > limit) throw new HttpError(413, 'Request body too large');
  const text = await request.text();
  if (text.length > limit) throw new HttpError(413, 'Request body too large');
  try { return text ? JSON.parse(text) : {}; } catch { throw new HttpError(400, 'Body must be JSON'); }
}

export class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }

/** Wrap a handler: uniform error responses, DB-not-configured message, CSRF origin check on writes. */
export function route(fn, { auth = false } = {}) {
  return async request => {
    try {
      if (!isConfigured()) return error(503, 'Server storage is not configured yet: add a Neon Postgres database and a Blob store to the Vercel project, then redeploy.');
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        const origin = request.headers.get('origin');
        const host = request.headers.get('x-forwarded-host') || request.headers.get('host');
        if (origin && host && new URL(origin).host !== host) return error(403, 'Cross-site request refused');
      }
      let user = null;
      if (auth) {
        user = await currentUser(request);
        if (!user) return error(401, 'Sign in to do that');
      }
      return await fn(request, user);
    } catch (e) {
      if (e instanceof HttpError) return error(e.status, e.message);
      if (e instanceof DbError) return error(503, e.message);
      console.error(e);
      return error(500, 'Something went wrong on the server' + (process.env.NODE_ENV !== 'production' ? ': ' + e.message : ''));
    }
  };
}

export function withSession(response, token, request, clear = false) {
  const headers = new Headers(response.headers);
  headers.append('set-cookie', sessionCookie(token, { clear, secure: isSecure(request) }));
  return new Response(response.body, { status: response.status, headers });
}

/** Last numeric path segment, e.g. /api/replays/42 → 42. */
export function idFromUrl(request) {
  const m = new URL(request.url).pathname.match(/\/(\d+)\/?$/);
  return m ? Number(m[1]) : null;
}

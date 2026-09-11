import { route, json, withSession } from '../../lib/http.js';

export const POST = route(async request => withSession(json({ ok: true }), '', request, true));

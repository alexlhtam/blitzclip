import { route, json, error } from '../../lib/http.js';
import { refresh } from '../../lib/wotinspector-db.js';

// GET  /api/wotinspector/refresh → Vercel Cron (vercel.json). With CRON_SECRET set, Vercel sends it
//      as a bearer token and nothing else may call this; without it, only the cron user agent is let in.
// POST /api/wotinspector/refresh → "Check now" on the page, for signed-in users (15-minute cooldown).
export const GET = route(async request => {
  const secret = process.env.CRON_SECRET;
  const ok = secret ? request.headers.get('authorization') === `Bearer ${secret}` : /vercel-cron/i.test(request.headers.get('user-agent') || '');
  if (!ok) return error(401, 'Cron only');
  return json(await refresh({ trigger: 'cron' }));
});

export const POST = route(async () => {
  const res = await refresh({ trigger: 'manual' });
  return json(res, { status: res.ran ? 200 : 429 });
}, { auth: true });

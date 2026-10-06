import { route, json } from '../../lib/http.js';
import { listCandidates, lastRun } from '../../lib/wotinspector-db.js';

// GET /api/wotinspector → the hits the finder has found on WoTInspector (max rolls first) and the
// last run. Public: it is WoTInspector's public data, and the page shows it signed out too.
export const GET = route(async () => {
  const [candidates, last] = await Promise.all([listCandidates(), lastRun()]);
  return json({ candidates, last_run: last });
});

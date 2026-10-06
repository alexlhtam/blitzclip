// The WoTInspector content finder as the web app runs it: the same scraper as the CLI
// (service/scrape-wotinspector.js), with what it has seen and found kept in Postgres so the page
// can list the hits. A run is time-boxed to fit a serverless function and resumes where it left off.

import { q, one } from './db.js';
import { buildTankIndex } from './highlights.js';
import { run, rank, makeWiClient } from '../service/scrape-wotinspector.js';
import shared from '../data/tanks.json' with { type: 'json' };

export const RUN_BUDGET_MS = 45_000; // the function is allowed 60 s (vercel.json)
export const MANUAL_COOLDOWN_MS = 15 * 60_000; // "Check now" at most every 15 minutes
const STALE_RUN_MS = 2 * 60_000; // an unfinished run older than this died with its function
const RPS = 1; // one request a second — ~45 per run, a run a day from the cron

export function dbStore() {
  return {
    async seenIds(ids) {
      if (!ids.length) return new Set();
      const { rows } = await q('SELECT id FROM wi_seen WHERE id = ANY($1::text[])', [ids]);
      return new Set(rows.map(r => r.id));
    },
    async flush({ seen, found }) {
      const s = Object.entries(seen).map(([id, verdict]) => ({ id, verdict }));
      if (s.length) await q('INSERT INTO wi_seen (id, verdict) SELECT x.id, x.verdict FROM jsonb_to_recordset($1::jsonb) AS x(id text, verdict jsonb) ON CONFLICT (id) DO NOTHING', [JSON.stringify(s)]);
      if (found.length) await q('INSERT INTO wi_candidates (id, data) SELECT x.id, x.data FROM jsonb_to_recordset($1::jsonb) AS x(id text, data jsonb) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data', [JSON.stringify(found.map(c => ({ id: c.id, data: c })))]);
    },
    async all() { return listCandidates(); },
  };
}

export async function listCandidates(limit = 300) {
  const { rows } = await q('SELECT data FROM wi_candidates ORDER BY found_at DESC LIMIT $1', [limit]);
  return rank(rows.map(r => typeof r.data === 'string' ? JSON.parse(r.data) : r.data));
}

export async function lastRun() {
  const r = await one('SELECT id, trigger, started_at, finished_at, stats FROM wi_runs ORDER BY id DESC LIMIT 1');
  return r && { ...r, stats: typeof r.stats === 'string' ? JSON.parse(r.stats) : r.stats };
}

/**
 * Run the finder once if allowed. trigger = 'cron' | 'manual'. Returns { ran, reason?, run? }.
 * Manual runs wait out MANUAL_COOLDOWN_MS after the last start; nothing starts while a run is live.
 */
export async function refresh({ trigger, client, budgetMs = RUN_BUDGET_MS, now = Date.now, log = console.log }) {
  const prev = await lastRun();
  if (prev) {
    const age = now() - new Date(prev.started_at).getTime();
    if (!prev.finished_at && age < STALE_RUN_MS) return { ran: false, reason: 'A check is already running — try again in a minute.' };
    if (trigger === 'manual' && age < MANUAL_COOLDOWN_MS) return { ran: false, reason: `Checked ${Math.max(1, Math.round(age / 60_000))} min ago — try again in ${Math.ceil((MANUAL_COOLDOWN_MS - age) / 60_000)} min.` };
  }
  const started = await one('INSERT INTO wi_runs (trigger) VALUES ($1) RETURNING id, started_at', [trigger]);
  const tanks = buildTankIndex(shared);
  const deadline = now() + budgetMs;
  client ||= makeWiClient({ rps: RPS, log });
  client.deadline = deadline; // requests and retries stop here too, not only between replays
  let result;
  try {
    result = await run({ client, tanks, store: dbStore(), pages: 10, deadline, now, log });
  } catch (e) {
    log(`wotinspector run ${started.id} failed: ${e.message}`);
    result = { stats: { error: e.message }, requests: client.requests };
  }
  const stats = { ...result.stats, requests: result.requests };
  log(`wotinspector run ${started.id} (${trigger}): ${JSON.stringify(stats)}`);
  await q('UPDATE wi_runs SET finished_at = now(), stats = $1::jsonb WHERE id = $2', [JSON.stringify(stats), started.id]);
  return { ran: true, run: { id: started.id, trigger, stats } };
}

// Database access. Production: Neon Postgres over HTTP via @neondatabase/serverless
// (Vercel's Neon integration sets DATABASE_URL / POSTGRES_URL). Tests: an in-memory
// store selected with BLITZCLIP_FAKE_DB=1 so the handlers can run without Postgres.
//
// Every caller goes through `q(text, params)` which returns { rows }.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
export const SCHEMA_SQL = readFileSync(join(here, '..', 'schema.sql'), 'utf8');

let impl = null;
let schemaReady = null;

export function connectionString() {
  return process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.DATABASE_URL_UNPOOLED || '';
}

export function isConfigured() {
  return process.env.BLITZCLIP_FAKE_DB === '1' || !!connectionString();
}

async function getImpl() {
  if (impl) return impl;
  if (process.env.BLITZCLIP_FAKE_DB === '1') {
    impl = (await import('./fakedb.js')).fakeQuery;
  } else {
    const url = connectionString();
    if (!url) throw new DbError('Database is not configured (set DATABASE_URL — add a Neon database to the Vercel project).');
    const { neon } = await import('@neondatabase/serverless');
    const sql = neon(url);
    impl = async (text, params) => {
      const rows = await sql.query(text, params);
      return { rows: Array.isArray(rows) ? rows : rows.rows || [] };
    };
  }
  return impl;
}

export class DbError extends Error {}

export async function ensureSchema() {
  if (!schemaReady) {
    schemaReady = (async () => {
      const run = await getImpl();
      const stmts = SCHEMA_SQL.replace(/--[^\n]*/g, '').split(';').map(s => s.trim()).filter(Boolean);
      for (const stmt of stmts) await run(stmt, []);
    })().catch(e => { schemaReady = null; throw e; });
  }
  return schemaReady;
}

export async function q(text, params = []) {
  await ensureSchema();
  const run = await getImpl();
  return run(text, params);
}

export async function one(text, params = []) {
  const { rows } = await q(text, params);
  return rows[0] || null;
}

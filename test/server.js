// Local dev/test server: routes /api/* to the Web-API handlers under api/ the way Vercel does,
// and serves index.html for everything else. Run with BLITZCLIP_FAKE_DB=1 for the in-memory store.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

async function resolveHandler(pathname) {
  const rel = pathname.replace(/^\/api\//, '').replace(/\/$/, '');
  const candidates = [join(root, 'api', rel + '.js'), join(root, 'api', rel, 'index.js')];
  const parts = rel.split('/');
  if (parts.length > 1) candidates.push(join(root, 'api', ...parts.slice(0, -1), '[id].js'));
  const dyn = parts.map(p => /^\d+$/.test(p) ? '[id]' : p);
  candidates.push(join(root, 'api', ...dyn) + '.js');
  for (const c of candidates) if (existsSync(c)) return import(pathToFileURL(c).href);
  return null;
}

export function makeServer() {
  return createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (!url.pathname.startsWith('/api/')) {
      const file = url.pathname === '/' || url.pathname === '/index' ? 'index.html' : url.pathname.slice(1);
      try { const body = await readFile(join(root, file)); res.writeHead(200, { 'content-type': file.endsWith('.html') ? 'text/html; charset=utf-8' : file.endsWith('.json') ? 'application/json' : file.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'application/octet-stream' }); res.end(body); }
      catch { res.writeHead(404); res.end('not found'); }
      return;
    }
    const mod = await resolveHandler(url.pathname);
    const fn = mod && mod[req.method];
    if (!fn) { res.writeHead(mod ? 405 : 404, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: mod ? 'method not allowed' : 'not found' })); return; }
    const chunks = []; for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    const request = new Request(url, { method: req.method, headers: req.headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : body });
    try {
      const response = await fn(request);
      const headers = {};
      response.headers.forEach((v, k) => { if (k !== 'set-cookie') headers[k] = v; });
      const cookies = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [];
      if (cookies.length) headers['set-cookie'] = cookies;
      res.writeHead(response.status, headers);
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch (e) {
      console.error(e); res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: e.message }));
    }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 3000);
  makeServer().listen(port, () => console.log(`blitzclip dev server on http://localhost:${port} (fake db: ${process.env.BLITZCLIP_FAKE_DB === '1'})`));
}

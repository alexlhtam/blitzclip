import { createHash } from 'node:crypto';
import { route, json, error } from '../../lib/http.js';
import { putReplay, replayPathname, isBlobConfigured, SERVER_UPLOAD_LIMIT } from '../../lib/blob.js';

// POST /api/replays/upload  (body = the raw .wotbreplay, header x-file-sha256)
// Stores the file in Vercel Blob and returns its URL. For files under the function body cap;
// bigger ones go client-direct via /api/replays/client-upload.
export const POST = route(async (request, user) => {
  if (!isBlobConfigured()) return error(503, 'Replay file storage is not configured (add a Blob store to the Vercel project)');
  const declared = String(request.headers.get('x-file-sha256') || '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(declared)) return error(400, 'x-file-sha256 header required');
  const len = Number(request.headers.get('content-length') || 0);
  if (len > SERVER_UPLOAD_LIMIT) return error(413, 'File too large for direct upload; use client upload', { limit: SERVER_UPLOAD_LIMIT });
  const bytes = Buffer.from(await request.arrayBuffer());
  if (!bytes.length) return error(400, 'Empty body');
  if (bytes.length > SERVER_UPLOAD_LIMIT) return error(413, 'File too large for direct upload; use client upload', { limit: SERVER_UPLOAD_LIMIT });
  if (bytes.readUInt32LE(0) !== 0x04034b50) return error(400, 'Not a .wotbreplay archive');
  const sha = createHash('sha256').update(bytes).digest('hex');
  if (sha !== declared) return error(400, 'File hash mismatch');
  const blob = await putReplay(replayPathname(user.id, sha), bytes);
  return json({ url: blob.url, pathname: blob.pathname, sha256: sha, size: bytes.length }, { status: 201 });
}, { auth: true });

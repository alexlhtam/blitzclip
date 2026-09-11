// Raw .wotbreplay storage in Vercel Blob. Tests (BLITZCLIP_FAKE_DB=1) use an in-memory map.

export const MAX_REPLAY_BYTES = 64 * 1024 * 1024;
export const SERVER_UPLOAD_LIMIT = 4 * 1024 * 1024; // Vercel function request bodies cap at 4.5 MB

const fake = new Map();

// Credentials. Stores connected the current way use OIDC: the project gets BLOB_STORE_ID and every
// request to the function carries an x-vercel-oidc-token header; the store is PRIVATE, so blobs
// are read back through /api/replays/:id/file with that token. Older stores set
// BLOB_READ_WRITE_TOKEN (possibly under a custom prefix).
export function blobToken() {
  if (process.env.BLOB_READ_WRITE_TOKEN) return process.env.BLOB_READ_WRITE_TOKEN;
  const hit = Object.entries(process.env).find(([k, v]) => /READ_WRITE_TOKEN$/.test(k) && String(v).startsWith('vercel_blob_rw_'));
  return hit ? hit[1] : undefined;
}

// On Vercel the OIDC token arrives on the incoming request (x-vercel-oidc-token); locally it is
// the VERCEL_OIDC_TOKEN env var.
export function oidcToken(request) {
  return (request && request.headers.get('x-vercel-oidc-token')) || process.env.VERCEL_OIDC_TOKEN || undefined;
}
const withToken = (opts, request) => {
  const token = blobToken();
  if (token) return { ...opts, token };
  const oidc = oidcToken(request), storeId = process.env.BLOB_STORE_ID;
  return oidc && storeId ? { ...opts, oidcToken: oidc, storeId } : opts;
};

/** What credentials the runtime can see — booleans only, for /api/auth/me diagnostics. */
export async function blobDiagnostics(request) {
  let sdk = null, sdkOidc = null;
  try {
    const { readFileSync } = await import('node:fs');
    const { createRequire } = await import('node:module');
    const req = createRequire(import.meta.url);
    let pkgPath;
    try { pkgPath = req.resolve('@vercel/blob/package.json'); }
    catch { pkgPath = req.resolve('@vercel/blob').replace(/(node_modules[\\/]@vercel[\\/]blob)[\\/].*$/, '$1/package.json'); }
    sdk = JSON.parse(readFileSync(pkgPath, 'utf8')).version;
    const dir = pkgPath.replace(/package\.json$/, 'dist');
    const { readdirSync } = await import('node:fs');
    sdkOidc = readdirSync(dir).filter(f => f.endsWith('.js')).some(f => readFileSync(dir + '/' + f, 'utf8').includes('oidcToken'));
  } catch (e) { sdk = 'unresolved: ' + e.message; }
  const out = { rwToken: !!blobToken(), storeId: !!process.env.BLOB_STORE_ID, oidcHeader: !!(request && request.headers.get('x-vercel-oidc-token')), oidcEnv: !!process.env.VERCEL_OIDC_TOKEN, sdk, sdkOidc };
  return out;
}

export function isBlobConfigured() {
  return process.env.BLITZCLIP_FAKE_DB === '1' || !!blobToken() || !!process.env.BLOB_STORE_ID;
}

export function replayPathname(userId, sha256) {
  return `replays/${userId}/${sha256}.wotbreplay`;
}

export async function putReplay(pathname, bytes, request) {
  if (process.env.BLITZCLIP_FAKE_DB === '1') {
    const url = `https://fake.blob.local/${pathname}-${Math.random().toString(36).slice(2, 8)}`;
    fake.set(url, bytes); return { url, pathname };
  }
  const { put } = await import('@vercel/blob');
  const blob = await put(pathname, bytes, withToken({ access: 'private', addRandomSuffix: true, contentType: 'application/zip' }, request));
  return { url: blob.url, pathname: blob.pathname };
}

/** Fetch a stored replay (private store) as a Response, or null when it is gone. */
export async function fetchBlob(url, request) {
  if (process.env.BLITZCLIP_FAKE_DB === '1') {
    const bytes = fake.get(url);
    return bytes ? new Response(bytes, { headers: { 'content-type': 'application/zip' } }) : null;
  }
  const token = blobToken() || oidcToken(request);
  const r = await fetch(url, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`Blob fetch failed (${r.status})`);
  return r;
}

export async function deleteBlob(url, request) {
  if (!url) return;
  if (process.env.BLITZCLIP_FAKE_DB === '1') { fake.delete(url); return; }
  const { del } = await import('@vercel/blob');
  try { await del(url, withToken({}, request)); } catch (e) { console.error('blob delete failed', url, e.message); }
}

/** Client-direct upload token exchange (for replays too big to pass through a function). */
export async function clientUploadHandler({ body, request, userId }) {
  if (process.env.BLITZCLIP_FAKE_DB === '1') {
    if (body.type === 'blob.generate-client-token') return { type: 'blob.generate-client-token', clientToken: 'fake-client-token-' + userId };
    return { type: body.type, response: 'ok' };
  }
  const { handleUpload } = await import('@vercel/blob/client');
  return handleUpload(withToken({
    body, request,
    onBeforeGenerateToken: async pathname => {
      if (!pathname.startsWith(`replays/${userId}/`) || !pathname.endsWith('.wotbreplay')) throw new Error('Unexpected upload path');
      return { access: 'private', allowedContentTypes: ['application/zip', 'application/octet-stream'], maximumSizeInBytes: MAX_REPLAY_BYTES, addRandomSuffix: true, tokenPayload: JSON.stringify({ userId }) };
    },
    onUploadCompleted: async () => {},
  }, request));
}

export function _fakeBlobs() { return fake; }

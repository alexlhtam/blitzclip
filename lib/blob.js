// Raw .wotbreplay storage in Vercel Blob. Tests (BLITZCLIP_FAKE_DB=1) use an in-memory map.

export const MAX_REPLAY_BYTES = 64 * 1024 * 1024;
export const SERVER_UPLOAD_LIMIT = 4 * 1024 * 1024; // Vercel function request bodies cap at 4.5 MB

const fake = new Map();

// Vercel names the store's token BLOB_READ_WRITE_TOKEN unless the store was connected with a
// custom prefix (e.g. MYSTORE_READ_WRITE_TOKEN); accept either.
export function blobToken() {
  if (process.env.BLOB_READ_WRITE_TOKEN) return process.env.BLOB_READ_WRITE_TOKEN;
  const hit = Object.entries(process.env).find(([k, v]) => /READ_WRITE_TOKEN$/.test(k) && String(v).startsWith('vercel_blob_rw_'));
  return hit ? hit[1] : '';
}

export function isBlobConfigured() {
  return process.env.BLITZCLIP_FAKE_DB === '1' || !!blobToken();
}

export function replayPathname(userId, sha256) {
  return `replays/${userId}/${sha256}.wotbreplay`;
}

export async function putReplay(pathname, bytes) {
  if (process.env.BLITZCLIP_FAKE_DB === '1') {
    const url = `https://fake.blob.local/${pathname}-${Math.random().toString(36).slice(2, 8)}`;
    fake.set(url, bytes); return { url, pathname };
  }
  const { put } = await import('@vercel/blob');
  const blob = await put(pathname, bytes, { access: 'public', addRandomSuffix: true, contentType: 'application/zip', cacheControlMaxAge: 31536000, token: blobToken() });
  return { url: blob.url, pathname: blob.pathname };
}

export async function deleteBlob(url) {
  if (!url) return;
  if (process.env.BLITZCLIP_FAKE_DB === '1') { fake.delete(url); return; }
  const { del } = await import('@vercel/blob');
  try { await del(url, { token: blobToken() }); } catch (e) { console.error('blob delete failed', url, e.message); }
}

/** Client-direct upload token exchange (for replays too big to pass through a function). */
export async function clientUploadHandler({ body, request, userId }) {
  if (process.env.BLITZCLIP_FAKE_DB === '1') {
    if (body.type === 'blob.generate-client-token') return { type: 'blob.generate-client-token', clientToken: 'fake-client-token-' + userId };
    return { type: body.type, response: 'ok' };
  }
  const { handleUpload } = await import('@vercel/blob/client');
  return handleUpload({
    body, request, token: blobToken(),
    onBeforeGenerateToken: async pathname => {
      if (!pathname.startsWith(`replays/${userId}/`) || !pathname.endsWith('.wotbreplay')) throw new Error('Unexpected upload path');
      return { allowedContentTypes: ['application/zip', 'application/octet-stream'], maximumSizeInBytes: MAX_REPLAY_BYTES, addRandomSuffix: true, tokenPayload: JSON.stringify({ userId }) };
    },
    onUploadCompleted: async () => {},
  });
}

export function _fakeBlobs() { return fake; }

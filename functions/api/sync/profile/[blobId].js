// Cloudflare Pages Function: /api/sync/profile/:blobId
// Zero-knowledge: only the sha256-derived blobId and an opaque ciphertext cross the wire.
import sync from '../../../../lib/sync-api.js';

function toResponse(result) {
  return new Response(result.body, { status: result.status, headers: result.headers });
}

export async function onRequest(context) {
  const { request, env, params } = context;
  const blobId = params.blobId;

  if (request.method === 'OPTIONS') {
    return toResponse(sync.json(204, {}));
  }
  if (request.method === 'GET') {
    return toResponse(await sync.getProfile(env, blobId));
  }
  if (request.method === 'PUT') {
    let input;
    try { input = await request.json(); } catch (_) { return toResponse(sync.json(400, { error: 'invalid JSON body' })); }
    return toResponse(await sync.putProfile(env, blobId, input));
  }
  if (request.method === 'DELETE') {
    return toResponse(await sync.deleteProfile(env, blobId));
  }
  return toResponse(sync.json(405, { error: 'method not allowed' }));
}

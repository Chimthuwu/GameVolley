// Cloudflare Pages Function: /api/sync/body/:blobId/:key
// Oversized run bodies live in R2 so the KV profile stays under the 1 MiB cap.
import sync from '../../../../../lib/sync-api.js';

function toResponse(result) {
  return new Response(result.body, { status: result.status, headers: result.headers });
}

export async function onRequest(context) {
  const { request, env, params } = context;
  const { blobId, key } = params;

  if (request.method === 'OPTIONS') {
    return toResponse(sync.json(204, {}));
  }
  if (request.method === 'GET') {
    return toResponse(await sync.getBody(env, blobId, key));
  }
  if (request.method === 'PUT') {
    const body = await request.text();
    return toResponse(await sync.putBody(env, blobId, key, body));
  }
  return toResponse(sync.json(405, { error: 'method not allowed' }));
}

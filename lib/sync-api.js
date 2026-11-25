'use strict';
/* Cloudflare sync backend logic, kept free of platform globals so it can be unit-tested.
 *
 * The server is a dumb, zero-knowledge store: it sees only `blobId` (sha256 of the pairing
 * code) and an opaque ciphertext string. It never receives the pairing code, the derived
 * key, plaintext profile data, or an OpenRouter key.
 *
 * Bindings expected from wrangler: SYNC_KV (KV namespace), SYNC_R2 (R2 bucket).
 */

const MAX_PROFILE_BYTES = 900 * 1024; // KV value cap is 1 MiB; leave room for metadata
const RATE_LIMIT = 120;               // requests per blobId per window
const RATE_WINDOW_S = 60;

function isValidBlobId(id) {
  return typeof id === 'string' && /^[0-9a-f]{64}$/.test(id);
}
function isValidBodyKey(key) {
  return typeof key === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(key) &&
    !key.includes('..') && !key.includes('/') && !key.includes('\\');
}

function json(status, value, extraHeaders) {
  return {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Cache-Control': 'no-store',
      ...(extraHeaders || {}),
    },
    body: JSON.stringify(value),
  };
}

// Rate limiting is the only "auth": possession of the 256-bit blobId is the capability.
// KV is eventually consistent, so this is a loose ceiling, not a hard quota.
async function allowRequest(env, blobId, nowMs) {
  if (!env || !env.SYNC_KV) return json(503, { error: 'sync backend is not configured' });
  const window = Math.floor((Number.isFinite(nowMs) ? nowMs : Date.now()) / 1000 / RATE_WINDOW_S);
  const key = `rl:${blobId}:${window}`;
  let count = 0;
  try { count = Number((await env.SYNC_KV.get(key)) || 0) || 0; } catch (_) { /* fail open on read error */ }
  if (count >= RATE_LIMIT) return json(429, { error: 'too many sync requests, try again shortly' });
  try { await env.SYNC_KV.put(key, String(count + 1), { expirationTtl: RATE_WINDOW_S }); } catch (_) { /* fail open */ }
  return null;
}

async function getProfile(env, blobId, nowMs) {
  if (!isValidBlobId(blobId)) return json(400, { error: 'invalid blob id' });
  const limited = await allowRequest(env, blobId, nowMs);
  if (limited) return limited;
  try {
    const raw = await env.SYNC_KV.get(`profile:${blobId}`);
    if (raw === null) return json(404, { error: 'no profile yet' });
    const stored = JSON.parse(raw);
    return json(200, {
      version: stored.version || 1,
      updatedAt: stored.updatedAt || 0,
      payload: typeof stored.payload === 'string' ? stored.payload : '',
    });
  } catch (_) {
    return json(500, { error: 'could not read profile' });
  }
}

async function putProfile(env, blobId, input, nowMs) {
  if (!isValidBlobId(blobId)) return json(400, { error: 'invalid blob id' });
  const payload = input && typeof input.payload === 'string' ? input.payload : null;
  if (payload === null) return json(400, { error: 'payload must be an encrypted string' });
  const bytes = new TextEncoder().encode(payload).length;
  if (bytes > MAX_PROFILE_BYTES) return json(413, { error: 'profile exceeds size cap' });
  const limited = await allowRequest(env, blobId, nowMs);
  if (limited) return limited;
  const updatedAt = Number.isFinite(input.updatedAt) && input.updatedAt > 0 ? input.updatedAt : (Number.isFinite(nowMs) ? nowMs : Date.now());
  const version = Number.isFinite(input.version) && input.version > 0 ? input.version : 1;
  try {
    // Only opaque fields are persisted. No plaintext ever reaches KV.
    await env.SYNC_KV.put(`profile:${blobId}`, JSON.stringify({ version, updatedAt, payload }));
    return json(200, { ok: true, updatedAt });
  } catch (_) {
    return json(500, { error: 'could not write profile' });
  }
}

async function deleteProfile(env, blobId, nowMs) {
  if (!isValidBlobId(blobId)) return json(400, { error: 'invalid blob id' });
  const limited = await allowRequest(env, blobId, nowMs);
  if (limited) return limited;
  try { await env.SYNC_KV.delete(`profile:${blobId}`); } catch (_) { /* idempotent */ }
  return json(200, { ok: true });
}

async function getBody(env, blobId, key, nowMs) {
  if (!isValidBlobId(blobId) || !isValidBodyKey(key)) return json(400, { error: 'invalid body id' });
  const limited = await allowRequest(env, blobId, nowMs);
  if (limited) return limited;
  if (!env.SYNC_R2) return json(503, { error: 'body storage is not configured' });
  try {
    const object = await env.SYNC_R2.get(`${blobId}/${key}`);
    if (!object) return json(404, { error: 'no such body' });
    return {
      status: 200,
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' },
      body: await object.text(),
    };
  } catch (_) {
    return json(500, { error: 'could not read body' });
  }
}

async function putBody(env, blobId, key, body, nowMs) {
  if (!isValidBlobId(blobId) || !isValidBodyKey(key)) return json(400, { error: 'invalid body id' });
  if (typeof body !== 'string' || new TextEncoder().encode(body).length > 5 * 1024 * 1024) {
    return json(413, { error: 'body missing or too large' });
  }
  const limited = await allowRequest(env, blobId, nowMs);
  if (limited) return limited;
  if (!env.SYNC_R2) return json(503, { error: 'body storage is not configured' });
  try {
    await env.SYNC_R2.put(`${blobId}/${key}`, body, { httpMetadata: { contentType: 'text/plain; charset=utf-8' } });
    return json(200, { ok: true });
  } catch (_) {
    return json(500, { error: 'could not write body' });
  }
}

module.exports = {
  MAX_PROFILE_BYTES, RATE_LIMIT, RATE_WINDOW_S,
  isValidBlobId, isValidBodyKey, json,
  getProfile, putProfile, deleteProfile, getBody, putBody,
};

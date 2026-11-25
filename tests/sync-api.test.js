// Cloudflare sync backend logic with in-memory KV/R2 doubles (no credentials, no network).
const assert = require('assert');
const sync = require('../lib/sync-api.js');

function fakeEnv() {
  const kv = new Map();
  const r2 = new Map();
  return {
    SYNC_KV: {
      async get(k) { return kv.has(k) ? kv.get(k) : null; },
      async put(k, v) { kv.set(k, v); },
      async delete(k) { kv.delete(k); },
      _data: kv,
    },
    SYNC_R2: {
      async get(k) { return r2.has(k) ? { text: async () => r2.get(k) } : null; },
      async put(k, v) { r2.set(k, v); },
      _data: r2,
    },
  };
}

(async () => {
  const id = 'a'.repeat(64);
  assert.strictEqual(sync.isValidBlobId(id), true, 'accepts sha256 hex id');
  for (const bad of ['', 'A'.repeat(64), 'a'.repeat(63), 'z'.repeat(64), null, 42]) {
    assert.strictEqual(sync.isValidBlobId(bad), false, `rejects ${String(bad)}`);
  }
  assert.strictEqual(sync.isValidBodyKey('0.txt'), true, 'accepts simple body key');
  for (const bad of ['../secret', 'a/b', 'a\\b', '-bad', '', 'x'.repeat(129)]) {
    assert.strictEqual(sync.isValidBodyKey(bad), false, `rejects body key ${bad}`);
  }

  const env = fakeEnv();
  assert.strictEqual((await sync.getProfile(env, id)).status, 404, 'missing profile is 404');
  assert.strictEqual((await sync.putProfile(env, id, { payload: 'opaque-cipher', version: 1, updatedAt: 55 })).status, 200);
  const stored = env.SYNC_KV._data.get(`profile:${id}`);
  assert.ok(stored && stored.includes('opaque-cipher'), 'ciphertext is what is stored');
  assert.ok(!stored.includes('apiKey') && !stored.includes('openrouter'), 'no plaintext field names stored');
  const got = await sync.getProfile(env, id);
  assert.strictEqual(got.status, 200, 'profile retrieved');
  assert.deepStrictEqual(JSON.parse(got.body), { version: 1, updatedAt: 55, payload: 'opaque-cipher' });

  assert.strictEqual((await sync.putProfile(env, 'bad-id', { payload: 'x' })).status, 400, 'bad id rejected');
  assert.strictEqual((await sync.putProfile(env, id, {})).status, 400, 'non-string payload rejected');
  assert.strictEqual((await sync.putProfile(env, id, { payload: 'x'.repeat(sync.MAX_PROFILE_BYTES + 1) })).status, 413, 'oversize rejected');

  // Rate limit is per blobId and per time window.
  const limited = fakeEnv();
  for (let i = 0; i < sync.RATE_LIMIT; i++) {
    assert.strictEqual((await sync.getProfile(limited, id, 1000)).status, 404, `request ${i} allowed`);
  }
  assert.strictEqual((await sync.getProfile(limited, id, 1000)).status, 429, 'next request rate-limited');
  assert.strictEqual((await sync.getProfile(limited, id, 1000 + 60000)).status, 404, 'new window resets limit');

  assert.strictEqual((await sync.putBody(env, id, '0.txt', 'a big run body')).status, 200, 'R2 body written');
  const body = await sync.getBody(env, id, '0.txt');
  assert.strictEqual(body.status, 200, 'R2 body read');
  assert.strictEqual(body.body, 'a big run body', 'body round-trips');
  assert.strictEqual((await sync.getBody(env, id, '../evil')).status, 400, 'body traversal rejected');
  assert.strictEqual((await sync.putBody(env, id, '1.txt', 'x'.repeat(5 * 1024 * 1024 + 1))).status, 413, 'oversized body rejected');
  assert.strictEqual((await sync.getBody({}, id, '0.txt')).status, 503, 'missing R2 binding reported');

  assert.strictEqual((await sync.deleteProfile(env, id)).status, 200, 'profile deleted');
  assert.strictEqual((await sync.getProfile(env, id)).status, 404, 'delete is effective');

  console.log('sync-api.test.js: PASSED');
})().catch((e) => { console.error(e); process.exitCode = 1; });

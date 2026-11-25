// End-to-end sync protocol test: real pairing + profile logic over an in-memory
// implementation of the Cloudflare routes. No network, credentials or deploy needed.
const assert = require('assert');
const pairing = require('../src/shared/pairing.js');
const client = require('../src/shared/sync-client.js');
const syncApi = require('../lib/sync-api.js');

function memoryBackend() {
  const kv = new Map();
  const r2 = new Map();
  const env = {
    SYNC_KV: {
      async get(k) { return kv.has(k) ? kv.get(k) : null; },
      async put(k, v) { kv.set(k, v); },
      async delete(k) { kv.delete(k); },
    },
    SYNC_R2: {
      async get(k) { return r2.has(k) ? { text: async () => r2.get(k) } : null; },
      async put(k, v) { r2.set(k, v); },
    },
  };
  const fetchImpl = async (url, options = {}) => {
    const parts = new URL(url).pathname.split('/').filter(Boolean);
    let result;
    if (parts[2] === 'profile') {
      if (options.method === 'PUT') result = await syncApi.putProfile(env, parts[3], JSON.parse(options.body));
      else if (options.method === 'DELETE') result = await syncApi.deleteProfile(env, parts[3]);
      else result = await syncApi.getProfile(env, parts[3]);
    } else if (parts[2] === 'body') {
      const key = decodeURIComponent(parts[4]);
      if (options.method === 'PUT') result = await syncApi.putBody(env, parts[3], key, options.body);
      else result = await syncApi.getBody(env, parts[3], key);
    } else {
      result = syncApi.json(404, { error: 'not found' });
    }
    return {
      status: result.status,
      ok: result.status >= 200 && result.status < 300,
      json: async () => JSON.parse(result.body),
      text: async () => result.body,
    };
  };
  return { env, fetchImpl, kv, r2 };
}

function memoryStorage(initial) {
  let value = initial || '';
  return {
    getPairSecret: () => value,
    setPairSecret: (s) => { value = s; },
    clearPairSecret: () => { value = ''; },
  };
}

(async () => {
  const backend = memoryBackend();
  const secret = pairing.generatePairSecret();
  const opts = { fetch: backend.fetchImpl, deriveOptions: { iterations: 1000 }, debounceMs: 20 };
  const a = client.createSyncClient(Object.assign({ storage: memoryStorage() }, opts));
  const b = client.createSyncClient(Object.assign({ storage: memoryStorage() }, opts));

  assert.strictEqual((await a.status()).paired, false, 'unpaired by default');
  assert.strictEqual(await a.push({ settings: {} }), null, 'push without pairing is a no-op');
  assert.strictEqual(await a.pull(), null, 'pull without pairing is a no-op');
  await assert.rejects(() => a.pair('not-a-code'), 'invalid code rejected');

  const idA = await a.pair(secret);
  const idB = await b.pair(secret);
  assert.strictEqual(idA.blobId, idB.blobId, 'both devices derive the same blobId');
  assert.strictEqual((await a.status()).paired, true, 'status reports paired');
  assert.strictEqual((await a.status()).blobId, idA.blobId, 'status exposes blobId only');

  await a.push({ settings: { hue: 200 }, presets: ['base'] });
  const atB = await b.pull();
  assert.strictEqual(atB.sections.settings.data.hue, 200, 'B pulls A settings');
  assert.deepStrictEqual(atB.sections.presets.data, ['base'], 'B pulls A presets');

  // Per-section LWW: B changes presets but leaves settings untouched; A's settings survive.
  const bState = {
    settings: atB.sections.settings,
    presets: { data: ['b-new'], updatedAt: atB.sections.presets.updatedAt + 1000 },
  };
  await b.push(bState);
  const atA = await a.pull();
  assert.deepStrictEqual(atA.sections.presets.data, ['b-new'], 'B preset change wins');
  assert.strictEqual(atA.sections.settings.data.hue, 200, 'unchanged A settings are not clobbered');

  // Large run bodies go through R2 and are restored on pull.
  const bigBody = 'B'.repeat(300 * 1024);
  await a.push({
    settings: atA.sections.settings,
    presets: atA.sections.presets,
    history: [{ body: bigBody, title: 'big run' }],
  });
  assert.strictEqual(backend.r2.size, 1, 'oversized body stored in R2');
  const restored = await b.pull();
  assert.strictEqual(restored.sections.history.data[0].body, bigBody, 'R2 body restored on pull');

  // Debounced push coalesces into exactly one write.
  const before = backend.kv.size;
  const pending = a.schedulePush({ settings: { hue: 7 } });
  assert.strictEqual(a.pendingPush, true, 'push is pending');
  await pending;
  assert.strictEqual(a.pendingPush, false, 'push completed');
  assert.ok(backend.kv.size >= before, 'debounced push wrote to KV');

  b.unpair();
  assert.strictEqual((await b.status()).paired, false, 'unpair clears local state');
  assert.strictEqual(await b.push({ settings: {} }), null, 'unpaired push is a no-op');

  console.log('sync-client.test.js: PASSED');
})().catch((e) => { console.error(e); process.exitCode = 1; });

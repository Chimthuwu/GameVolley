// Pairing identity + E2E encryption: A3 (pairing secret) of the sync workstream.
const assert = require('assert');
const pairing = require('../src/shared/pairing.js');

(async () => {
  const secret = pairing.generatePairSecret();
  assert.strictEqual(secret.length, 22, '128-bit secret is 22 unpadded base64url chars');
  assert.ok(pairing.isValidPairSecret(secret), 'generated secret validates');
  assert.ok(!/=/.test(secret), 'no padding characters');
  assert.ok(/^[A-Za-z0-9_-]+$/.test(secret), 'URL-safe alphabet');
  assert.notStrictEqual(pairing.generatePairSecret(), pairing.generatePairSecret(), 'two secrets differ');

  for (const bad of ['', 'abc', 'a'.repeat(21), 'a'.repeat(23), '='.repeat(22), '!'.repeat(22), null, undefined, 123]) {
    assert.strictEqual(pairing.isValidPairSecret(bad), false, `rejects ${String(bad)}`);
  }
  assert.strictEqual(pairing.isValidPairSecret(`  ${secret}  `), true, 'trims pasted whitespace');
  assert.strictEqual(pairing.normalizePairSecret(` ${secret}\n`), secret, 'normalize trims');

  const opts = { iterations: 1000 };
  const a = await pairing.deriveIdentity(secret, opts);
  const b = await pairing.deriveIdentity(secret, opts);
  assert.match(a.blobId, /^[0-9a-f]{64}$/, 'blobId is a sha256 hex digest');
  assert.strictEqual(a.blobId, b.blobId, 'same secret derives same blobId');
  const other = await pairing.deriveIdentity(pairing.generatePairSecret(), opts);
  assert.notStrictEqual(a.blobId, other.blobId, 'different secrets derive different ids');
  assert.ok(a.key && typeof a.key === 'object', 'derived key is a CryptoKey');

  const payload = await pairing.encryptProfile(a.key, JSON.stringify({ settings: { hue: 210 }, note: '☃ snow' }));
  assert.match(payload, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/, 'payload is iv.ciphertext base64url');
  assert.strictEqual(
    await pairing.decryptProfile(a.key, payload),
    JSON.stringify({ settings: { hue: 210 }, note: '☃ snow' }),
    'round-trips unicode JSON'
  );
  const fresh = await pairing.encryptProfile(a.key, 'same plaintext');
  assert.notStrictEqual(fresh, payload, 'random IV means ciphertexts differ');

  await assert.rejects(() => pairing.decryptProfile(other.key, payload), 'wrong secret cannot decrypt');
  await assert.rejects(() => pairing.decryptProfile(a.key, payload.slice(0, -2) + 'AA'), 'tampered ciphertext rejected');
  for (const malformed of ['', 'abc', 'a.b.c', '!!!!.aaaa']) {
    await assert.rejects(() => pairing.decryptProfile(a.key, malformed), `rejects malformed payload ${malformed}`);
  }

  // The production iteration count must also work (not just the fast test override).
  const real = await pairing.deriveIdentity(secret);
  assert.match(real.blobId, /^[0-9a-f]{64}$/, 'default iteration count derives successfully');
  assert.strictEqual(
    await pairing.decryptProfile(real.key, await pairing.encryptProfile(real.key, 'ok')),
    'ok', 'default iteration count encrypts and decrypts'
  );

  assert.strictEqual(pairing.sha256Hex ? typeof await pairing.sha256Hex(pairing.b64urlDecode(secret)) : 'string', 'string');
  console.log('pairing.test.js: PASSED');
})().catch((e) => { console.error(e); process.exitCode = 1; });

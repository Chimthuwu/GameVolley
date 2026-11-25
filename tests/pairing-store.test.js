// Desktop pairing-secret storage: encrypted when the OS offers safeStorage.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createPairingStore } = require('../lib/pairing-store.js');

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gv-pair-'));
  try {
    const noCrypto = createPairingStore(dir, null);
    assert.strictEqual(noCrypto.getPairSecret(), '', 'empty by default');
    const code = 'AbCdEfGhIjKlMnOpQrStUv';
    noCrypto.setPairSecret(code);
    assert.strictEqual(noCrypto.getPairSecret(), code, 'round-trips');
    assert.ok(fs.existsSync(path.join(dir, 'pairing.bin')), 'persisted to disk');
    assert.strictEqual(createPairingStore(dir, null).getPairSecret(), code, 'a fresh store reads it back');
    noCrypto.clearPairSecret();
    assert.strictEqual(noCrypto.getPairSecret(), '', 'cleared');
    assert.strictEqual(fs.existsSync(path.join(dir, 'pairing.bin')), false, 'file removed on clear');

    const fakeSafe = {
      isEncryptionAvailable: () => true,
      encryptString: (s) => Buffer.from('enc:' + s),
      decryptString: (b) => b.toString('utf8').slice(4),
    };
    const secure = createPairingStore(dir, fakeSafe);
    secure.setPairSecret(code);
    assert.strictEqual(fs.readFileSync(path.join(dir, 'pairing.bin'), 'utf8'), 'enc:' + code, 'stored encrypted');
    assert.strictEqual(secure.getPairSecret(), code, 'decrypts on read');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log('pairing-store.test.js: PASSED');
})().catch((e) => { console.error(e); process.exitCode = 1; });

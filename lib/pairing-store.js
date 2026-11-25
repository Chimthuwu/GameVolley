'use strict';
/* Desktop pairing-secret store: OS-encrypted when safeStorage is available, exactly
 * like the OpenRouter key store in main.js. Kept free of Electron so it can be tested. */
const fs = require('fs');
const path = require('path');

function createPairingStore(directory, safeStorage) {
  const file = path.join(directory, 'pairing.bin');
  let cache;

  const encrypt = (value) => (safeStorage && safeStorage.isEncryptionAvailable()
    ? safeStorage.encryptString(value) : Buffer.from(value, 'utf8'));
  const decrypt = (buffer) => (safeStorage && safeStorage.isEncryptionAvailable()
    ? safeStorage.decryptString(buffer) : buffer.toString('utf8'));

  return {
    getPairSecret() {
      if (cache !== undefined) return cache;
      try { cache = String(decrypt(fs.readFileSync(file)) || '').trim(); } catch (_) { cache = ''; }
      return cache;
    },
    setPairSecret(secret) {
      cache = String(secret == null ? '' : secret).trim();
      if (!cache) { try { fs.unlinkSync(file); } catch (_) { /* already gone */ } return; }
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(file, encrypt(cache));
    },
    clearPairSecret() { this.setPairSecret(''); },
  };
}

module.exports = { createPairingStore };

/* Pairing identity + end-to-end encryption for web <-> desktop sync.
 *
 * UMD so the exact same file is unit-testable with `require()` in Node and loadable as a
 * plain <script> in both built front-ends (build-shared.mjs copies it into renderer/ and site/).
 *
 * Privacy contract (from TODO.md A3): the pairing code is a high-entropy anonymous account
 * id. `blobId` is a one-way hash of it and is the only id the server ever sees. The AES key
 * is derived client-side and NEVER leaves the device. The OpenRouter key is never part of a
 * profile and is never synced.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.GameVolleyPairing = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  const SECRET_BYTES = 16;             // 128 bits -> 22 base64url characters
  const PBKDF2_ITERATIONS = 210000;    // OWASP PBKDF2-HMAC-SHA256 guidance
  const KEY_SALT = 'gamevolley-sync-v1/pairing';

  function subtle() {
    if (globalThis.crypto && globalThis.crypto.subtle) return globalThis.crypto.subtle;
    if (typeof require === 'function') {
      try { return require('crypto').webcrypto.subtle; } catch (_) { /* browser */ }
    }
    throw new Error('Web Crypto is unavailable in this environment');
  }

  function randomBytes(n) {
    if (globalThis.crypto && globalThis.crypto.getRandomValues) {
      return globalThis.crypto.getRandomValues(new Uint8Array(n));
    }
    if (typeof require === 'function') {
      try { return new Uint8Array(require('crypto').randomBytes(n)); } catch (_) { /* browser */ }
    }
    throw new Error('No cryptographically secure random source is available');
  }

  function b64urlEncode(bytes) {
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    // atob/btoa are global in browsers and in every supported Node version.
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function b64urlDecode(text) {
    if (typeof text !== 'string' || !/^[A-Za-z0-9_-]+$/.test(text)) {
      throw new Error('Invalid base64url value');
    }
    const padding = (4 - (text.length % 4)) % 4;
    const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat(padding));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  function normalizePairSecret(secret) {
    return String(secret == null ? '' : secret).trim();
  }

  // Generate a fresh 128-bit pairing code. URL-safe, unpadded, copy/paste + QR friendly.
  function generatePairSecret() {
    return b64urlEncode(randomBytes(SECRET_BYTES));
  }

  function isValidPairSecret(secret) {
    try {
      return b64urlDecode(normalizePairSecret(secret)).length === SECRET_BYTES;
    } catch (_) {
      return false;
    }
  }

  async function sha256Hex(data) {
    const digest = await subtle().digest('SHA-256', data);
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
  }

  // Derive the server-visible id and the client-only AES-GCM key from one pairing code.
  // The salt is a fixed domain separator: the secret itself already has 128 bits of
  // entropy, so a per-secret salt would add nothing and would break cross-device derivation.
  async function deriveIdentity(secret, options) {
    const code = normalizePairSecret(secret);
    if (!isValidPairSecret(code)) throw new Error('Invalid pairing code');
    const opts = options || {};
    const iterations = opts.iterations || PBKDF2_ITERATIONS;
    const salt = opts.salt ? encoder.encode(opts.salt) : encoder.encode(KEY_SALT);

    const baseKey = await subtle().importKey('raw', encoder.encode(code), 'PBKDF2', false, ['deriveKey']);
    const key = await subtle().deriveKey(
      { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
      baseKey,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
    return { blobId: await sha256Hex(encoder.encode(code)), key };
  }

  // Payload = base64url(12-byte IV) + '.' + base64url(ciphertext||tag).
  async function encryptProfile(key, plaintext) {
    const iv = randomBytes(12);
    const cipher = await subtle().encrypt(
      { name: 'AES-GCM', iv }, key, encoder.encode(String(plaintext == null ? '' : plaintext))
    );
    return b64urlEncode(iv) + '.' + b64urlEncode(new Uint8Array(cipher));
  }

  async function decryptProfile(key, payload) {
    if (typeof payload !== 'string') throw new Error('Invalid encrypted payload');
    const parts = payload.split('.');
    if (parts.length !== 2) throw new Error('Invalid encrypted payload');
    const iv = b64urlDecode(parts[0]);
    if (iv.length !== 12) throw new Error('Invalid AES-GCM IV');
    const cipher = b64urlDecode(parts[1]);
    const plain = await subtle().decrypt({ name: 'AES-GCM', iv }, key, cipher);
    return decoder.decode(plain);
  }

  return {
    SECRET_BYTES, PBKDF2_ITERATIONS, KEY_SALT,
    generatePairSecret, isValidPairSecret, normalizePairSecret, sha256Hex,
    deriveIdentity, encryptProfile, decryptProfile,
    b64urlEncode, b64urlDecode,
  };
});

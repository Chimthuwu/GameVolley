/* Client-side sync engine: pair, pull, push (debounced), unpair.
 *
 * Platform-neutral. The desktop bridge persists the secret via OS encryption; the web
 * build persists it in localStorage. Both call the same functions here.
 *
 * UMD like the other shared modules, so `npm test` exercises the exact code the UI loads.
 */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.GameVolleySyncClient = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  const pairing = (typeof require === 'function' && typeof module === 'object')
    ? require('./pairing.js') : root.GameVolleyPairing;
  const syncProfile = (typeof require === 'function' && typeof module === 'object')
    ? require('./sync-profile.js') : root.GameVolleySyncProfile;

  const DEFAULT_BASE_URL = 'https://volley-prompt.pages.dev/api/sync';

  function createSyncClient(config) {
    const cfg = Object.assign({
      baseUrl: DEFAULT_BASE_URL,
      debounceMs: 2000,
      fetch: null,
      storage: null,
      deriveOptions: undefined,
    }, config || {});

    let cachedSecret = '';
    let identity = null;
    let identityPromise = null;
    let pending = null;
    let lastError = '';

    const http = (...args) => {
      const fn = cfg.fetch || (typeof fetch === 'function' ? fetch : null);
      if (!fn) throw new Error('fetch is unavailable in this environment');
      return fn(...args);
    };
    const secretOf = (override) => {
      if (typeof override === 'string' && override.trim()) return override.trim();
      if (cfg.storage && typeof cfg.storage.getPairSecret === 'function') {
        return String(cfg.storage.getPairSecret() || '').trim();
      }
      return cachedSecret;
    };

    async function identityFor(secret) {
      const code = secretOf(secret);
      if (!code) return null;
      if (!pairing.isValidPairSecret(code)) throw new Error('Invalid pairing code');
      if (identity && cachedSecret === code) return identity;
      if (identityPromise && cachedSecret === code) return identityPromise;
      cachedSecret = code;
      identityPromise = pairing.deriveIdentity(code, cfg.deriveOptions).then((derived) => {
        identity = derived;
        return derived;
      });
      return identityPromise;
    }

    async function status() {
      const secret = secretOf();
      if (!secret) return { paired: false, blobId: null };
      if (!pairing.isValidPairSecret(secret)) return { paired: false, blobId: null, error: 'Invalid stored pairing code' };
      try {
        const id = await identityFor(secret);
        return { paired: true, blobId: id.blobId };
      } catch (e) {
        return { paired: false, blobId: null, error: e.message };
      }
    }

    async function pair(secret) {
      const code = String(secret == null ? '' : secret).trim();
      if (!pairing.isValidPairSecret(code)) throw new Error('That pairing code is not valid');
      identity = null; identityPromise = null; cachedSecret = '';
      const derived = await identityFor(code);
      if (cfg.storage && typeof cfg.storage.setPairSecret === 'function') cfg.storage.setPairSecret(code);
      cachedSecret = code;
      return { paired: true, blobId: derived.blobId };
    }

    function unpair() {
      cancelPendingPush();
      if (cfg.storage && typeof cfg.storage.clearPairSecret === 'function') cfg.storage.clearPairSecret();
      cachedSecret = ''; identity = null; identityPromise = null; lastError = '';
      return { paired: false };
    }

    async function pull(localState) {
      const id = await identityFor();
      if (!id) return null;
      const res = await http(`${cfg.baseUrl.replace(/\/+$/, '')}/profile/${id.blobId}`);
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`Could not pull sync profile (${res.status})`);
      const remote = await res.json();
      const plaintext = await pairing.decryptProfile(id.key, remote.payload);
      const profile = JSON.parse(plaintext);
      await syncProfile.restoreLargeBodies(profile, async (key) => {
        const bodyRes = await http(`${cfg.baseUrl.replace(/\/+$/, '')}/body/${id.blobId}/${encodeURIComponent(key)}`);
        return bodyRes.ok ? bodyRes.text() : null;
      });
      return localState ? syncProfile.mergeProfiles(syncProfile.buildProfile(localState), profile) : profile;
    }

    async function push(state) {
      const id = await identityFor();
      if (!id) return null;
      const remote = await pull(null);
      const local = syncProfile.buildProfile(state);
      // Don't bump a section's clock when its data is unchanged from the server copy:
      // otherwise a push of one changed section would make every stale section win.
      if (remote && remote.sections) {
        for (const name of syncProfile.SECTIONS) {
          const l = local.sections[name];
          const r = remote.sections[name];
          if (!l || !r) continue;
          if (JSON.stringify(l.data) === JSON.stringify(r.data)) l.updatedAt = r.updatedAt;
        }
      }
      const merged = remote ? syncProfile.mergeProfiles(local, remote) : local;

      // Work on a copy: offloading must not strip bodies from the state we hand back.
      const wire = JSON.parse(JSON.stringify(merged));
      const { profile: slim, blobs } = syncProfile.extractLargeBodies(wire);
      for (const blob of blobs) {
        const res = await http(`${cfg.baseUrl.replace(/\/+$/, '')}/body/${id.blobId}/${blob.key}`, {
          method: 'PUT', headers: { 'Content-Type': 'text/plain; charset=utf-8' }, body: blob.body,
        });
        if (!res.ok) throw new Error(`Could not store a large run body (${res.status})`);
      }
      const payload = await pairing.encryptProfile(id.key, JSON.stringify(slim));
      const res = await http(`${cfg.baseUrl.replace(/\/+$/, '')}/profile/${id.blobId}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ version: 1, updatedAt: Date.now(), payload }),
      });
      if (!res.ok) throw new Error(`Could not push sync profile (${res.status})`);
      lastError = '';
      return { ok: true, profile: merged };
    }

    function schedulePush(state) {
      if (pending) clearTimeout(pending.timer);
      let timer, resolve, reject;
      const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
      timer = setTimeout(() => {
        pending = null;
        push(state).then((r) => { lastError = ''; resolve(r); }, (e) => {
          lastError = e.message || String(e);
          reject(e);
        });
      }, cfg.debounceMs);
      pending = { timer, cancel: () => { clearTimeout(timer); pending = null; reject(new Error('sync push cancelled')); } };
      return promise;
    }

    function cancelPendingPush() {
      if (pending) { clearTimeout(pending.timer); pending = null; }
    }

    return {
      DEFAULT_BASE_URL,
      status, pair, unpair, pull, push, schedulePush, cancelPendingPush,
      get lastError() { return lastError; },
      get pendingPush() { return !!pending; },
    };
  }

  return { createSyncClient, DEFAULT_BASE_URL };
});

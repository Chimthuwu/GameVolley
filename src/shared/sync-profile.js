/* Sync profile shape + conflict resolution for web <-> desktop sync.
 *
 * One profile is one JSON document with independent, timestamped top-level sections.
 * Conflict rule (TODO.md A4): last-write-wins PER SECTION, not whole-blob, so a settings
 * tweak on one device never clobbers a new run recorded on the other. Ties keep local.
 *
 * UMD, exactly like pairing.js, so it is unit-testable and loadable in both built front-ends.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.GameVolleySyncProfile = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const encoder = new TextEncoder();
  const SECTIONS = ['settings', 'presets', 'pairs', 'composer', 'theme', 'history'];
  const MAX_KV_BYTES = 900 * 1024;   // Cloudflare KV value cap is 1 MiB; leave headroom
  const R2_THRESHOLD = 256 * 1024;   // bodies larger than this move to R2
  const BODY_FIELDS = ['body', 'final', 'prompt', 'text', 'log'];
  const POINTER = '__r2Key';

  function normalizeSection(input) {
    const source = input && typeof input === 'object' ? input : {};
    const timestamp = Number(source.updatedAt);
    return {
      updatedAt: Number.isFinite(timestamp) && timestamp > 0 ? timestamp : 0,
      data: Object.prototype.hasOwnProperty.call(source, 'data') ? source.data : null,
    };
  }

  // Wrap raw app state into a versioned profile. Already-wrapped sections are preserved
  // verbatim so a pulled profile can be pushed back without losing its timestamps.
  function buildProfile(state, now) {
    const stamp = Number.isFinite(now) && now > 0 ? now : Date.now();
    const sections = {};
    for (const name of SECTIONS) {
      const source = state && state[name];
      if (source === undefined || source === null) continue;
      if (source && typeof source === 'object' &&
          (Object.prototype.hasOwnProperty.call(source, 'data') ||
           Object.prototype.hasOwnProperty.call(source, 'updatedAt'))) {
        sections[name] = normalizeSection(source);
      } else {
        sections[name] = { updatedAt: stamp, data: source };
      }
    }
    return { version: 1, sections };
  }

  function mergeProfiles(local, remote) {
    const left = (local && local.sections) || {};
    const right = (remote && remote.sections) || {};
    const names = new Set([...Object.keys(left), ...Object.keys(right)]);
    const sections = {};
    for (const name of names) {
      if (!Object.prototype.hasOwnProperty.call(left, name)) { sections[name] = normalizeSection(right[name]); continue; }
      if (!Object.prototype.hasOwnProperty.call(right, name)) { sections[name] = normalizeSection(left[name]); continue; }
      const l = normalizeSection(left[name]);
      const r = normalizeSection(right[name]);
      sections[name] = r.updatedAt > l.updatedAt ? r : l; // tie -> local wins
    }
    return { version: 1, sections };
  }

  function byteLength(value) {
    return encoder.encode(JSON.stringify(value === undefined ? null : value)).length;
  }

  function profileSize(profile) { return byteLength(profile); }
  function fitsInKv(profile) { return profileSize(profile) <= MAX_KV_BYTES; }

  function historyRuns(profile) {
    const history = profile && profile.sections && profile.sections.history;
    if (!history) return null;
    const data = history.data;
    if (Array.isArray(data)) return data;
    if (data && typeof data === 'object' && Array.isArray(data.runs)) return data.runs;
    return null;
  }

  // Keep only the N most recent runs. Works for an array or for { runs: [...] }.
  function trimHistory(profile, maxRuns) {
    if (!historyRuns(profile)) return profile;
    const limit = Number.isFinite(maxRuns) ? Math.max(0, Math.floor(maxRuns)) : 200;
    const data = profile.sections.history.data;
    profile.sections.history.data = Array.isArray(data)
      ? data.slice(0, limit)
      : { ...data, runs: data.runs.slice(0, limit) };
    return profile;
  }

  // Move oversized run bodies out of the KV blob and into R2, leaving a small pointer.
  // Returns the mutated profile plus the list of objects the caller must write to R2.
  function extractLargeBodies(profile, keyPrefix, threshold) {
    const runs = historyRuns(profile);
    const blobs = [];
    if (!runs) return { profile, blobs };
    const limit = Number.isFinite(threshold) ? threshold : R2_THRESHOLD;
    const prefix = String(keyPrefix || 'profile').replace(/\/+$/, '');

    for (const run of runs) {
      if (!run || typeof run !== 'object') continue;
      for (const field of BODY_FIELDS) {
        const value = run[field];
        if (typeof value !== 'string' || byteLength(value) <= limit) continue;
        const index = blobs.length;
        const key = `${prefix}/${index}.txt`;
        delete run[field];
        run[POINTER] = run[POINTER] || {};
        run[POINTER][field] = key;
        blobs.push({ key, body: value });
      }
    }
    return { profile, blobs };
  }

  // Inverse of extractLargeBodies. resolve(key) may be sync or async.
  async function restoreLargeBodies(profile, resolve) {
    const runs = historyRuns(profile);
    if (!runs || typeof resolve !== 'function') return profile;
    for (const run of runs) {
      if (!run || !run[POINTER] || typeof run[POINTER] !== 'object') continue;
      for (const field of Object.keys(run[POINTER])) {
        const key = run[POINTER][field];
        const body = await resolve(key);
        if (typeof body === 'string') run[field] = body;
      }
      delete run[POINTER];
    }
    return profile;
  }

  return {
    SECTIONS, MAX_KV_BYTES, R2_THRESHOLD, POINTER,
    normalizeSection, buildProfile, mergeProfiles,
    byteLength, profileSize, fitsInKv,
    trimHistory, extractLargeBodies, restoreLargeBodies,
  };
});

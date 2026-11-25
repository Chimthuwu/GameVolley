/* Maps the local app's localStorage state to/from the six sync sections.
 *
 * Deliberately excludes `vp_api_key`, provider credentials and any attachment data:
 * credentials and large binaries never enter a sync profile.
 *
 * UMD so desktop and web use exactly the same mapping.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.GameVolleySyncApply = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const SECTION_KEYS = {
    settings: 'vpSettings',
    presets: 'vpPresets',
    pairs: 'vpModelPairs',
    history: 'vp_history',
  };
  const COMPOSER_FIELDS = ['author', 'critic', 'rounds', 'idea', 'auto', 'outputMode'];

  function storage() {
    try { return globalThis.localStorage || null; } catch (_) { return null; }
  }

  function readJson(store, key) {
    try {
      const raw = store.getItem(key);
      if (raw === null || raw === undefined) return null;
      return JSON.parse(raw);
    } catch (_) {
      return null;
    }
  }

  // Snapshot the sections we are willing to sync. Missing sections are simply absent.
  function collectState() {
    const store = storage();
    if (!store) return {};
    const state = {};
    for (const [section, key] of Object.entries(SECTION_KEYS)) {
      const value = readJson(store, key);
      if (value !== null && value !== undefined) state[section] = value;
    }
    const composer = {};
    for (const field of COMPOSER_FIELDS) {
      const value = store.getItem(field);
      if (value !== null && value !== undefined) composer[field] = value;
    }
    if (Object.keys(composer).length) state.composer = composer;
    return state;
  }

  // Write a pulled profile back to localStorage. Returns the names of applied sections.
  // Nothing is deleted: a section the profile does not contain is left as-is on this device.
  function applyProfile(profile) {
    const store = storage();
    if (!store || !profile || !profile.sections) return [];
    const applied = [];
    for (const [section, key] of Object.entries(SECTION_KEYS)) {
      const value = profile.sections[section];
      if (!value || value.data === null || value.data === undefined) continue;
      try {
        store.setItem(key, typeof value.data === 'string' ? value.data : JSON.stringify(value.data));
        applied.push(section);
      } catch (_) { /* quota or private mode: leave the old value intact */ }
    }
    const composer = profile.sections.composer;
    if (composer && composer.data && typeof composer.data === 'object') {
      for (const field of COMPOSER_FIELDS) {
        const value = composer.data[field];
        if (value === undefined || value === null) continue;
        try { store.setItem(field, String(value)); } catch (_) { /* ignore */ }
      }
      applied.push('composer');
    }
    return applied;
  }

  return { SECTION_KEYS, COMPOSER_FIELDS, collectState, applyProfile };
});

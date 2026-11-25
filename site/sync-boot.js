/* Boots the shared pairing panel in both builds.
 * Desktop routes through the Electron bridge (secret in OS-encrypted storage);
 * web uses the same sync client with a localStorage-backed secret.
 */
(() => {
  const host = document.getElementById('syncHost');
  if (!host || !window.GameVolleySyncUi || !window.GameVolleySyncApply) return;
  const desktop = !!(window.pv && typeof window.pv.syncStatus === 'function');
  const webSync = window.GameVolleyWebSync;

  const bridge = desktop ? {
    status: () => window.pv.syncStatus(),
    generate: () => window.pv.syncGenerate(),
    enter: (code) => window.pv.syncEnter(code),
    unpair: () => window.pv.syncUnpair(),
    pull: () => window.pv.syncPull(),
    push: (state) => window.pv.syncPush(state),
  } : {
    status: () => webSync.status(),
    generate: () => webSync.generate(),
    enter: (code) => webSync.enter(code),
    unpair: () => webSync.unpair(),
    pull: () => webSync.pull(),
    push: (state) => webSync.push(state),
  };

  window.GameVolleySyncUi.createSyncUi(host, Object.assign(bridge, {
    getState: () => window.GameVolleySyncApply.collectState(),
    apply: (profile) => window.GameVolleySyncApply.applyProfile(profile),
    copy: (text) => window.pv.copy(text),
    reload: () => location.reload(),
  }));

  // A4: pull on open/focus, push ~2s after local state changes.
  const applied = window.GameVolleySyncApply;
  const snapshot = () => JSON.stringify(applied.collectState());
  let lastSnapshot = snapshot();
  let pushTimer = null;

  async function autoPull(allowReload) {
    try {
      const state = await bridge.status();
      if (!state.paired) return;
      const profile = await bridge.pull();
      if (!profile) return;
      const sections = applied.applyProfile(profile);
      if (allowReload && sections && sections.length && !sessionStorage.getItem('gvSyncAutoApplied')) {
        sessionStorage.setItem('gvSyncAutoApplied', '1');
        location.reload();
      }
    } catch (_) { /* offline or backend not deployed yet: keep working locally */ }
  }

  // Debounced push: re-arm the timer on every change so a burst of saves is one write.
  function watchLocalChanges() {
    const now = snapshot();
    if (now === lastSnapshot) return;
    lastSnapshot = now;
    clearTimeout(pushTimer);
    pushTimer = setTimeout(() => { bridge.push(applied.collectState()).catch(() => {}); }, 2000);
  }
  setInterval(watchLocalChanges, 1000);
  window.addEventListener('focus', () => autoPull(false));
  setTimeout(() => autoPull(true), 1200);
})();

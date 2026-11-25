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
})();

/* Pairing / sync panel shared by the desktop and web builds.
 *
 * The secret is never sent to a QR service: its QR is rendered locally by qr.js.
 * All dynamic text goes through textContent / input.value, never innerHTML.
 *
 * UMD. Bridge contract:
 *   status() -> {paired, blobId, code}
 *   generate() -> {code, blobId}      enter(code) -> {paired, blobId}
 *   unpair() -> {paired:false}
 *   pull() -> profile|null            push(state) -> result
 *   getState() -> state               apply(profile) -> applied section names
 *   copy(text) -> boolean             reload() -> void
 */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.GameVolleySyncUi = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  function createSyncUi(container, bridge, options) {
    const opts = options || {};
    const qr = opts.qr || (typeof require === 'function' && typeof module === 'object'
      ? require('./qr.js') : root.GameVolleyQr);
    if (!container || !bridge) throw new Error('sync UI needs a container and a bridge');

    const el = (tag, attrs, children) => {
      const node = document.createElement(tag);
      for (const [key, value] of Object.entries(attrs || {})) {
        if (key === 'text') node.textContent = value;
        else if (key === 'class') node.className = value;
        else if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value);
        else if (value !== null && value !== undefined) node.setAttribute(key, String(value));
      }
      for (const child of children || []) if (child) node.appendChild(child);
      return node;
    };
    const button = (label, onClick, cls) => el('button', { type: 'button', class: cls || 'ghost', text: label, onclick: onClick });

    const message = el('p', { class: 'sync-message hint', role: 'status', 'aria-live': 'polite' });
    const body = el('div', { class: 'sync-body' });
    container.appendChild(el('section', { class: 'sync-panel', id: 'syncPanel' }, [
      el('h3', { class: 'settings-section', text: 'Device sync' }),
      el('p', { class: 'hint', text: 'Pair this install with the web app. Settings, presets, model pairs and volley history sync; your API keys never do.' }),
      body, message,
    ]));

    const say = (text) => { message.textContent = text || ''; };
    const run = async (fn) => {
      say('Working…');
      try { return await fn(); } catch (e) { say(e && e.message ? e.message : String(e)); return null; }
    };

    let currentCode = '';

    function renderUnpaired() {
      const codeInput = el('input', { type: 'text', placeholder: 'Paste a code from the other device', maxlength: 64, spellcheck: 'false', 'aria-label': 'Pairing code' });
      body.replaceChildren(
        button('Generate a pairing code', async () => {
          const result = await run(() => bridge.generate());
          if (result) { currentCode = result.code || ''; renderPaired(result); say('Pairing code created. Copy it or scan the QR on the other device.'); }
        }, 'big'),
        el('div', { class: 'sync-enter' }, [
          codeInput,
          button('Use this code', async () => {
            const value = codeInput.value.trim();
            if (!value) return say('Paste a pairing code first.');
            const result = await run(() => bridge.enter(value));
            if (result) { currentCode = value; renderPaired(result); say('Paired. This device can now sync.'); }
          }),
        ])
      );
    }

    function renderPaired(status) {
      currentCode = status.code || currentCode;
      const codeField = el('input', { type: 'text', readonly: 'readonly', class: 'sync-code', 'aria-label': 'Your pairing code' });
      codeField.value = currentCode;
      const qrBox = el('div', { class: 'sync-qr' });
      try { qrBox.innerHTML = qr.renderSvg(currentCode, { scale: 3, margin: 2 }); } catch (_) { /* code not available on this device */ }

      body.replaceChildren(
        el('p', { class: 'hint', text: 'Paired · account ' + String(status.blobId || '').slice(0, 12) + '…' }),
        el('div', { class: 'sync-code-row' }, [codeField, button('Copy', () => run(() => bridge.copy(currentCode)).then((ok) => say(ok ? 'Copied.' : 'Copy failed — select and copy the code manually.')))]),
        qrBox,
        el('div', { class: 'sync-actions' }, [
          button('Sync now', async () => {
            const pulled = await run(() => bridge.pull());
            if (pulled) {
              const applied = await run(() => bridge.apply(pulled));
              if (applied) { say('Applied ' + applied.join(', ') + ' from the other device.'); bridge.reload(); }
            } else {
              say('Nothing to pull yet.');
            }
            const pushed = await run(() => bridge.push(bridge.getState()));
            if (pushed) say('Sync complete.');
          }, 'big'),
          button('Unpair', async () => {
            const result = await run(() => bridge.unpair());
            if (result) { currentCode = ''; renderUnpaired(); say('Unpaired. The stored code was removed from this device.'); }
          }),
        ])
      );
    }

    async function refresh() {
      const status = await run(() => bridge.status());
      if (!status) return;
      if (status.paired) renderPaired(status);
      else renderUnpaired();
    }

    refresh();
    return { refresh, renderUnpaired, renderPaired };
  }

  return { createSyncUi };
});

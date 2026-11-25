/* "Send to ▸" chooser, shared by desktop and web.
 *
 * Copies an explicit, action-tagged prompt to the clipboard, then opens the chosen agent's
 * scheme URL (desktop and web) or spawns Hermes directly (desktop only, no Discord).
 */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.GameVolleyHandoffUi = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  function createHandoffUi(options) {
    const cfg = options || {};
    const handoff = cfg.handoff || (typeof require === 'function' && typeof module === 'object'
      ? require('./handoff.js') : root.GameVolleyHandoff);
    const bridge = cfg.bridge;
    if (!bridge) throw new Error('handoff UI needs a bridge');

    let modal = null;
    let currentPrompt = '';
    let statusLine = null;

    function say(text) { if (statusLine) statusLine.textContent = text || ''; }

    function ensureModal() {
      if (modal) return modal;
      const doc = document;
      modal = doc.createElement('div');
      modal.className = 'modal hidden';
      modal.id = 'handoffModal';
      modal.setAttribute('role', 'dialog');
      modal.setAttribute('aria-label', 'Send prompt to an agent');

      const card = doc.createElement('div');
      card.className = 'card handoff-card';
      const title = doc.createElement('h2');
      title.textContent = 'Send to ▸';
      const hint = doc.createElement('p');
      hint.className = 'hint';
      hint.textContent = 'The approved prompt is copied first. Pick what the agent should do with it.';
      card.append(title, hint);

      const choices = doc.createElement('div');
      choices.className = 'handoff-choices';
      for (const dest of handoff.DESTINATIONS) {
        const btn = doc.createElement('button');
        btn.type = 'button';
        btn.className = 'ghost handoff-dest';
        btn.dataset.dest = dest.id;
        btn.textContent = dest.label;
        btn.disabled = !!cfg.web && !dest.web;
        if (cfg.web && !dest.web) btn.title = 'Desktop only — on web, paste the copied prompt into Hermes.';
        btn.addEventListener('click', () => send(dest.id));
        choices.appendChild(btn);
      }
      card.appendChild(choices);

      const actionRow = doc.createElement('div');
      actionRow.className = 'row';
      const action = doc.createElement('label');
      action.textContent = 'What should it do? ';
      const select = doc.createElement('select');
      select.id = 'handoffAction';
      for (const [value, label] of [['build', 'Build this'], ['review', 'Review this']]) {
        const opt = doc.createElement('option');
        opt.value = value;
        opt.textContent = label;
        select.appendChild(opt);
      }
      action.appendChild(select);
      const folder = doc.createElement('label');
      folder.textContent = 'Project folder (optional) ';
      const folderInput = doc.createElement('input');
      folderInput.id = 'handoffFolder';
      folderInput.type = 'text';
      folderInput.maxLength = 300;
      folderInput.placeholder = 'e.g. Z:/projects/my-game';
      folder.appendChild(folderInput);
      actionRow.append(action, folder);
      card.appendChild(actionRow);

      statusLine = doc.createElement('p');
      statusLine.className = 'hint';
      statusLine.setAttribute('role', 'status');
      statusLine.setAttribute('aria-live', 'polite');
      const buttons = doc.createElement('div');
      buttons.className = 'row';
      const close = doc.createElement('button');
      close.type = 'button';
      close.className = 'ghost';
      close.textContent = 'Close';
      close.addEventListener('click', closeModal);
      buttons.appendChild(close);
      card.append(statusLine, buttons);
      modal.appendChild(card);
      doc.body.appendChild(modal);
      return modal;
    }

    async function send(id) {
      const dest = handoff.destination(id);
      if (!dest) return say('Unknown destination.');
      const select = document.getElementById('handoffAction');
      const folder = document.getElementById('handoffFolder');
      const text = handoff.buildHandoffText(currentPrompt, {
        action: select ? select.value : 'build',
        folder: folder ? folder.value : '',
      });
      say('Copying prompt…');
      let copied = false;
      try { copied = await bridge.copy(text); } catch (_) { /* handled below */ }
      if (!copied) return say('Clipboard was blocked. Select the prompt manually and paste it into ' + dest.label + '.');

      if (id === 'hermes') {
        if (cfg.web) return say('Copied. Open Hermes and paste — the desktop app can start a run directly.');
        try {
          const result = await bridge.hermes(text);
          say(result && result.message ? result.message : 'Hermes run started directly (no Discord involved).');
        } catch (e) {
          say('Copied, but Hermes could not start: ' + (e && e.message ? e.message : String(e)));
        }
        return;
      }
      try {
        const opened = await bridge.open(dest.scheme);
        say(opened ? 'Copied and opened ' + dest.label + '. Paste the prompt there.' : 'Copied. ' + dest.label + ' did not open — paste manually.');
      } catch (e) {
        say('Copied. ' + dest.label + ' did not open — paste manually.');
      }
    }

    function open(promptText) {
      currentPrompt = String(promptText == null ? '' : promptText);
      ensureModal();
      say('');
      modal.classList.remove('hidden');
    }

    function closeModal() { if (modal) modal.classList.add('hidden'); }

    return { open, close: closeModal };
  }

  return { createHandoffUi };
});

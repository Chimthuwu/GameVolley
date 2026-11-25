/* B2 scaffold chooser, shared by desktop and web.
 *
 * Nothing is written until the user has generated a manifest, picked a destination and
 * confirmed the preview. The destination and overwrite checks are repeated in the writer.
 */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.GameVolleyScaffoldUi = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  function createScaffoldUi(options) {
    const cfg = options || {};
    const scaffold = cfg.scaffold || (typeof require === 'function' && typeof module === 'object'
      ? require('./scaffold.js') : root.GameVolleyScaffold);
    const bridge = cfg.bridge;
    if (!bridge) throw new Error('scaffold UI needs a bridge');

    let modal = null;
    let prompt = '';
    let files = [];
    let destination = '';
    let status = null;
    let preview = null;
    let writeButton = null;
    let zipButton = null;

    const say = (text) => { if (status) status.textContent = text || ''; };
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

    function ensureModal() {
      if (modal) return modal;
      modal = el('div', { class: 'modal hidden', id: 'scaffoldModal', role: 'dialog', 'aria-label': 'Scaffold a project' });
      const cycles = el('select', { id: 'scaffoldCycles' });
      for (const [value, label] of [
        [1, '1 — skeleton + todo.md'], [2, '2 — stubs that open cleanly'], [3, '3 — first milestone implemented'],
      ]) {
        const opt = el('option', { value: String(value), text: label });
        cycles.appendChild(opt);
      }
      const model = el('input', { id: 'scaffoldModel', type: 'text', maxlength: 200, spellcheck: 'false', placeholder: 'model (blank = composer default)' });
      model.value = typeof cfg.model === 'function' ? (cfg.model() || '') : '';

      preview = el('div', { class: 'scaffold-preview', 'aria-live': 'polite' });
      status = el('p', { class: 'hint', role: 'status', 'aria-live': 'polite' });
      writeButton = el('button', { type: 'button', class: 'big', text: 'Confirm & write', onclick: write });
      writeButton.disabled = true;
      zipButton = el('button', { type: 'button', class: 'ghost', text: 'Download ZIP', onclick: downloadZip });
      zipButton.disabled = true;
      if (cfg.web === false || cfg.web === undefined) zipButton.style.display = 'none';

      const card = el('div', { class: 'card scaffold-card' }, [
        el('h2', { text: 'Scaffold a project' }),
        el('p', { class: 'hint', text: 'The Writer model emits a file manifest; a reviewer can check it. Nothing is written until you pick a folder and confirm.' }),
        el('div', { class: 'row' }, [
          el('label', { text: 'Depth ' }, [cycles]),
          el('label', { text: 'Model ' }, [model]),
        ]),
        el('div', { class: 'row' }, [
          el('button', { type: 'button', class: 'big', text: 'Generate manifest', onclick: generate }),
          el('button', { type: 'button', class: 'ghost', text: 'Pick destination', onclick: pickDestination }),
        ]),
        preview,
        el('div', { class: 'row' }, [writeButton, zipButton,
          el('button', { type: 'button', class: 'ghost', text: 'Close', onclick: closeModal })]),
        status,
      ]);
      modal.appendChild(card);
      document.body.appendChild(modal);
      return modal;
    }

    async function generate() {
      files = []; destination = ''; writeButton.disabled = true; zipButton.disabled = true;
      const cycles = Number(document.getElementById('scaffoldCycles').value) || 1;
      const model = document.getElementById('scaffoldModel').value.trim();
      say('Asking the model for a file manifest…');
      try {
        const result = await bridge.generate(prompt, cycles, model);
        const text = result && result.text !== undefined ? result.text : result;
        files = scaffold.parseManifest(text);
        // B2 reuses the round/verdict shape: the critic reviews the manifest, not prose.
        if (typeof bridge.review === 'function') {
          say('Reviewer is checking the manifest…');
          const verdict = await bridge.review(JSON.stringify(files), cycles, model);
          const verdictText = verdict && verdict.text !== undefined ? verdict.text : String(verdict || '');
          if (!/^\s*APPROVE/i.test(verdictText)) {
            say('Reviewer requested fixes; regenerating the manifest…');
            const revised = await bridge.generate(prompt, cycles, model, verdictText.slice(0, 4000));
            files = scaffold.parseManifest(revised && revised.text !== undefined ? revised.text : revised);
          }
        }
        const depth = scaffold.depthForCycles(cycles);
        files = files.filter((f) => f.path !== 'todo.md').concat([{ path: 'todo.md', content: scaffold.buildTodoHandoff(prompt, files, cycles) }]);
        preview.textContent = `Manifest ready: ${files.length} files at depth ${depth.level} (${depth.label}). ` +
          files.slice(0, 12).map((f) => f.path).join(', ') + (files.length > 12 ? '…' : '');
        say('Review the list, then pick a destination.');
      } catch (e) {
        say(e && e.message ? e.message : String(e));
      }
    }

    async function pickDestination() {
      if (!files.length) return say('Generate a manifest first.');
      try {
        destination = await bridge.pickDir();
        if (!destination) return say('No folder chosen — nothing was written.');
        const plan = scaffold.planWrite(files, destination, [], false);
        preview.textContent = plan.preview + '\n' + files.map((f) => f.path).join('\n');
        writeButton.disabled = false;
        zipButton.disabled = false;
        say('Confirm the preview to write.');
      } catch (e) {
        say(e && e.message ? e.message : String(e));
      }
    }

    async function write() {
      if (!files.length || !destination) return say('Generate a manifest and pick a folder first.');
      try {
        const result = await bridge.write(files, destination, true);
        say(`Wrote ${result.count} files to ${destination}. Open the folder in your IDE.`);
        writeButton.disabled = true;
      } catch (e) {
        say(e && e.message ? e.message : String(e));
      }
    }

    async function downloadZip() {
      if (!files.length) return say('Generate a manifest first.');
      try {
        const result = await bridge.downloadZip(files);
        say(`Downloaded a ZIP with ${result.count} files.`);
      } catch (e) {
        say(e && e.message ? e.message : String(e));
      }
    }

    function open(promptText) {
      prompt = String(promptText == null ? '' : promptText);
      files = []; destination = '';
      ensureModal();
      if (writeButton) writeButton.disabled = true;
      if (zipButton) zipButton.disabled = true;
      if (preview) preview.textContent = '';
      say('');
      modal.classList.remove('hidden');
    }
    function closeModal() { if (modal) modal.classList.add('hidden'); }

    return { open, close: closeModal };
  }

  return { createScaffoldUi };
});

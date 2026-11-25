// Sync panel UI test: exercises generate / pair / copy / sync / unpair with a fake bridge.
const assert = require('assert');
const { JSDOM } = require('jsdom');
const qr = require('../src/shared/qr.js');
const syncUi = require('../src/shared/sync-ui.js');

(async () => {
  const dom = new JSDOM('<!doctype html><div id="host"></div>');
  global.document = dom.window.document;

  let paired = false;
  const code = 'AbCdEfGhIjKlMnOpQrStUv';
  const bridge = {
    status: async () => ({ paired, blobId: paired ? 'a'.repeat(64) : null, code: paired ? code : '' }),
    generate: async () => { paired = true; return { code, blobId: 'a'.repeat(64) }; },
    enter: async (value) => { paired = true; return { paired, blobId: 'b'.repeat(64) }; },
    unpair: async () => { paired = false; return { paired: false }; },
    pull: async () => ({ sections: { settings: { data: { hue: 5 }, updatedAt: 1 } } }),
    push: async () => ({ ok: true }),
    getState: () => ({ settings: { hue: 2 } }),
    apply: async (profile) => Object.keys(profile.sections),
    copy: async () => true,
    reload: () => {},
  };

  const ui = syncUi.createSyncUi(document.getElementById('host'), bridge, { qr });
  await new Promise((r) => setTimeout(r, 0));
  assert.ok(document.querySelector('.sync-panel'), 'panel mounted');
  assert.ok(document.querySelector('input[placeholder="Paste a code from the other device"]'), 'unpaired state shows code entry');

  const buttons = [...document.querySelectorAll('button')];
  const generate = buttons.find((b) => b.textContent === 'Generate a pairing code');
  assert.ok(generate, 'generate button present');
  generate.click();
  await new Promise((r) => setTimeout(r, 0));
  assert.strictEqual(document.querySelector('.sync-code').value, code, 'generated code shown in a selectable field');
  assert.ok(document.querySelector('.sync-qr svg'), 'a locally rendered QR is shown');
  assert.match(document.querySelector('.sync-qr svg').outerHTML, /<rect/, 'QR has modules');

  document.querySelector('input.sync-code');
  const copyButton = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Copy');
  copyButton.click();
  await new Promise((r) => setTimeout(r, 0));
  assert.match(document.querySelector('.sync-message').textContent, /Copied/, 'copy reports success');

  const syncNow = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Sync now');
  assert.ok(syncNow, 'sync button present when paired');
  syncNow.click();
  await new Promise((r) => setTimeout(r, 10));
  assert.match(document.querySelector('.sync-message').textContent, /Sync complete/, 'sync completes');

  const unpair = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Unpair');
  unpair.click();
  await new Promise((r) => setTimeout(r, 0));
  assert.strictEqual(paired, false, 'unpair clears state');
  assert.ok(document.querySelector('input[placeholder="Paste a code from the other device"]'), 'returns to unpaired view');

  console.log('sync-ui.test.js: PASSED');
})().catch((e) => { console.error(e); process.exitCode = 1; });

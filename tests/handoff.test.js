// B1 handoff: explicit prompt text, safe CLI argv, scheme allowlist, and the chooser UI.
const assert = require('assert');
const { JSDOM } = require('jsdom');
const handoff = require('../src/shared/handoff.js');
const handoffUi = require('../src/shared/handoff-ui.js');

(async () => {
  assert.deepStrictEqual(handoff.DESTINATIONS.map((d) => d.id), ['cursor', 'claude', 'cline', 'vscode', 'hermes']);
  assert.strictEqual(handoff.destination('hermes').web, false, 'Hermes is desktop-only via CLI');

  const prompt = 'Build a cat-and-fish platformer\nwith 3 levels and no multiplayer.';
  const text = handoff.buildHandoffText(prompt, { action: 'build', folder: 'Z:/projects/cat' });
  assert.match(text, /^BUILD THIS APPROVED PROMPT/, 'build action is explicit');
  assert.ok(text.includes('Z:/projects/cat'), 'folder included');
  assert.ok(text.includes(prompt), 'prompt is verbatim');
  assert.match(text, /--- APPROVED PROMPT \(verbatim\) ---/, 'fenced prompt');
  const review = handoff.buildHandoffText(prompt, { action: 'review' });
  assert.match(review, /^REVIEW THIS APPROVED PROMPT/, 'review action is explicit');
  assert.match(review, /do not edit files/i, 'review does not imply implementation');
  assert.ok(!review.includes('Work in this project folder'), 'no folder line when omitted');

  for (const url of ['cursor://', 'claude://new', 'cline://x', 'vscode://file/x']) {
    assert.strictEqual(handoff.isAllowedUrl(url), true, `allows ${url}`);
  }
  for (const bad of ['javascript:alert(1)', 'https://evil.test', 'cursor://x & calc', '', null, 'CURSOR://ok'.toUpperCase() + ' ']) {
    assert.strictEqual(handoff.isAllowedUrl(bad), false, `rejects ${String(bad)}`);
  }

  const args = handoff.hermesArgs(text);
  assert.deepStrictEqual(args.slice(0, 2), ['chat', '-q'], 'hermes CLI flags');
  assert.strictEqual(args[2], text, 'text passed as one argv element, never through a shell');
  assert.strictEqual(args.length, 3, 'no extra arguments');

  const store = { getItem: (k) => ({ gv_hermes_api: 'http://127.0.0.1:8080', gv_hermes_token: 't' })[k] || '' };
  assert.strictEqual(handoff.gatewayConfig({ getItem: () => '' }), null, 'no token -> opt-in path disabled');
  assert.deepStrictEqual(handoff.gatewayConfig(store), { base: 'http://127.0.0.1:8080', token: 't' });

  // UI: button inserted next to Copy, chooser sends the built text to the chosen bridge.
  const dom = new JSDOM('<!doctype html><div class="row"><button id="btnCopy">Copy</button></div><textarea id="final">chosen prompt</textarea>');
  global.document = dom.window.document;
  const calls = [];
  const bridge = {
    copy: async (t) => { calls.push(['copy', t]); return true; },
    open: async (u) => { calls.push(['open', u]); return true; },
    hermes: async (t) => { calls.push(['hermes', t]); return { ok: true, message: 'started' }; },
  };
  const ui = handoffUi.createHandoffUi({ handoff, bridge });
  const sendButton = dom.window.document.createElement('button');
  sendButton.id = 'btnSendTo';
  sendButton.addEventListener('click', () => ui.open(dom.window.document.getElementById('final').value));
  dom.window.document.getElementById('btnCopy').parentElement.appendChild(sendButton);
  sendButton.click();
  const modal = dom.window.document.getElementById('handoffModal');
  assert.ok(modal && !modal.classList.contains('hidden'), 'chooser opens');

  dom.window.document.querySelector('[data-dest="cursor"]').click();
  await new Promise((r) => setTimeout(r, 0));
  assert.strictEqual(calls[0][0], 'copy', 'prompt copied first');
  assert.ok(calls[0][1].includes('chosen prompt'), 'copied text includes the prompt');
  assert.deepStrictEqual(calls[1], ['open', 'cursor://'], 'agent scheme opened after copy');

  dom.window.document.querySelector('[data-dest="hermes"]').click();
  await new Promise((r) => setTimeout(r, 0));
  assert.strictEqual(calls.at(-1)[0], 'hermes', 'Hermes uses the direct path');
  assert.ok(!calls.some((c) => c[0] === 'open' && String(c[1]).includes('discord')), 'no Discord URL is ever opened');

  console.log('handoff.test.js: PASSED');
})().catch((e) => { console.error(e); process.exitCode = 1; });

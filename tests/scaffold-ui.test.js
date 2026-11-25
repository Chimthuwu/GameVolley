// B2 scaffold UI: a manifest must be parsed and previewed, and no write happens before
// the user picks a destination and confirms.
const assert = require('assert');
const { JSDOM } = require('jsdom');
const scaffold = require('../src/shared/scaffold.js');
const scaffoldUi = require('../src/shared/scaffold-ui.js');

(async () => {
  const dom = new JSDOM('<!doctype html><body></body>');
  global.document = dom.window.document;

  const manifest = [
    { path: 'PROMPT.md', content: 'build a cat game' },
    { path: 'README.md', content: '# cat game' },
    { path: 'todo.md', content: '# old handoff' },
  ];
  const calls = [];
  const bridge = {
    generate: async (prompt, cycles, model, feedback) => {
      calls.push(['generate', prompt, cycles, model, feedback]);
      return { text: JSON.stringify(manifest) };
    },
    review: async (manifest) => { calls.push(['review', manifest.length]); return { text: '1. todo.md needs a definition of done' }; },
    pickDir: async () => '/tmp/chosen',
    write: async (files, destination, merge) => { calls.push(['write', files.length, destination, merge]); return { count: files.length }; },
    downloadZip: async (files) => { calls.push(['zip', files.length]); return { count: files.length }; },
  };
  const ui = scaffoldUi.createScaffoldUi({ scaffold, bridge, web: true, model: () => 'test-model' });
  ui.open('build a cat game');
  const modal = dom.window.document.getElementById('scaffoldModal');
  assert.ok(modal && !modal.classList.contains('hidden'), 'modal opens');
  const writeButton = [...dom.window.document.querySelectorAll('button')].find((b) => b.textContent === 'Confirm & write');
  assert.strictEqual(writeButton.disabled, true, 'cannot write before generating');

  const generateButton = [...dom.window.document.querySelectorAll('button')].find((b) => b.textContent === 'Generate manifest');
  generateButton.click();
  await new Promise((r) => setTimeout(r, 0));
  assert.deepStrictEqual(calls[0], ['generate', 'build a cat game', 1, 'test-model', undefined], 'model called with depth and model');
  assert.strictEqual(calls[1][0], 'review', 'critic reviews the manifest');
  assert.strictEqual(calls[2][0], 'generate', 'author regenerates after critic feedback');
  assert.strictEqual(calls[2][4], '1. todo.md needs a definition of done', 'feedback passed to the author round');
  assert.match(dom.window.document.querySelector('.scaffold-preview').textContent, /Manifest ready: 3 files/, 'preview shows file count');
  assert.strictEqual(writeButton.disabled, true, 'still cannot write before destination');
  assert.match(dom.window.document.querySelector('.scaffold-preview').textContent, /todo\.md/, 'handoff file included');

  const pick = [...dom.window.document.querySelectorAll('button')].find((b) => b.textContent === 'Pick destination');
  pick.click();
  await new Promise((r) => setTimeout(r, 0));
  assert.strictEqual(writeButton.disabled, false, 'destination enables the write button');
  assert.match(dom.window.document.querySelector('.scaffold-preview').textContent, /About to create 3 files in \/tmp\/chosen/, 'preview confirms destination');

  writeButton.click();
  await new Promise((r) => setTimeout(r, 0));
  assert.deepStrictEqual(calls.at(-1), ['write', 3, '/tmp/chosen', true], 'write goes to the chosen folder');
  assert.match(dom.window.document.querySelector('#scaffoldModal [role=status]').textContent, /Wrote 3 files/, 'success reported');

  const zip = [...dom.window.document.querySelectorAll('button')].find((b) => b.textContent === 'Download ZIP');
  zip.click();
  await new Promise((r) => setTimeout(r, 0));
  assert.deepStrictEqual(calls.at(-1), ['zip', 3], 'web ZIP fallback available');

  console.log('scaffold-ui.test.js: PASSED');
})().catch((e) => { console.error(e); process.exitCode = 1; });

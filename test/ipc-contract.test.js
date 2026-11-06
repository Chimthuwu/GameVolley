'use strict';
// Integration checks for the sidebar history IPC surface.
//
// These assert that main.js and preload.js expose exactly the channels the renderer
// calls, that the channels are backed by lib/runs-store.js, and that the web build
// (site/pv.js) offers the same API against localStorage. A renderer calling a
// channel that main.js never registers is the classic "button does nothing" bug —
// this file makes that mismatch fail the build instead.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const main = read('main.js');
const preload = read('preload.js');
const renderer = read('renderer/app.js');
const siteApp = read('site/app.js');
const sitePv = read('site/pv.js');

// Every method the renderer's history UI calls must exist on the pv bridge.
const RENDERER_PV_CALLS = [
  'pv.runs(', 'pv.openRun(', 'pv.updateRun(',
  'pv.renameRun(', 'pv.deleteRun(', 'pv.moveRun(',
  'pv.projects(', 'pv.renameProject(', 'pv.deleteProject(',
];

test('renderer only calls pv methods that preload exposes', () => {
  const exposed = new Set();
  const m = preload.match(/([A-Za-z0-9_]+)\s*:\s*inv\(/g) || [];
  for (const entry of m) exposed.add(entry.replace(/\s*:\s*inv\($/, ''));
  // pv.stop / pv.sendNotes are also inv-based, so the set above is complete.
  for (const call of RENDERER_PV_CALLS) {
    const method = call.slice(3, -1);
    assert.ok(exposed.has(method), `preload.js must expose ${method}`);
  }
});

test('site app calls the same pv methods the desktop renderer does', () => {
  for (const call of RENDERER_PV_CALLS) {
    assert.ok(siteApp.includes(call), `site/app.js must call ${call}`);
  }
});

test('site/pv.js implements every history mutation the UI calls', () => {
  for (const method of ['renameRun', 'deleteRun', 'moveRun', 'listProjects', 'renameProject', 'deleteProject']) {
    assert.ok(new RegExp(`function ${method}\\s*\\(`).test(sitePv), `site/pv.js must define ${method}()`);
  }
  // And exposes them on the pv object.
  for (const method of ['renameRun', 'deleteRun', 'moveRun', 'projects', 'renameProject', 'deleteProject']) {
    assert.ok(new RegExp(`${method}:\\s*async`).test(sitePv), `site/pv.js must expose ${method} on pv`);
  }
});

test('main.js registers an IPC handler for every channel preload invokes', () => {
  const channels = new Set();
  const m = preload.match(/inv\('([^']+)'\)/g) || [];
  for (const entry of m) channels.add(entry.slice(5, -2));
  for (const ch of channels) {
    assert.ok(
      main.includes(`ipcMain.handle('${ch}'`),
      `main.js must register ipcMain.handle('${ch}')`,
    );
  }
});

test('main.js routes the history mutations through the store module', () => {
  for (const ch of ['runs:list', 'runs:read', 'runs:update', 'runs:rename', 'runs:delete', 'runs:move', 'projects:list', 'projects:rename', 'projects:delete']) {
    // Grab the whole handler body (it can span several lines). Match balanced
    // parens so an inner `fs.mkdirSync(...)` doesn't end the slice early.
    const start = main.indexOf(`ipcMain.handle('${ch}'`);
    assert.ok(start !== -1, `main.js must register ${ch}`);
    const open = main.indexOf('(', start);
    let depth = 0, end = open;
    for (; end < main.length; end++) {
      if (main[end] === '(') depth++;
      else if (main[end] === ')') { depth--; if (depth === 0) break; }
    }
    const body = main.slice(start, end);
    assert.ok(body.includes('runsStore.'), `${ch} must delegate to runsStore`);
  }
});

test('both builds bind the history menu by delegation, not by load-time query', () => {
  for (const src of [renderer, siteApp]) {
    // The old code bound listeners to the rows that existed at script load, when the
    // sidebar was still empty — so right-click never fired.
    assert.ok(!/querySelectorAll\('\.hist-item'\)\.forEach/.test(src), 'must not bind .hist-item at load time');
    assert.ok(src.includes("addEventListener('contextmenu'"), 'must listen for contextmenu');
    assert.ok(src.includes('closest(\'.hist-item\')'), 'must resolve the clicked row');
  }
});

test('both builds never call window.prompt', () => {
  // Electron renderers define prompt() but it THROWS "prompt() is not supported."
  // (verified against electron 33). confirm() does work, so it is not flagged here.
  // Match a bare call: not preceded by a word char or a dot, so askText/askConfirm
  // and any property named `prompt` are not flagged.
  for (const src of [renderer, siteApp]) {
    // Strip comments and string literals first so prose like "window.prompt()" in a
    // comment is not mistaken for a call.
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/\/\/[^\n]*/g, ' ')
      .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
      .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
      .replace(/`(?:[^`\\]|\\.)*`/g, '``');
    const calls = code.match(/(^|[^.\w])prompt\s*\(/g) || [];
    assert.deepEqual(calls, [], `must not call ${calls.join(', ')}`);
  }
});

test('both builds provide the prompt modal markup and the modal helper', () => {
  for (const html of [read('renderer/index.html'), read('site/index.html')]) {
    assert.ok(html.includes('id="promptModal"'), 'needs a prompt modal');
    assert.ok(html.includes('id="promptInput"'), 'needs a prompt input');
    assert.ok(html.includes('id="promptOk"'), 'needs a prompt OK button');
  }
  for (const src of [renderer, siteApp]) {
    assert.ok(src.includes('function askText('), 'needs askText()');
    assert.ok(src.includes('function askConfirm('), 'needs askConfirm()');
  }
});

test('the context menu scopes its items to run vs project targets', () => {
  for (const html of [read('renderer/index.html'), read('site/index.html')]) {
    assert.ok(html.includes('data-scope="run"'), 'run-scoped menu items');
    assert.ok(html.includes('data-scope="project"'), 'project-scoped menu items');
  }
});

test('the context menu is made visible, not merely un-hidden', () => {
  // .context-menu has opacity:0 and pointer-events:none until .visible is added.
  for (const src of [renderer, siteApp]) {
    assert.ok(src.includes("classList.add('visible')"), 'must add .visible');
    assert.ok(src.includes("classList.remove('visible')"), 'must remove .visible');
  }
});

test('package.json ships lib/ in the packaged app', () => {
  // main.js requires ./lib/runs-store.js at runtime. If electron-builder's `files`
  // allowlist omits lib/, the app throws MODULE_NOT_FOUND on first launch.
  const pkg = JSON.parse(read('package.json'));
  const files = pkg.build.files || [];
  assert.ok(files.includes('lib/**'), `build.files must include lib/** (got ${JSON.stringify(files)})`);
});

test('main.js requires the store module with a path that survives packaging', () => {
  assert.ok(
    /require\(['"]\.\/lib\/runs-store\.js['"]\)/.test(main),
    "main.js must require './lib/runs-store.js' (a relative path, so asar packing works)",
  );
});

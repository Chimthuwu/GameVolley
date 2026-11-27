// Tests for src/main/preview-manager.js — bounds, fullscreen, safe path joins,
// and the (mocked) WebContentsView lifecycle. The real static server is exercised
// against a temp folder; no GUI is required.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const PreviewManager = require('../src/main/preview-manager.js');

class FakeWC {
  constructor() { this.events = {}; this.bounds = null; this.url = null; this.reloaded = false; this.navBlocked = false; }
  on(ev, cb) { (this.events[ev] = this.events[ev] || []).push(cb); }
  setWindowOpenHandler(cb) { this._openHandler = cb; }
  setBounds(b) { this.bounds = b; }
  async loadURL(u) { this.url = u; return Promise.resolve(); }
  reload() { this.reloaded = true; }
  close() {}
}
class FakeView { constructor() { this.webContents = new FakeWC(); } setBounds(b) { this.webContents.setBounds(b); } }
const fakeElectron = { WebContentsView: FakeView };
const fakeWin = { contentView: { addChildView() {}, removeChildView() {} }, getContentSize: () => [1200, 800] };

test('safeJoin refuses path traversal', () => {
  // A URL's leading "/" is NOT an absolute filesystem path (it resolves inside
  // root). Genuinely absolute paths (drive letters, UNC, traversal) are refused.
  assert.strictEqual(PreviewManager.safeJoin('/proj', '/etc/passwd'), path.resolve('/proj', 'etc/passwd'));
  assert.strictEqual(PreviewManager.safeJoin('/proj', 'C:\\etc\\passwd'), null);
  assert.strictEqual(PreviewManager.safeJoin('/proj', '../outside'), null);
  assert.strictEqual(PreviewManager.safeJoin('/proj', 'game/index.html'), path.resolve('/proj', 'game/index.html'));
});

test('setBounds stores and applies to the view', () => {
  const pm = new PreviewManager({ window: fakeWin, onEvent: () => {}, electron: fakeElectron });
  pm.setBounds({ x: 10, y: 20, width: 100, height: 50 });
  assert.ok(pm.view, 'view is created lazily on first bounds set');
  assert.deepStrictEqual(pm.view.webContents.bounds, { x: 10, y: 20, width: 100, height: 50 });
});

const FULL = { x: 0, y: 36, width: 1200, height: 764 }; // the 36px strip holds the Exit bar
const SMALL = { x: 300, y: 150, width: 800, height: 200 };

test('fullscreen fills the window below the exit bar', () => {
  const pm = new PreviewManager({ window: fakeWin, onEvent: () => {}, electron: fakeElectron });
  assert.strictEqual(pm.fullscreen(), true);
  assert.deepStrictEqual(pm.view.webContents.bounds, FULL);
});

test('layout updates from the screen do not end fullscreen', () => {
  const events = [];
  const pm = new PreviewManager({ window: fakeWin, onEvent: (e) => events.push(e), electron: fakeElectron });
  pm.setBounds(SMALL);
  pm.fullscreen(true);
  pm.setBounds(SMALL); // the screen re-lays out: after the click, on resize, on preview load
  assert.deepStrictEqual(pm.view.webContents.bounds, FULL, 'still fullscreen');
  pm.setBounds({ ...SMALL, height: 220 });
  assert.strictEqual(pm.fullscreen(false), false);
  assert.deepStrictEqual(pm.view.webContents.bounds, { ...SMALL, height: 220 }, 'goes back to the latest place');
  assert.deepStrictEqual(events.filter((e) => e.type === 'preview:fullscreen').map((e) => e.full), [true, false]);
});

test('Esc inside the game leaves fullscreen, and only then is Esc taken from the game', () => {
  const pm = new PreviewManager({ window: fakeWin, onEvent: () => {}, electron: fakeElectron });
  pm.setBounds(SMALL);
  const press = (key) => {
    let taken = false;
    for (const cb of pm.view.webContents.events['before-input-event']) cb({ preventDefault: () => { taken = true; } }, { type: 'keyDown', key });
    return taken;
  };
  assert.strictEqual(press('Escape'), false, 'the game keeps Esc outside fullscreen');
  pm.fullscreen(true);
  assert.strictEqual(press('w'), false, 'other keys reach the game');
  assert.strictEqual(pm.full, true);
  assert.strictEqual(press('Escape'), true);
  assert.strictEqual(pm.full, false);
  assert.deepStrictEqual(pm.view.webContents.bounds, SMALL);
});

test('closing the preview ends fullscreen', async () => {
  const events = [];
  const pm = new PreviewManager({ window: fakeWin, onEvent: (e) => events.push(e), electron: fakeElectron });
  pm.fullscreen(true);
  await pm.close();
  assert.strictEqual(pm.full, false);
  assert.strictEqual(events.at(-1).full, false);
});

test('loadProject serves a file entry over http and reload closes cleanly', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gv-pv-'));
  await fs.writeFile(path.join(dir, 'index.html'), '<h1>hi</h1>');
  const events = [];
  const pm = new PreviewManager({ window: fakeWin, onEvent: (e) => events.push(e), electron: fakeElectron });
  const url = await pm.loadProject({ projectPath: dir, entry: { type: 'file', path: 'index.html' } });
  assert.ok(/^http:\/\/127\.0\.0\.1:\d+\/index\.html$/.test(url), 'served over local http');
  assert.ok(events.some((e) => e.type === 'preview:load'), 'emits preview:load');
  await pm.close();
  assert.strictEqual(pm.staticServer, null, 'static server stopped on close');
});

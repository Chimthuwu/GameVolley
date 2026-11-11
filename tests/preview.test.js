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
  constructor() { this.events = {}; this.bounds = null; this.url = null; this.reloaded = false; }
  on(ev, cb) { (this.events[ev] = this.events[ev] || []).push(cb); }
  setBounds(b) { this.bounds = b; }
  async loadURL(u) { this.url = u; return Promise.resolve(); }
  reload() { this.reloaded = true; }
  close() {}
}
class FakeView { constructor() { this.webContents = new FakeWC(); } setBounds(b) { this.webContents.setBounds(b); } }
const fakeElectron = { WebContentsView: FakeView };
const fakeWin = { contentView: { addChildView() {}, removeChildView() {} }, getContentSize: () => [1200, 800] };

test('safeJoin refuses path traversal', () => {
  assert.strictEqual(PreviewManager.safeJoin('/proj', '/etc/passwd'), null);
  assert.strictEqual(PreviewManager.safeJoin('/proj', '../outside'), null);
  assert.strictEqual(PreviewManager.safeJoin('/proj', 'game/index.html'), path.resolve('/proj', 'game/index.html'));
});

test('setBounds stores and applies to the view', () => {
  const pm = new PreviewManager({ window: fakeWin, onEvent: () => {}, electron: fakeElectron });
  pm.setBounds({ x: 10, y: 20, width: 100, height: 50 });
  assert.ok(pm.view, 'view is created lazily on first bounds set');
  assert.deepStrictEqual(pm.view.webContents.bounds, { x: 10, y: 20, width: 100, height: 50 });
});

test('fullscreen fills the window content area', () => {
  const pm = new PreviewManager({ window: fakeWin, onEvent: () => {}, electron: fakeElectron });
  pm.fullscreen();
  assert.deepStrictEqual(pm.view.webContents.bounds, { x: 0, y: 0, width: 1200, height: 800 });
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

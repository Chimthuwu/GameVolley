// Running a game project's npm commands: nothing without approval, npm found safely,
// install scripts off, and the dev server started, reused and stopped. The tests that
// run npm use the real one, offline, with a package from a local folder.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ProjectScripts, findNpm, fingerprint } = require('../src/main/lib/project-scripts.js');
const PreviewManager = require('../src/main/preview-manager.js');
const { validateProject } = require('../src/main/lib/validate-project.js');

const offlineBefore = process.env.npm_config_offline;
before(() => { process.env.npm_config_offline = 'true'; });
after(() => { if (offlineBefore === undefined) delete process.env.npm_config_offline; else process.env.npm_config_offline = offlineBefore; });

const write = (root, name, content) => {
  const file = path.join(root, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
};
const mark = (name) => `node -e "require('fs').writeFileSync('${name}','x')"`;
const SERVER = `
  const http = require('http');
  const s = http.createServer((q, r) => { r.end('<h1>from the dev server</h1>'); });
  s.listen(0, '127.0.0.1', () => console.log('  Local:   http://127.0.0.1:' + s.address().port + '/'));
`;

// A project with a space in its path, like "New folder (2)".
function project(t, pkg, files = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gv scripts (t) '));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
  write(root, 'package.json', pkg);
  for (const [name, content] of Object.entries(files)) write(root, name, content);
  return root;
}
const pkgOf = (root) => JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const has = (root, name) => fs.existsSync(path.join(root, name));
const reachable = (url) => fetch(url, { signal: AbortSignal.timeout(2000) }).then((r) => r.text(), () => null);
async function eventually(check, ms = 8000) {
  const end = Date.now() + ms;
  while (!(await check())) { if (Date.now() > end) return false; await new Promise((r) => setTimeout(r, 150)); }
  return true;
}

test('npm is taken from PATH by full path, never from the project folder', { skip: process.platform !== 'win32' }, (t) => {
  const root = project(t, {}, { 'npm.cmd': '@echo planted', 'tools/npm.cmd': '@echo planted' });
  const real = fs.mkdtempSync(path.join(os.tmpdir(), 'gv-npm-'));
  t.after(() => fs.rmSync(real, { recursive: true, force: true }));
  write(real, 'npm.cmd', '@echo real');
  const PATH = ['.', 'node_modules\\.bin', root, path.join(root, 'tools'), real].join(';');
  assert.strictEqual(findNpm(root, { Path: PATH }, 'win32'), path.join(real, 'npm.cmd'));
  assert.strictEqual(findNpm(root, { Path: `.;${root}` }, 'win32'), null);
});

test('nothing runs unless the user says yes, and a "no" is asked again only after a retry', async (t) => {
  const root = project(t, { scripts: { dev: mark('ran-dev'), build: mark('ran-build') } });
  for (const approve of [async () => false, async () => undefined, async () => { throw new Error('dialog broke'); }, async () => 'yes']) {
    const scripts = new ProjectScripts({ approve });
    assert.strictEqual((await scripts.build(root, pkgOf(root))).status, 'skipped');
    assert.strictEqual((await scripts.startDev(root, pkgOf(root))).ok, false);
  }
  assert.strictEqual((await new ProjectScripts().build(root, pkgOf(root))).status, 'skipped', 'no approver means no');
  assert.ok(!has(root, 'ran-dev') && !has(root, 'ran-build'), 'neither command ran');

  let asked = 0;
  const scripts = new ProjectScripts({ approve: async () => { asked++; return false; } });
  await scripts.build(root, pkgOf(root));
  await scripts.startDev(root, pkgOf(root));
  assert.strictEqual(asked, 1, 'one question, not one per command');
  scripts.forgetRefusals();
  await scripts.build(root, pkgOf(root));
  assert.strictEqual(asked, 2);
});

test('changing the commands, packages or bundler setup asks again', (t) => {
  const root = project(t, { scripts: { dev: 'vite' }, dependencies: { three: '0.170.0' } });
  const first = fingerprint(root, pkgOf(root));
  assert.strictEqual(fingerprint(root, pkgOf(root)), first);
  const seen = new Set([first]);
  for (const change of [
    () => write(root, 'package.json', { scripts: { dev: 'node anything.js' }, dependencies: { three: '0.170.0' } }),
    () => write(root, 'package.json', { scripts: { dev: 'vite' }, dependencies: { three: '0.170.0', extra: '1.0.0' } }),
    () => write(root, 'vite.config.ts', 'export default {}'),
    () => write(root, '.npmrc', 'registry=http://example.invalid'),
  ]) { change(); seen.add(fingerprint(root, pkgOf(root))); }
  assert.strictEqual(seen.size, 5);
});

test('real npm: installs with install scripts off, then builds; a failing build is reported', async (t) => {
  const root = project(t, {
    name: 'game', version: '1.0.0',
    scripts: { postinstall: mark('ran-project-postinstall'), build: 'node build.js' },
    dependencies: { localpkg: 'file:./vendor/localpkg' },
  }, {
    'vendor/localpkg/package.json': { name: 'localpkg', version: '1.0.0', scripts: { postinstall: mark('ran-package-postinstall') } },
    'build.js': "require('fs').writeFileSync('built','x'); console.log('built fine');",
  });
  const asked = [];
  const scripts = new ProjectScripts({ approve: async (info) => { asked.push(info); return true; } });
  assert.deepStrictEqual(await scripts.build(root, pkgOf(root)), { status: 'ok' });
  assert.ok(has(root, 'node_modules/localpkg/package.json'), 'the package was installed');
  assert.ok(has(root, 'built'), 'the build ran');
  assert.ok(!has(root, 'ran-project-postinstall') && !has(root, 'vendor/localpkg/ran-package-postinstall'), 'no install script ran');
  assert.strictEqual(asked[0].needsInstall, true);
  assert.ok(asked[0].scripts.some((s) => s.includes('node build.js')), 'the question shows the command');
  assert.ok(asked[0].packages.some((p) => p.includes('localpkg')), 'and the packages');

  write(root, 'build.js', "console.error('src/game.ts(3,1): error TS1005'); process.exit(2);");
  const failed = await scripts.build(root, pkgOf(root));
  assert.strictEqual(failed.status, 'failed');
  assert.match(failed.output, /error TS1005/);
});

test('real npm: the dev server is started, reused and really stopped', async (t) => {
  const root = project(t, { scripts: { dev: 'node server.js' } }, { 'server.js': SERVER });
  const scripts = new ProjectScripts({ approve: async () => true });
  t.after(() => scripts.stop());
  const started = await scripts.startDev(root, pkgOf(root));
  assert.strictEqual(started.ok, true, started.reason);
  assert.match(await reachable(started.url), /from the dev server/, 'ready as soon as it is reported');
  assert.strictEqual((await scripts.startDev(root, pkgOf(root))).url, started.url, 'the same server is reused');
  scripts.stopDev();
  assert.ok(await eventually(async () => (await reachable(started.url)) === null), 'nothing is left listening');
});

test('real npm: a dev server that dies or never gives an address is reported, not left running', async (t) => {
  const dies = project(t, { scripts: { dev: 'node boom.js' } }, { 'boom.js': "console.error('Error: port exploded'); process.exit(1);" });
  const a = await new ProjectScripts({ approve: async () => true }).startDev(dies, pkgOf(dies));
  assert.strictEqual(a.ok, false);
  assert.match(a.reason, /port exploded/);

  const silent = project(t, { scripts: { start: 'node wait.js' } }, { 'wait.js': 'setInterval(() => {}, 1000);' });
  const scripts = new ProjectScripts({ approve: async () => true, devTimeoutMs: 2500 });
  const b = await scripts.startDev(silent, pkgOf(silent));
  assert.strictEqual(b.ok, false);
  assert.match(b.reason, /no local address/);
  assert.strictEqual(scripts.dev, null);
});

test('a missing npm is a message, not a crash', async (t) => {
  const root = project(t, { scripts: { dev: 'vite', build: 'vite build' } });
  const scripts = new ProjectScripts({ approve: async () => true, npm: () => null });
  assert.match((await scripts.build(root, pkgOf(root))).output, /npm was not found/);
  assert.match((await scripts.startDev(root, pkgOf(root))).reason, /npm was not found/);
});

test('which games need a dev server', async (t) => {
  const { needsDevServer } = PreviewManager;
  const cases = [
    [true, { 'index.html': '<script type="module" src="/src/main.ts"></script>' }],
    [true, { 'index.html': '<script type="module" src="main.js"></script>', 'main.js': "import * as THREE from 'three';" }],
    [false, { 'index.html': '<script type="module" src="main.js"></script>', 'main.js': "import { a } from './a.js';" }],
    [false, { 'index.html': '<script>let x = 1;</script>' }],
    [false, { 'index.html': '<script type="importmap">{}</script><script type="module">import * as THREE from "three";</script>' }],
  ];
  for (const [want, files] of cases) {
    const root = project(t, {}, files);
    assert.strictEqual(await needsDevServer(root), want, JSON.stringify(files));
  }
});

// A stand-in for Electron's preview view that "loads" whatever it is given.
function fakePreview(events, scripts) {
  class View {
    constructor() {
      const handlers = {};
      this.webContents = {
        urls: [], on: (n, cb) => { handlers[n] = cb; }, setWindowOpenHandler() {}, close() {},
        reload() { setTimeout(() => handlers['did-finish-load'](), 5); },
        loadURL: async (u) => { this.webContents.urls.push(u); handlers['did-finish-load'](); },
      };
    }
    setBounds() {}
  }
  return new PreviewManager({
    window: { contentView: { addChildView() {}, removeChildView() {} }, getContentSize: () => [800, 600] },
    onEvent: (e) => events.push(e), electron: { WebContentsView: View }, scripts,
  });
}
const DEV_ENTRY = { type: 'devserver', command: 'npm run dev', url: 'http://localhost:5173' };

test('preview: a refused TypeScript game explains itself instead of showing a broken page', async (t) => {
  const root = project(t, { scripts: { dev: 'vite', build: 'vite build' } },
    { 'index.html': '<script type="module" src="/src/main.ts"></script>', 'src/main.ts': "import './styles.css';" });
  const events = [];
  const preview = fakePreview(events, new ProjectScripts({ approve: async () => false }));
  await preview.loadProject({ projectPath: root, entry: DEV_ENTRY });
  assert.match(preview.unavailable, /needs its dev server.*chose not to run/s);
  assert.ok(events.some((e) => e.type === 'preview:error'));
  assert.ok(!events.some((e) => e.type === 'preview:ready'), 'never reported as ready');
  assert.ok(preview.view.webContents.urls[0].startsWith('data:text/html'));

  const result = await validateProject({ root, preview });
  assert.deepStrictEqual(result.blocking, [], 'not something the Developer can fix, so it does not block');
  assert.ok(result.warnings.some((w) => /Runtime check skipped.*NOT proof/s.test(w)));
  assert.ok(result.warnings.some((w) => /Build not run/.test(w)));
  await preview.close();
});

test('preview: a refused game that works without npm is shown from index.html', async (t) => {
  const root = project(t, { scripts: { dev: 'vite' } }, { 'index.html': '<h1>plain</h1>' });
  const events = [];
  const preview = fakePreview(events, new ProjectScripts({ approve: async () => false }));
  t.after(() => preview.close());
  const url = await preview.loadProject({ projectPath: root, entry: DEV_ENTRY });
  assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/index\.html$/);
  assert.strictEqual(preview.unavailable, null);
  assert.ok(events.some((e) => e.type === 'stage' && /showing index\.html directly/.test(e.detail)));
});

test('preview and build gate use the approved dev server and build', async (t) => {
  const root = project(t, { scripts: { dev: 'node server.js', build: 'node -e "process.exit(1)"' } },
    { 'server.js': SERVER, 'index.html': '<h1>x</h1>' });
  const scripts = new ProjectScripts({ approve: async () => true });
  const preview = fakePreview([], scripts);
  t.after(async () => { await preview.close(); scripts.stop(); });
  const url = await preview.loadProject({ projectPath: root, entry: DEV_ENTRY });
  assert.match(await reachable(url), /from the dev server/);
  const result = await validateProject({ root, preview, runtime: { timeoutMs: 2000, settleMs: 20 } });
  assert.ok(result.blocking.some((b) => b.startsWith('Build failed')), 'a failing build blocks');
  await preview.close();
  assert.ok(await eventually(async () => (await reachable(url)) === null), 'closing the preview stops the server');
});

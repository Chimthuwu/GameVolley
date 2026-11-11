// Unit tests for src/main/project-manager.js — the real filesystem workspace.
// No credentials, no CLIs: just real disk operations against a temp project.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const ProjectManager = require('../src/main/project-manager.js');

async function tmp() { return fs.mkdtemp(path.join(os.tmpdir(), 'gv-pm-')); }
function makePm() { return new ProjectManager(); }

test('createProject makes the folder and records metadata', async () => {
  const dir = await tmp();
  const pm = makePm();
  const info = await pm.createProject(path.join(dir, 'game1'), { idea: 'frog pizzeria' });
  assert.strictEqual(info.name, 'game1');
  const meta = JSON.parse(await fs.readFile(path.join(dir, 'game1', '.gamevolley', 'meta.json'), 'utf8'));
  assert.strictEqual(meta.idea, 'frog pizzeria');
});

test('writeFile / readFile roundtrip + nested dirs', async () => {
  const dir = await tmp();
  const pm = makePm();
  await pm.openProject(dir);
  await pm.writeFile('src/game.js', 'console.log("hi");');
  const got = await pm.readFile('src/game.js');
  assert.strictEqual(got, 'console.log("hi");');
});

test('listFiles ignores node_modules, .git and .env', async () => {
  const dir = await tmp();
  const pm = makePm();
  await pm.openProject(dir);
  await pm.writeFile('game.js', 'x');
  await fs.mkdir(path.join(dir, 'node_modules'));
  await fs.writeFile(path.join(dir, 'node_modules', 'evil.js'), 'x');
  await fs.writeFile(path.join(dir, '.env'), 'SECRET=1');
  await fs.mkdir(path.join(dir, '.git'));
  const files = await pm.listFiles();
  const paths = files.map((f) => f.path);
  assert.ok(!paths.includes('node_modules/evil.js'));
  assert.ok(!paths.includes('.env'));
  assert.ok(paths.includes('game.js'));
});

test('path traversal is rejected', async () => {
  const dir = await tmp();
  const pm = makePm();
  await pm.openProject(dir);
  assert.throws(() => pm.resolveProjectPath('../escape.txt'), /escapes the project/);
  assert.throws(() => pm.resolveProjectPath('../../etc/passwd'), /escapes the project/);
});

test('writeFile refuses protected files', async () => {
  const dir = await tmp();
  const pm = makePm();
  await pm.openProject(dir);
  await assert.rejects(() => pm.writeFile('.env', 'SECRET=1'), /not allowed|Refusing/);
});

test('deleteFile requires explicit flag', async () => {
  const dir = await tmp();
  const pm = makePm();
  await pm.openProject(dir);
  await pm.writeFile('a.txt', 'x');
  await assert.rejects(() => pm.deleteFile('a.txt'), /explicit/);
  await pm.deleteFile('a.txt', { explicit: true });
  await assert.rejects(() => pm.readFile('a.txt'), /not found/);
});

test('snapshot + diff detects created/modified/deleted', async () => {
  const dir = await tmp();
  const pm = makePm();
  await pm.openProject(dir);
  await pm.writeFile('a.js', '1');
  const before = await pm.snapshotHashes();
  await pm.writeFile('a.js', '2');
  await pm.writeFile('b.js', 'new');
  const after = await pm.snapshotHashes();
  const changed = pm.diffSnapshots(before, after);
  const ops = changed.map((c) => c.path);
  assert.ok(ops.includes('a.js'));
  assert.ok(ops.includes('b.js'));
});

test('detectEntryPoint finds index.html and dev servers', async () => {
  const dir = await tmp();
  const pm = makePm();
  await pm.openProject(dir);
  await pm.writeFile('index.html', '<h1>hi</h1>');
  const e1 = await pm.detectEntryPoint();
  assert.strictEqual(e1.type, 'file');
  assert.strictEqual(e1.path, 'index.html');

  const dir2 = await tmp();
  const pm2 = makePm();
  await pm2.openProject(dir2);
  await fs.writeFile(path.join(dir2, 'package.json'), JSON.stringify({ scripts: { dev: 'vite' } }));
  const e2 = await pm2.detectEntryPoint();
  assert.strictEqual(e2.type, 'devserver');
  assert.strictEqual(e2.url, 'http://localhost:5173');
});

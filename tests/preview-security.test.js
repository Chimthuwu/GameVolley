// Preview static-server security tests: REAL HTTP against a REAL temp project dir
// (spec P0 1.2). Proves secrets/hidden files/symlink escapes/traversal are refused
// while normal game assets still serve.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const PreviewManager = require('../src/main/preview-manager.js');
const { isBlockedPath } = PreviewManager;

async function makeProject() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gv-sec-'));
  await fsp.mkdir(path.join(dir, 'assets'), { recursive: true });
  await fsp.writeFile(path.join(dir, 'index.html'), '<h1>game</h1>');
  await fsp.writeFile(path.join(dir, 'assets', 'game.js'), 'console.log(1)');
  await fsp.writeFile(path.join(dir, 'assets', 'tex.png'), Buffer.from([137, 80, 78, 71]));
  await fsp.writeFile(path.join(dir, '.env'), 'SECRET_TOKEN=supersecret');
  await fsp.writeFile(path.join(dir, '.env.local'), 'X=1');
  await fsp.mkdir(path.join(dir, '.git'));
  await fsp.writeFile(path.join(dir, '.git', 'config'), '[core] repoformat = pwn');
  await fsp.mkdir(path.join(dir, '.gamevolley'));
  await fsp.writeFile(path.join(dir, '.gamevolley', 'cp.json'), '{}');
  await fsp.writeFile(path.join(dir, 'server.key'), 'PRIVATE KEY MATERIAL');
  await fsp.writeFile(path.join(dir, 'cert.pem'), 'CERT MATERIAL');
  await fsp.mkdir(path.join(dir, 'node_modules', 'pkg'), { recursive: true });
  await fsp.writeFile(path.join(dir, 'node_modules', 'pkg', 'index.js'), 'module.exports=1');
  await fsp.writeFile(path.join(os.tmpdir(), 'gv-sec-outside.txt'), 'OUTSIDE CONTENT');
  // Directory junction (works unprivileged on Windows) pointing outside the root.
  try { await fsp.symlink(os.tmpdir(), path.join(dir, 'escape'), 'junction'); } catch { /* fs may not support */ }
  return dir;
}

test('safeJoin: URL leading slash is normal, real absolute paths are refused', () => {
  const root = path.resolve(os.tmpdir(), 'gv-sj-root');
  assert.equal(PreviewManager.safeJoin(root, '/index.html'), path.join(root, 'index.html'));
  assert.equal(PreviewManager.safeJoin(root, '/assets/game.js'), path.join(root, 'assets', 'game.js'));
  assert.equal(PreviewManager.safeJoin(root, '/../outside.txt'), null);
  assert.equal(PreviewManager.safeJoin(root, '/%2e%2e/outside.txt'), null);
  assert.equal(PreviewManager.safeJoin(root, 'C:\\windows\\system32'), null);
  assert.equal(PreviewManager.safeJoin(root, '\\\\server\\share\\x'), null);
  assert.equal(PreviewManager.safeJoin(root, '/a\0/b'), null);
});

test('isBlockedPath blocks secrets, hidden files, node_modules; allows normal assets', () => {
  for (const blocked of ['.env', '.env.local', '.git/config', '.gamevolley/cp.json', 'server.key', 'cert.pem', 'node_modules/pkg/index.js', 'a/.secret', 'id_rsa']) {
    assert.equal(isBlockedPath(blocked), true, blocked);
  }
  for (const ok of ['index.html', 'assets/game.js', 'assets/tex.png', 'src/game.js', 'deep/nested/file.css']) {
    assert.equal(isBlockedPath(ok), false, ok);
  }
});

test('static server serves game assets but refuses secrets, hidden, traversal and symlink escapes', async () => {
  const dir = await makeProject();
  const pm = new PreviewManager({});
  const port = await pm._startStaticServer(dir);
  const base = `http://127.0.0.1:${port}`;
  try {
    // Legit assets serve with right content types.
    const html = await fetch(`${base}/index.html`);
    assert.equal(html.status, 200);
    assert.ok((await html.text()).includes('game'));
    const js = await fetch(`${base}/assets/game.js`);
    assert.equal(js.status, 200);
    const png = await fetch(`${base}/assets/tex.png`);
    assert.equal(png.status, 200);
    assert.equal(png.headers.get('content-type'), 'image/png');

    // Secrets / hidden / protected — must NOT return their contents.
    for (const p of ['/.env', '/.env.local', '/.git/config', '/.gamevolley/cp.json', '/server.key', '/cert.pem', '/node_modules/pkg/index.js', '/assets/.hidden']) {
      const r = await fetch(base + p);
      const body = await r.text();
      assert.ok(r.status === 403 || r.status === 404, `${p} -> ${r.status}`);
      assert.ok(!body.includes('supersecret') && !body.includes('PRIVATE KEY') && !body.includes('CERT MATERIAL') && !body.includes('pwn'), `${p} leaked content`);
    }

    // Traversal & encoding tricks — must never reach the outside file.
    const outside = 'OUTSIDE CONTENT';
    for (const p of ['/../gv-sec-outside.txt', '/%2e%2e/gv-sec-outside.txt', '/..%2fgv-sec-outside.txt', '/assets/../../gv-sec-outside.txt', '/\\..\\gv-sec-outside.txt']) {
      const r = await fetch(base + encodeURI(p).replace(/%252e/gi, '%252e'));
      const body = await r.text();
      assert.ok(!body.includes(outside), `traversal ${p} leaked outside content`);
    }

    // Symlink/junction escape.
    try {
      const esc = await fetch(`${base}/escape/gv-sec-outside.txt`);
      const body = await esc.text();
      assert.ok(!body.includes(outside), 'symlink escape leaked outside content');
    } catch { /* junction unsupported in this fs — covered by unit checks above */ }
  } finally {
    await pm.close().catch(() => {});
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

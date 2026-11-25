// Conditional compilation + build parity: A1's shared-frontend acceptance checks.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

(async () => {
  const { processConditionals } = await import('../scripts/conditionals.mjs');
  const source = [
    'const shared = 1;',
    '// @if:renderer',
    "const platform = 'electron';",
    '// @endif',
    '// @if:web',
    "const platform = 'browser';",
    '// @endif',
    "// @platform:renderer const onlyDesktop = true;",
    "const after = 2;",
  ].join('\n');

  const renderer = processConditionals(source, 'renderer');
  const web = processConditionals(source, 'web');
  assert.match(renderer, /const shared = 1;/, 'shared code kept');
  assert.match(renderer, /const platform = 'electron';/, 'renderer block kept');
  assert.ok(!renderer.includes("const platform = 'browser';"), 'web block stripped');
  assert.match(renderer, /const onlyDesktop = true;/, 'single-line directive emitted for its platform');
  assert.match(web, /const platform = 'browser';/, 'web block kept');
  assert.ok(!web.includes('onlyDesktop'), 'single-line directive stripped on web');
  assert.match(web, /const after = 2;/, 'code after blocks survives');
  assert.strictEqual(processConditionals('// @if:renderer\nx\n// @endif', 'web').trim(), '', 'whole-file exclusion works');

  // build:shared must have emitted the shared modules and styles into BOTH targets.
  const root = path.join(__dirname, '..');
  const sharedPairing = fs.readFileSync(path.join(root, 'src', 'shared', 'pairing.js'), 'utf8');
  const sharedCss = fs.readFileSync(path.join(root, 'src', 'shared', 'style.css'), 'utf8');
  for (const target of ['renderer', 'site']) {
    const builtJs = fs.readFileSync(path.join(root, target, 'pairing.js'), 'utf8');
    const builtCss = fs.readFileSync(path.join(root, target, 'style.css'), 'utf8');
    assert.strictEqual(builtJs, sharedPairing, `${target}/pairing.js matches its single source`);
    assert.ok(builtCss.includes('.sync-panel'), `${target}/style.css contains shared styles`);
    assert.ok(builtCss.includes(sharedCss.trim().split('\n')[0]), `${target}/style.css starts with shared styles`);
  }
  for (const file of ['app.js', 'style.css', 'index.html', 'sync-ui.js', 'sync-boot.js']) {
    assert.ok(fs.existsSync(path.join(root, 'renderer', file)), `renderer/${file} emitted`);
    assert.ok(fs.existsSync(path.join(root, 'site', file)), `site/${file} emitted`);
  }

  console.log('conditionals.test.js: PASSED');
})().catch((e) => { console.error(e); process.exitCode = 1; });

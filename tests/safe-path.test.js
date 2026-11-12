// Path safety tests for resolveInside.
const { test } = require('node:test');
const assert = require('node:assert');
const { resolveInside } = require('../src/main/lib/safe-path.js');

test('path safety', () => {
  for (const bad of ['../x.js', '..\\x.js', '/etc/passwd', 'C:\\x.js', '\\\\server\\share\\x.js', 'a/../../x.js', '.git/config', 'node_modules/x.js', '.gamevolley/diagnostics/x.txt', '']) {
    assert.throws(() => resolveInside('/proj', bad), `expected throw for ${bad}`);
  }
  assert.doesNotThrow(() => resolveInside('/proj', 'a..b.js'));
  assert.doesNotThrow(() => resolveInside('/proj', 'src/game.js'));
  assert.doesNotThrow(() => resolveInside('/proj', 'folder.with.dots/file.js'));
  // A path that merely CONTAINS '..' inside a segment is fine.
  assert.doesNotThrow(() => resolveInside('/proj', 'my..file.js'));
});

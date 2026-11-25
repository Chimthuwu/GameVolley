// Desktop scaffold writer guardrails, against a real temporary directory.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const writer = require('../lib/scaffold-writer.js');

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gv-scaffold-'));
  try {
    const files = [
      { path: 'PROMPT.md', content: 'spec' },
      { path: 'src/index.js', content: 'console.log("ok")' },
      { path: 'todo.md', content: '# handoff' },
      { path: 'README.md', content: '# readme' },
    ];
    const result = writer.writeFiles(root, files, false);
    assert.strictEqual(result.count, 4, 'writes every file');
    assert.strictEqual(fs.readFileSync(path.join(root, 'src', 'index.js'), 'utf8'), 'console.log("ok")', 'nested path written');
    assert.ok(writer.existingFiles(root).includes('src/index.js'), 'existing files detected');

    assert.throws(() => writer.writeFiles(root, files, false), /already contains/, 'non-empty folder needs merge');
    assert.strictEqual(writer.writeFiles(root, files, true).count, 4, 'explicit merge overwrites');
    assert.throws(() => writer.writeFiles('', files, false), /Pick a destination/, 'empty destination refused');
    assert.throws(() => writer.writeFiles(root, [{ path: '../evil.txt', content: 'x' }], true), /Unsafe scaffold path/, 'traversal refused');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  console.log('scaffold-writer.test.js: PASSED');
})().catch((e) => { console.error(e); process.exitCode = 1; });

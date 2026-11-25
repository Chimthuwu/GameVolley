// B2 scaffold engine: depth semantics, strict manifest parsing, todo handoff,
// write guardrails and the dependency-free ZIP fallback.
const assert = require('assert');
const scaffold = require('../src/shared/scaffold.js');

(async () => {
  assert.deepStrictEqual(scaffold.depthForCycles(1), { level: 1, ...scaffold.DEPTH[1] });
  assert.strictEqual(scaffold.depthForCycles(0).level, 1, 'clamps low');
  assert.strictEqual(scaffold.depthForCycles(99).level, 3, 'clamps high');
  assert.match(scaffold.depthForCycles(2).instruction, /entry points/i, 'cycle 2 fills stubs');
  assert.match(scaffold.depthForCycles(3).instruction, /first milestone/i, 'cycle 3 is a head start');
  assert.match(scaffold.SCAFFOLD_AUTHOR_SYSTEM, /JSON array/i, 'author asks for a manifest');
  assert.match(scaffold.SCAFFOLD_CRITIC_SYSTEM, /APPROVE/i, 'critic reviews the manifest');
  const request = scaffold.buildScaffoldRequest('build a cat game', 2);
  assert.match(request.user, /build a cat game/, 'includes the approved prompt');
  assert.match(request.user, /depth: 2/, 'states the deterministic depth');

  for (const path of ['README.md', 'src/index.js', 'docs/api/guide.md', 'PROMPT.md']) {
    assert.strictEqual(scaffold.isValidPath(path), true, `allows ${path}`);
  }
  for (const bad of ['../secret', '/etc/passwd', 'C:\\x', 'a\\b', './x', 'a/../b', 'a//b', '', 'a/.env', '.git/config']) {
    assert.strictEqual(scaffold.isValidPath(bad), false, `rejects ${bad}`);
  }

  const manifest = [
    { path: 'PROMPT.md', content: 'build a cat game' },
    { path: 'README.md', content: '# Cat game\nRun npm start' },
    { path: 'todo.md', content: '# handoff' },
  ];
  assert.deepStrictEqual(scaffold.parseManifest(JSON.stringify(manifest)), manifest, 'parses a valid manifest');
  assert.strictEqual(scaffold.parseManifest('```json\n' + JSON.stringify(manifest) + '\n```').length, 3, 'accepts fenced JSON');
  const truncated = JSON.stringify(manifest).replace(/\]$/, '');
  assert.strictEqual(scaffold.parseManifest(truncated).length, 3, 'one-shot recovery of a truncated array');
  assert.throws(() => scaffold.parseManifest('just prose'), /not a JSON file manifest/);
  assert.throws(() => scaffold.parseManifest(JSON.stringify([{ path: '../evil', content: 'x' }])), /Unsafe scaffold path/);
  assert.throws(() => scaffold.parseManifest(JSON.stringify([manifest[0], manifest[0], manifest[1]])), /Duplicate scaffold path/);
  assert.throws(() => scaffold.parseManifest(JSON.stringify(manifest.slice(0, 2))), /missing todo.md/);
  assert.throws(() => scaffold.parseManifest(JSON.stringify([{ path: 'PROMPT.md', content: 5 }])), /string "path" and "content"/);
  const tooMany = Array.from({ length: scaffold.MAX_FILES + 1 }, (_, i) => ({ path: `f${i}.txt`, content: '' }));
  assert.throws(() => scaffold.parseManifest(JSON.stringify(tooMany)), /between 1 and/);

  const todo1 = scaffold.buildTodoHandoff('build a cat game', manifest, 1);
  assert.match(todo1, /## Goal/, 'todo has a goal');
  assert.match(todo1, /- `PROMPT.md`/, 'todo lists created files');
  assert.ok(!todo1.includes('M2'), 'depth 1 has no implementation milestone');
  const todo3 = scaffold.buildTodoHandoff('build a cat game', manifest, 3);
  assert.match(todo3, /M2/, 'depth 2+ milestone present');
  assert.match(todo3, /M3/, 'depth 3 milestone present');
  assert.match(todo3, /Definition of done/, 'checkable outcome');

  assert.throws(() => scaffold.planWrite(manifest, '', []), /Pick a destination/, 'no destination = no write');
  assert.throws(() => scaffold.planWrite(manifest, '/tmp/x', ['README.md']), /already contains/, 'no silent overwrite');
  const plan = scaffold.planWrite(manifest, '/tmp/x', ['README.md'], true);
  assert.match(plan.preview, /About to create 3 files/, 'preview states the count');
  assert.match(plan.preview, /overwriting 1/, 'preview states collisions');
  assert.strictEqual(plan.files.length, 3, 'plan carries the files');

  assert.strictEqual(scaffold.crc32(new TextEncoder().encode('123456789')), 0xcbf43926, 'CRC-32 matches the standard vector');
  const zip = scaffold.toZip(manifest);
  assert.strictEqual(new DataView(zip.buffer).getUint32(0, true), 0x04034b50, 'local header signature');
  assert.ok(zip.length > 3 * 30, 'ZIP contains local headers');
  const tail = new DataView(zip.buffer, zip.length - 22);
  assert.strictEqual(tail.getUint32(0, true), 0x06054b50, 'end-of-central-directory signature');
  assert.strictEqual(tail.getUint16(8, true), 3, 'three entries in the central directory');
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const zipPath = path.join(os.tmpdir(), 'gv-scaffold-test.zip');
  fs.writeFileSync(zipPath, zip);
  console.log('ZIP_FIXTURE=' + zipPath);

  console.log('scaffold.test.js: PASSED');
})().catch((e) => { console.error(e); process.exitCode = 1; });

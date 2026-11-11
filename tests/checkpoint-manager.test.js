// Unit tests for src/main/checkpoint-manager.js — file-copy fallback (no git).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const CheckpointManager = require('../src/main/checkpoint-manager.js');

async function tmp() { return fs.mkdtemp(path.join(os.tmpdir(), 'gv-cp-')); }

test('non-git project uses copy fallback, restores and removes', async () => {
  const dir = await tmp();
  const cm = new CheckpointManager();
  assert.strictEqual(cm.isGit(dir), false);

  await fs.writeFile(path.join(dir, 'a.txt'), 'one');
  const cp = await cm.create(dir, 'v1');
  assert.strictEqual(cp.kind, 'copy');
  assert.ok(cp.id);

  let list = await cm.list(dir);
  assert.strictEqual(list.length, 1);

  // Mutate, then restore the checkpoint.
  await fs.writeFile(path.join(dir, 'a.txt'), 'two');
  assert.strictEqual(await fs.readFile(path.join(dir, 'a.txt'), 'utf8'), 'two');
  await cm.restore(dir, cp.id);
  assert.strictEqual(await fs.readFile(path.join(dir, 'a.txt'), 'utf8'), 'one');

  await cm.remove(dir, cp.id);
  list = await cm.list(dir);
  assert.strictEqual(list.length, 0);
});

// Execution-gate tests: the validation stage, completion policy, rollback
// policy, round clamping and preview runtime health. All mocked — no real
// providers, no Electron.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const AgentManager = require('../src/main/agents/agent-manager.js');
const { clampRounds } = require('../src/main/agents/agent-manager.js');
const { waitForPreview } = require('../src/main/lib/validate-project.js');
const ProjectManager = require('../src/main/project-manager.js');
const { commitFiles } = require('../src/main/lib/commit-files.js');
const CheckpointManager = require('../src/main/checkpoint-manager.js');

async function tmp() { return fs.mkdtemp(path.join(os.tmpdir(), 'gv-gate-')); }

function providersWith(reviewText) {
  return {
    getProvider() {
      return {
        getModels: async () => [{ id: 'm1' }],
        chat: async ({ system }) => ({ text: /Creative Director/.test(system || '') ? 'BRIEF: tiny html game' : reviewText }),
      };
    },
  };
}

function devAgent(fn) {
  return { id: 'codex', runTask: fn };
}

function makeAm({ dir, pm, agents, reviewText = 'VERDICT: SHIP' }) {
  return new AgentManager({
    providers: providersWith(reviewText),
    agents,
    projectManager: pm,
    hooks: { loadPreview: () => {} },
  });
}

test('clampRounds', () => {
  for (const [input, want] of [[100, 5], [0, 3], [-2, 3], [NaN, 3], [undefined, 3], ['2', 2], [2.9, 2], [null, 3]]) {
    assert.equal(clampRounds(input), want, `clampRounds(${input}) should be ${want}`);
  }
});

test('validation failure never yields completed:true — even when the Critic says SHIP', async () => {
  const dir = await tmp();
  const pm = new ProjectManager();
  await pm.openProject(dir);
  // Developer writes an index.html that references a missing file => validation fails.
  const am = makeAm({
    dir, pm, reviewText: 'VERDICT: SHIP',
    agents: {
      codex: devAgent(async ({ projectPath }) => {
        await fs.writeFile(path.join(projectPath, 'index.html'), '<script src="missing.js"></script>');
        return { exitCode: 0 };
      }),
    },
  });
  const res = await am.createGame({
    idea: 'x', projectPath: dir,
    roles: { developer: { agent: 'codex' } },
    maxRounds: 2,
    signal: new AbortController().signal,
    onEvent: () => {},
  });
  assert.equal(res.completed, false, 'validation failure must not complete even with a SHIP verdict');
  assert.ok(res.validation && res.validation.ok === false);
});

test('developer crash restores the last known-good checkpoint and rethrows', async () => {
  const dir = await tmp();
  const pm = new ProjectManager();
  await pm.openProject(dir);
  await fs.writeFile(path.join(dir, 'index.html'), 'original');
  const am = makeAm({
    dir, pm,
    agents: {
      codex: devAgent(async () => { throw new Error('agent exploded'); }),
    },
  });
  await assert.rejects(() => am.createGame({
    idea: 'x', projectPath: dir,
    roles: { developer: { agent: 'codex' } },
    signal: new AbortController().signal,
    onEvent: () => {},
  }), /agent exploded/);
  assert.equal(await fs.readFile(path.join(dir, 'index.html'), 'utf8'), 'original', 'baseline restored after crash');
});

test('final-round failure restores the last known-good state and reports completed:false', async () => {
  const dir = await tmp();
  const pm = new ProjectManager();
  await pm.openProject(dir);
  // Round 1: valid build + SHIP would pass; make the Critic find a HIGH so we
  // go to round 2, where the developer breaks the build (validation fails).
  let round = 0;
  const am = new AgentManager({
    providers: {
      getProvider() {
        return {
          getModels: async () => [{ id: 'm1' }],
          chat: async ({ system }) => ({ text: /Creative Director/.test(system || '') ? 'BRIEF: x' : '[HIGH] bad\nVERDICT: NEEDS-WORK' }),
        };
      },
    },
    agents: {
      codex: devAgent(async ({ projectPath }) => {
        round++;
        if (round === 1) {
          await fs.writeFile(path.join(projectPath, 'index.html'), '<h1>good</h1>');
          await fs.writeFile(path.join(projectPath, 'game.js'), 'let a=1;');
        } else {
          // Break the build: missing referenced file.
          await fs.writeFile(path.join(projectPath, 'index.html'), '<script src="nope.js"></script>');
        }
        return { exitCode: 0 };
      }),
    },
    projectManager: pm,
    hooks: { loadPreview: () => {} },
  });
  const res = await am.createGame({
    idea: 'x', projectPath: dir,
    roles: { developer: { agent: 'codex' } },
    maxRounds: 2,
    signal: new AbortController().signal,
    onEvent: () => {},
  });
  assert.equal(res.completed, false);
  // Round-2 breakage rolled back to the round-1 known-good state.
  assert.equal(await fs.readFile(path.join(dir, 'index.html'), 'utf8'), '<h1>good</h1>');
});

test('mid-write commit failure restores the project', async () => {
  const dir = await tmp();
  await fs.writeFile(path.join(dir, 'a.txt'), 'old');
  let restored = 0;
  const restore = async () => { restored++; await fs.writeFile(path.join(dir, 'a.txt'), 'old'); };
  // 'sub' exists as a FILE, so creating sub/x.js's directory fails mid-copy —
  // after ok1.js has already been written. (Path-safety violations are caught
  // in the preflight, before anything is written, and correctly do NOT call restore.)
  await fs.writeFile(path.join(dir, 'sub'), 'not a directory');
  const files = [
    { path: 'ok1.js', content: 'let x=1;' },
    { path: 'sub/x.js', content: 'let y=2;' },
  ];
  await assert.rejects(() => commitFiles(dir, files, restore));
  assert.equal(restored, 1, 'restore callback invoked');
  assert.equal(await fs.readFile(path.join(dir, 'a.txt'), 'utf8'), 'old');
  // Path-safety violation: rejected in preflight, nothing written, no restore.
  let restored2 = 0;
  await assert.rejects(() => commitFiles(dir, [{ path: '.git/config', content: 'evil' }], async () => { restored2++; }), /reserved folder|Unsafe path/);
  assert.equal(restored2, 0, 'preflight failures must not restore');
});

test('checkpoint restore preserves uncommitted edits state and removes new files', async () => {
  const dir = await tmp();
  const cm = new CheckpointManager({ snapshotRoot: path.join(os.tmpdir(), 'gv-snap-' + Date.now()) });
  await fs.writeFile(path.join(dir, 'game.js'), 'let a=1;');
  const cp = await cm.create(dir, 'v1');
  // Simulate AI damage: modify, add a new file, delete one.
  await fs.writeFile(path.join(dir, 'game.js'), 'DAMAGED');
  await fs.writeFile(path.join(dir, 'new-ai-file.js'), 'junk');
  await fs.rm(path.join(dir, 'game.js'), { force: true });
  await fs.writeFile(path.join(dir, 'game.js'), 'DAMAGED');
  await cm.restore(dir, cp.id);
  assert.equal(await fs.readFile(path.join(dir, 'game.js'), 'utf8'), 'let a=1;');
  await assert.rejects(() => fs.access(path.join(dir, 'new-ai-file.js')));
  const list = await cm.list(dir);
  assert.equal(list.length, 1);
});

test('runtime check: error-level console message fails, favicon 404 does not, no-ready times out', async () => {
  function fakePreview(script) {
    return {
      on(type, cb) { this._cbs = this._cbs || {}; (this._cbs[type] = this._cbs[type] || []).push(cb); },
      off(type, cb) { if (this._cbs && this._cbs[type]) this._cbs[type] = this._cbs[type].filter((f) => f !== cb); },
      fire(type, ev) { (this._cbs[type] || []).forEach((cb) => cb(ev)); },
    };
  }

  // Error-level console after ready -> captured.
  {
    const p = fakePreview();
    setTimeout(() => { p.fire('preview:ready'); p.fire('preview:console', { level: 3, message: 'Uncaught TypeError: x is not a function' }); }, 5);
    const r = await waitForPreview(p, { timeoutMs: 1000 });
    assert.equal(r.ready, true);
    assert.equal(r.errors.length, 1);
  }
  // Favicon 404 (noise) -> not captured.
  {
    const p = fakePreview();
    setTimeout(() => { p.fire('preview:ready'); p.fire('preview:console', { level: 3, message: 'Failed to load resource: 404 favicon.ico' }); }, 5);
    const r = await waitForPreview(p, { timeoutMs: 1000 });
    assert.equal(r.errors.length, 0, 'favicon 404 is noise');
  }
  // Preview that never fires ready -> times out, does not hang.
  {
    const p = fakePreview();
    const t0 = Date.now();
    const r = await waitForPreview(p, { timeoutMs: 120 });
    assert.equal(r.ready, false);
    assert.ok(Date.now() - t0 < 2000, 'resolved via timeout');
  }
  // Load failure -> reported.
  {
    const p = fakePreview();
    setTimeout(() => p.fire('preview:fail', { message: 'ERR_CONNECTION_REFUSED' }), 5);
    const r = await waitForPreview(p, { timeoutMs: 1000 });
    assert.ok(r.errors.some((e) => /ERR_CONNECTION_REFUSED/.test(e)));
  }
});

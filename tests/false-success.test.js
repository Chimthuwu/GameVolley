// Regression tests for the false-success fixes (spec P0 1.5):
//  - a non-zero CLI exit is a FAILED task (runTask throws), never a completed build;
//  - cancellation is reported distinctly (err.cancelled);
//  - a missing/malformed Critic verdict NEVER completes the loop as a pass.
// Uses a REAL child process (node -e ...) — no mocks for the process layer.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const CodingAgentBase = require('../src/main/agents/coding-agent-base.js');
const AgentManager = require('../src/main/agents/agent-manager.js');
const ProjectManager = require('../src/main/project-manager.js');

class FakeNodeAgent extends CodingAgentBase {
  constructor() { super({ id: 'fakenode', name: 'Fake Node', binaries: ['node'] }); }
  async detect() { return { available: true, binary: process.execPath }; }
  buildArgs({ prompt }) { return ['-e', prompt]; }
}

test('runTask throws on a non-zero exit instead of returning it as a result', async () => {
  const agent = new FakeNodeAgent();
  await assert.rejects(
    () => agent.runTask({ projectPath: os.tmpdir(), prompt: 'process.exit(3)' }),
    (e) => /exit code 3/.test(e.message) && e.exitCode === 3,
  );
});

test('runTask marks cancellation distinctly (err.cancelled), not failure', async () => {
  const agent = new FakeNodeAgent();
  const ctl = new AbortController();
  const p = agent.runTask({ projectPath: os.tmpdir(), prompt: 'setInterval(()=>{},1000)', signal: ctl.signal })
    .then(() => { throw new Error('should have thrown'); })
    .catch((e) => e);
  setTimeout(() => ctl.abort(), 150);
  const err = await p;
  assert.ok(err.cancelled === true, 'err.cancelled must be set');
});

test('malformed Critic output (no verdict, no findings) does NOT complete as a pass', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gv-false-'));
  const events = [];
  let devRuns = 0;
  const am = new AgentManager({
    providers: {
      getProvider: (id) => ({
        id,
        getModels: async () => [{ id: 'm1' }],
        chat: async ({ system, signal }) => {
          if (signal && signal.aborted) throw new Error('aborted');
          return { text: /Creative Director/.test(system || '') ? 'BRIEF: tiny game' : 'Looks great to me! Nice work.' };
        },
      }),
    },
    agents: {
      codex: { id: 'codex', async runTask({ projectPath }) { devRuns++; await fs.writeFile(path.join(projectPath, 'index.html'), '<h1>x</h1>'); return { exitCode: 0, output: 'ok' }; } },
    },
    projectManager: (() => { const pm = new ProjectManager(); return pm; })(),
  });
  const res = await am.createGame({
    idea: 'tiny game', projectPath: dir, maxRounds: 2,
    roles: { creativeDirector: { provider: 'p' }, critic: { provider: 'p' }, developer: { agent: 'codex' } },
    onEvent: (e) => events.push(e),
  });
  assert.equal(res.completed, false, 'no verdict -> not a pass');
  assert.equal(devRuns, 2, 'loop kept correcting for all rounds instead of passing early');
  const done = events.find((e) => e.type === 'game:done');
  assert.equal(done.result.verdict, 'NONE');
  assert.equal(done.result.completed, false);
});

test('a clean SHIP verdict with no HIGH/MED findings still completes as a pass', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gv-pass-'));
  const events = [];
  const am = new AgentManager({
    providers: {
      getProvider: (id) => ({
        id,
        getModels: async () => [{ id: 'm1' }],
        chat: async ({ system, signal }) => {
          if (signal && signal.aborted) throw new Error('aborted');
          return { text: /Creative Director/.test(system || '') ? 'BRIEF: tiny game' : 'All good.\nVERDICT: SHIP' };
        },
      }),
    },
    agents: { codex: { id: 'codex', async runTask({ projectPath }) { await fs.writeFile(path.join(projectPath, 'index.html'), '<h1>x</h1>'); return { exitCode: 0, output: 'ok' }; } } },
    projectManager: new ProjectManager(),
  });
  const res = await am.createGame({
    idea: 'tiny game', projectPath: dir, maxRounds: 3,
    roles: { creativeDirector: { provider: 'p' }, critic: { provider: 'p' }, developer: { agent: 'codex' } },
    onEvent: (e) => events.push(e),
  });
  assert.equal(res.completed, true);
});

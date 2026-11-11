// Integration test for src/main/agents/agent-manager.js — verifies the
// Creative Director -> Developer -> Critic flow, bounded correction rounds, and
// that the developer actually edits the project directory. Uses mock providers and
// mock coding agents (no real credentials or CLIs).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const AgentManager = require('../src/main/agents/agent-manager.js');
const ProjectManager = require('../src/main/project-manager.js');

async function tmp() { return fs.mkdtemp(path.join(os.tmpdir(), 'gv-am-')); }

function fakeProviders(reviewText) {
  return {
    getProvider(id) {
      return {
        id,
        getModels: async () => [{ id: 'm1' }],
        chat: async ({ system, onDelta, signal }) => {
          if (signal && signal.aborted) throw new Error('aborted');
          const text = /Creative Director/.test(system || '')
            ? 'BRIEF: build a tiny HTML game with index.html + game.js'
            : (reviewText || 'VERDICT: SHIP');
          onDelta && onDelta(text);
          return { text };
        },
      };
    },
  };
}

function fakeAgents(counter) {
  return {
    codex: {
      id: 'codex',
      async runTask({ projectPath, onEvent, signal }) {
        if (signal && signal.aborted) throw new Error('aborted');
        counter.n++;
        await fs.writeFile(path.join(projectPath, 'index.html'), '<h1>game</h1>');
        await fs.writeFile(path.join(projectPath, 'game.js'), '// built by agent');
        return { exitCode: 0, output: 'ok' };
      },
    },
    claude: { id: 'claude', async runTask() { return { exitCode: 0 }; } },
    gemini: { id: 'gemini', async runTask() { return { exitCode: 0 }; } },
  };
}

test('createGame runs director first, then developer edits files, then critic', async () => {
  const dir = await tmp();
  const counter = { n: 0 };
  const pm = new ProjectManager();
  await pm.openProject(dir);
  const events = [];
  const am = new AgentManager({
    providers: fakeProviders(),
    agents: fakeAgents(counter),
    projectManager: pm,
    hooks: { loadPreview: () => {} },
  });

  const res = await am.createGame({
    idea: 'frog runs a pizza restaurant',
    projectPath: dir,
    roles: { creativeDirector: { provider: 'openrouter' }, critic: { provider: 'openrouter' }, developer: { agent: 'codex' } },
    signal: new AbortController().signal,
    onEvent: (ev) => events.push(ev),
  });

  const types = events.map((e) => e.type);
  assert.ok(types.includes('agent:status'), 'emits status events');
  assert.ok(types.includes('project:changed'), 'developer emitted file changes');
  const directorDone = events.findIndex((e) => e.role === 'director' && e.status === 'done');
  const firstChange = events.findIndex((e) => e.type === 'project:changed');
  assert.ok(directorDone >= 0 && directorDone < firstChange, 'director completes before developer edits');
  assert.strictEqual(counter.n, 1, 'developer ran exactly once when review ships');
  assert.ok(res.entry, 'returns an entry point');
});

test('correction rounds are bounded by maxRounds and developer re-runs', async () => {
  const dir = await tmp();
  const counter = { n: 0 };
  const pm = new ProjectManager();
  await pm.openProject(dir);
  // Critic always reports a HIGH severity issue -> should loop until maxRounds.
  const am = new AgentManager({
    providers: fakeProviders('[HIGH] the game is broken\nVERDICT: NEEDS-WORK'),
    agents: fakeAgents(counter),
    projectManager: pm,
    hooks: { loadPreview: () => {} },
  });
  const res = await am.createGame({
    idea: 'broken game',
    projectPath: dir,
    roles: { developer: { agent: 'codex' } },
    maxRounds: 2,
    signal: new AbortController().signal,
    onEvent: () => {},
  });
  assert.strictEqual(res.rounds, 2, 'stops at maxRounds');
  assert.strictEqual(counter.n, 2, 'developer ran once per round');
});

test('improveGame follows the user instruction and skips the director', async () => {
  const dir = await tmp();
  const counter = { n: 0 };
  const pm = new ProjectManager();
  await pm.openProject(dir);
  await pm.writeFile('index.html', '<h1>small</h1>');
  let directorCalled = false;
  const providers = {
    getProvider(id) {
      return { id, getModels: async () => [{ id: 'm1' }], chat: async ({ system }) => { if (/Creative Director/.test(system || '')) directorCalled = true; return { text: 'VERDICT: SHIP' }; } };
    },
  };
  const am = new AgentManager({ providers, agents: fakeAgents(counter), projectManager: pm, hooks: { loadPreview: () => {} } });
  await am.improveGame({
    idea: 'make the restaurant twice as big',
    projectPath: dir,
    roles: { developer: { agent: 'codex' } },
    signal: new AbortController().signal,
    onEvent: () => {},
  });
  assert.strictEqual(directorCalled, false, 'follow-up must not override user instruction via the director');
  assert.strictEqual(counter.n, 1, 'developer ran for the improvement');
});

test('cancellation aborts the workflow', async () => {
  const dir = await tmp();
  const pm = new ProjectManager();
  await pm.openProject(dir);
  const ac = new AbortController();
  ac.abort();
  const am = new AgentManager({
    providers: fakeProviders(),
    agents: fakeAgents({ n: 0 }),
    projectManager: pm,
    hooks: { loadPreview: () => {} },
  });
  await assert.rejects(() => am.createGame({
    idea: 'x', projectPath: dir, roles: { developer: { agent: 'codex' } },
    signal: ac.signal, onEvent: () => {},
  }), 'aborted run should reject/throw');
});

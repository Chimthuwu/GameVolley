// Auto model pick (Q9): Director/Critic with no explicit model prefer a CONNECTED
// CLI provider (subscription-billed) over a free API model; paid API keys are
// never auto-selected; explicit models always win.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const AgentManager = require('../src/main/agents/agent-manager.js');

function makeProviders({ statuses, dirRef }) {
  const chats = [];
  const mk = (id, authType, models) => ({
    id, authType, paid: authType !== 'cli',
    getModels: async () => models,
    chat: async ({ system, model }) => {
      if (/Creative Director/.test(system || '')) { chats.push({ role: 'director', provider: id, model }); return { text: 'BRIEF: x. FILE PLAN: index.html' }; }
      if (!/QA Critic/.test(system || '')) return { text: 'BRIEF: x' };
      chats.push({ role: 'critic', provider: id, model });
      return { text: 'Looks great.\nVERDICT: SHIP' };
    },
  });
  return {
    chats,
    getProvider(id) { return mk(id, id === 'anthropic' ? 'cli' : 'api_key', id === 'anthropic' ? [{ id: 'sonnet', name: 'Sonnet', isFree: false }] : [{ id: 'free/a', isFree: true }, { id: 'free/b', isFree: true }]); },
    getProviderStatuses: statuses ? async () => statuses : undefined,
  };
}

async function run(providers) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gv-automodel-'));
  const pm = new (require('../src/main/project-manager.js'))();
  await pm.openProject(dir);
  const am = new AgentManager({
    providers,
    agents: { codex: { id: 'codex', runTask: async ({ projectPath }) => { await fs.writeFile(path.join(projectPath, 'index.html'), '<h1>x</h1>'); return { exitCode: 0 }; } } },
    projectManager: pm,
    hooks: { loadPreview: () => {} },
  });
  await am.createGame({
    idea: 'x', projectPath: dir,
    roles: { creativeDirector: { provider: 'openrouter' }, critic: { provider: 'openrouter' }, developer: { agent: 'codex' } },
    signal: new AbortController().signal,
    onEvent: () => {},
  });
  return providers.chats;
}

test('connected CLI provider wins the Director auto-pick', async () => {
  const chats = await run(makeProviders({ statuses: { openrouter: { connected: true }, anthropic: { connected: true } } }));
  const director = chats.find((c) => c.role === 'director');
  assert.equal(director.provider, 'anthropic', 'Director uses the connected CLI provider');
  assert.equal(director.model, 'sonnet', 'Director uses the CLI provider model');
});

test('no connected CLI provider: prefer-free behaviour is unchanged', async () => {
  const chats = await run(makeProviders({ statuses: { openrouter: { connected: true }, anthropic: { connected: false } } }));
  const director = chats.find((c) => c.role === 'director');
  assert.equal(director.provider, 'openrouter');
  assert.equal(director.model, 'free/a', 'still prefers the free model');
});

test('explicit models always win over the CLI auto-pick', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gv-automodel2-'));
  const chats = [];
  const statuses = { openrouter: { connected: true }, anthropic: { connected: true } };
  const providers = {
    getProvider(id) {
      return {
        id, authType: id === 'anthropic' ? 'cli' : 'api_key',
        getModels: async () => (id === 'anthropic' ? [{ id: 'sonnet', isFree: false }] : [{ id: 'free/a', isFree: true }]),
        chat: async ({ system, model }) => {
          if (/Creative Director/.test(system || '')) { chats.push({ role: 'director', provider: id, model }); return { text: 'BRIEF: x. FILE PLAN: index.html' }; }
          if (!/QA Critic/.test(system || '')) return { text: 'BRIEF: x' };
          return { text: 'Looks great.\nVERDICT: SHIP' };
        },
      };
    },
    getProviderStatuses: async () => statuses,
  };
  const pm = new (require('../src/main/project-manager.js'))();
  await pm.openProject(dir);
  const am = new AgentManager({
    providers,
    agents: { codex: { id: 'codex', runTask: async ({ projectPath }) => { await fs.writeFile(path.join(projectPath, 'index.html'), '<h1>x</h1>'); return { exitCode: 0 }; } } },
    projectManager: pm,
    hooks: { loadPreview: () => {} },
  });
  await am.createGame({
    idea: 'x', projectPath: dir,
    roles: { creativeDirector: { provider: 'openrouter', model: 'paid/flagship' }, critic: { provider: 'openrouter' }, developer: { agent: 'codex' } },
    signal: new AbortController().signal,
    onEvent: () => {},
  });
  const director = chats.find((c) => c.role === 'director');
  assert.equal(director.provider, 'openrouter');
  assert.equal(director.model, 'paid/flagship', 'the explicit model wins');
});

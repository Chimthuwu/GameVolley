// Routing test: AgentManager must send "prov:<id>" developers to the ProviderDevAgent
// (no CLI required) and keep plain ids resolving to CLI agents. Mocks only.
const { test } = require('node:test');
const assert = require('node:assert');
const AgentManager = require('../src/main/agents/agent-manager.js');

test('prov:<providerId> developer routes to ProviderDevAgent without a CLI', () => {
  const am = new AgentManager({
    providers: { getProvider: (id) => ({ id, chat: async () => ({ text: '' }) }) },
    agents: { claude: { id: 'claude' } },
    projectManager: {},
  });
  const agent = am._developerAgent('prov:openrouter');
  assert.equal(agent.id, 'prov:openrouter');
  assert.equal(agent.constructor.name, 'ProviderDevAgent');
  // Cached instance on the second call.
  assert.equal(am._developerAgent('prov:openrouter'), agent);
});

test('plain ids still resolve to CLI agents; unknown ids still error honestly', () => {
  const am = new AgentManager({
    providers: { getProvider: (id) => ({ id }) },
    agents: { claude: { id: 'claude' } },
    projectManager: {},
  });
  assert.equal(am._developerAgent('claude').id, 'claude');
  assert.throws(() => am._developerAgent('codex'), /No coding agent "codex"/);
});

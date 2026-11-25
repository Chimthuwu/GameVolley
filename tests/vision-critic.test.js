// Vision Critic (Q6): with a vision-capable critic model the review call carries
// the playtest screenshot as an image_url part; without vision it stays text-only.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const AgentManager = require('../src/main/agents/agent-manager.js');

const DATA_URL = 'data:image/png;base64,QUJD';

function makePreview() {
  return {
    reload() {},
    // The validation gate waits for preview:ready; fire it right away.
    on(type, cb) { if (type === 'preview:ready') setTimeout(() => cb({ type: 'preview:ready' }), 0); },
    off() {},
    async playtestProbe() { return { ran: true, canvas: true, changed: true, rafTicks: 20, empty: false, uniform: false }; },
    async capture() { return { toDataURL: () => DATA_URL }; },
  };
}

function makeAm({ supportsVision, captured }) {
  const pm = new (require('../src/main/project-manager.js'))();
  const dir = null; // filled per-test
  return { pm, dir, build: (d) => new AgentManager({
    providers: {
      getProvider() {
        return {
          getModels: async () => [{ id: 'critic-model', supportsVision }],
          getCapabilities: () => ({ supportsVision }),
          chat: async ({ system, messages }) => {
            if (/Creative Director/.test(system || '')) return { text: 'BRIEF: x' };
            if (!/QA Critic/.test(system || '')) return { text: 'BRIEF: x' }; // developer-role chats (if any)
            captured.push(messages);
            return { text: 'Looks good.\nVERDICT: SHIP' };
          },
        };
      },
    },
    agents: {
      codex: {
        id: 'codex',
        runTask: async ({ projectPath }) => {
          await fs.writeFile(path.join(projectPath, 'index.html'), '<h1>ok</h1>');
          return { exitCode: 0 };
        },
      },
    },
    projectManager: pm,
    hooks: {
      loadPreview: () => {},
      getPreview: () => makePreview(),
    },
  }) };
}

async function runScenario(supportsVision) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gv-vision-'));
  const captured = [];
  const { pm, build } = makeAm({ supportsVision, captured });
  await pm.openProject(dir);
  const am = build();
  const res = await am.createGame({
    idea: 'x', projectPath: dir,
    roles: { developer: { agent: 'codex' }, critic: { provider: 'openrouter' } },
    signal: new AbortController().signal,
    onEvent: () => {},
  });
  assert.equal(res.completed, true, 'the fake pipeline completes');
  assert.equal(captured.length, 1, 'the critic was called once');
  return captured[0][0].content;
}

test('vision critic attaches the screenshot when the model supports vision', async () => {
  const content = await runScenario(true);
  assert.ok(Array.isArray(content), 'content is a multipart array');
  assert.ok(content.some((c) => c.type === 'image_url' && c.image_url.url === DATA_URL), 'image_url part present');
  assert.ok(content.some((c) => c.type === 'text' && /PROJECT CODE/.test(c.text)), 'text part still carries the code context');
});

test('non-vision critic stays text-only', async () => {
  const content = await runScenario(false);
  assert.equal(typeof content, 'string', 'content is a plain string');
  assert.ok(!JSON.stringify(content).includes('image_url'), 'no image part');
});

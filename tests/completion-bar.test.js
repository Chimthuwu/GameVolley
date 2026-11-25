// Completion bar (Q8): a SHIP/CLOSE verdict ships with no HIGH and up to 2 MED
// findings (configurable via maxMed); 3 MEDs (or any HIGH) keep the loop going.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const AgentManager = require('../src/main/agents/agent-manager.js');

async function runWith(reviewText, opts = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gv-bar-'));
  const captured = [];
  const pm = new (require('../src/main/project-manager.js'))();
  await pm.openProject(dir);
  const am = new AgentManager({
    providers: {
      getProvider() {
        return {
          getModels: async () => [{ id: 'm1' }],
          chat: async ({ system }) => {
            if (/Creative Director/.test(system || '')) return { text: 'BRIEF: x' };
            if (!/QA Critic/.test(system || '')) return { text: 'BRIEF: x' };
            captured.push(system);
            return { text: reviewText };
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
    hooks: { loadPreview: () => {} },
  });
  return am.createGame({
    idea: 'x', projectPath: dir,
    roles: { developer: { agent: 'codex' }, critic: { provider: 'openrouter' } },
    signal: new AbortController().signal,
    onEvent: () => {},
    ...opts,
  });
}

test('SHIP with 2 MED findings completes (default maxMed = 2)', async () => {
  const res = await runWith('[MED] pacing drags\n[MED] colors clash\nVERDICT: SHIP');
  assert.equal(res.completed, true, '2 MED + no HIGH ships');
});

test('SHIP with 3 MED findings does NOT complete by default', async () => {
  const res = await runWith('[MED] a\n[MED] b\n[MED] c\nVERDICT: SHIP');
  assert.equal(res.completed, false, '3 MED exceeds the default bar');
});

test('maxMed is configurable: maxMed 0 restores the old zero-MED bar', async () => {
  const res = await runWith('[MED] one\nVERDICT: SHIP', { maxMed: 0 });
  assert.equal(res.completed, false, '1 MED does not ship when maxMed = 0');
});

test('HIGH findings never ship', async () => {
  const res = await runWith('[HIGH] crash on start\n[MED] x\nVERDICT: SHIP');
  assert.equal(res.completed, false, 'a HIGH finding blocks');
});

// Unit tests for the provider-backed Developer agent (mock provider; real tmp fs).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { ProviderDevAgent, parseFiles, DEV_SYSTEM, GAME_GUIDELINES } = require('../src/main/agents/provider-dev-agent.js');

async function tmp() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gv-prov-'));
  return { dir, active: { name: 'p', path: dir } };
}

const SAMPLE = '=== FILE: index.html ===\n<html>hi</html>\n=== END FILE ===\n' +
  '=== FILE: js/game.js ===\r\nconsole.log(1);\r\n=== END FILE ===';

test('parseFiles extracts path/content pairs and tolerates CRLF', () => {
  const r = parseFiles(SAMPLE);
  assert.equal(r.files.length, 2);
  assert.equal(r.files[0].path, 'index.html');
  assert.equal(r.files[0].content, '<html>hi</html>');
  assert.equal(r.files[1].path, 'js/game.js');
  assert.equal(r.files[1].content, 'console.log(1);');
});

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

// Runs a slow stand-in provider and returns what reached the live log.
async function logOf(chat, waitNoteMs = 60) {
  const { active } = await tmp();
  const agent = new ProviderDevAgent({ provider: { chat }, projectManager: { active }, providerId: 'opencode-go' });
  agent.waitNoteMs = waitNoteMs;
  let log = '';
  await agent.runTask({ prompt: 'build', onEvent: (e) => { if (e.type === 'output') log += e.text; } });
  return { log, later: async () => { const before = log; await pause(200); return log === before; } };
}

test('a quiet wait says so, and the notes stop with the call', async () => {
  const run = await logOf(async () => { await pause(220); return { text: SAMPLE }; });
  assert.match(run.log, /no reply text yet/);
  assert.ok(await run.later(), 'nothing more is posted after the reply');
});

test('a thinking model is reported as thinking, with how much so far', async () => {
  const run = await logOf(async ({ onActivity }) => {
    for (let i = 0; i < 12; i++) { await pause(20); onActivity({ thinking: 100 }); }
    return { text: SAMPLE };
  });
  assert.match(run.log, /the model is thinking \([\d,]+ characters of reasoning so far\)/);
});

test('data without text is reported as an active connection, not as thinking', async () => {
  const run = await logOf(async ({ onActivity }) => {
    for (let i = 0; i < 12; i++) { await pause(20); onActivity({ thinking: 0 }); }
    return { text: SAMPLE };
  });
  assert.match(run.log, /connection is active, but there is no reply text yet/);
  assert.doesNotMatch(run.log, /thinking/);
});

test('text that keeps arriving needs no waiting notes', async () => {
  // Text arrives every 20ms for longer than the 400ms quiet limit. The wide gap
  // between the two keeps a busy machine from looking quiet.
  const run = await logOf(async ({ onDelta }) => {
    for (let i = 0; i < 40; i++) { await pause(20); onDelta('x'); }
    return { text: SAMPLE };
  }, 400);
  assert.doesNotMatch(run.log, /⏳/);
});

test('runTask writes parsed files into the real project', async () => {
  const outputs = [];
  const { dir, active } = await tmp();
  const agent = new ProviderDevAgent({
    provider: { async chat() { return { text: SAMPLE }; } },
    projectManager: { active },
    providerId: 'openrouter',
  });
  const r = await agent.runTask({ prompt: 'build', onEvent: (e) => outputs.push(e) });
  assert.equal(r.ok, true);
  assert.deepEqual(r.files, ['index.html', 'js/game.js']);
  assert.equal(await fs.readFile(path.join(dir, 'index.html'), 'utf8'), '<html>hi</html>');
  assert.equal(await fs.readFile(path.join(dir, 'js/game.js'), 'utf8'), 'console.log(1);');
  assert.ok(outputs.some((e) => e.type === 'output' && e.text.includes('wrote index.html')));
});

test('runTask throws honestly when the model returns no file blocks after recovery', async () => {
  const { active } = await tmp();
  const agent = new ProviderDevAgent({
    provider: { async chat() { return { text: 'Here is your game! (no blocks)' }; } },
    projectManager: { active },
    providerId: 'openrouter',
  });
  await assert.rejects(() => agent.runTask({ prompt: 'x' }), /no usable file blocks after recovery/);
});

test('prose-only response triggers ONE recovery; raw output saved; valid reformat is used', async () => {
  const { dir, active } = await tmp();
  let calls = 0;
  const agent = new ProviderDevAgent({
    provider: {
      async chat({ system }) {
        calls++;
        if (calls === 1) return { text: 'Sure! Here is your game, it is a nice game with lots of prose.' };
        assert.match(system, /=== FILE: relative\/path.ext ===/);
        return { text: SAMPLE };
      },
    },
    projectManager: { active },
    providerId: 'openrouter',
  });
  const r = await agent.runTask({ prompt: 'x' });
  assert.equal(calls, 2);
  assert.deepEqual(r.files, ['index.html', 'js/game.js']);
  const diags = await fs.readdir(path.join(dir, '.gamevolley', 'diagnostics'));
  assert.ok(diags.some((f) => f.includes('raw-response')), 'raw response diagnostic saved');
});

test('runTask refuses path escape / absolute paths from the model', async () => {
  for (const bad of ['../evil.js', '/etc/passwd', 'C:\\windows\\x.js', '.git/config', 'node_modules/x.js', 'a/../../x.js']) {
    const { dir, active } = await tmp();
    const agent = new ProviderDevAgent({
      provider: { async chat() { return { text: `=== FILE: ${bad} ===\nx\n=== END FILE ===` }; } },
      projectManager: { active },
      providerId: 'openrouter',
    });
    await assert.rejects(() => agent.runTask({ prompt: 'x' }), /(Unsafe path|Path escapes project|reserved folder)/);
    const written = await fs.readdir(dir);
    assert.ok(!written.includes('evil.js'), `${bad} must not be written`);
  }
});

test('runTask honors an already-aborted signal before any provider call', async () => {
  const { active } = await tmp();
  let calls = 0;
  const controller = new AbortController();
  controller.abort();
  const agent = new ProviderDevAgent({
    provider: { async chat() { calls++; return { text: SAMPLE }; } },
    projectManager: { active },
    providerId: 'openrouter',
  });
  await assert.rejects(() => agent.runTask({ prompt: 'x', signal: controller.signal }), /aborted/);
  assert.equal(calls, 0, 'provider.chat never called after abort');
});

test('detect/getStatus report available without pretending authentication', async () => {
  const agent = new ProviderDevAgent({ provider: {}, projectManager: { active: null }, providerId: 'openai' });
  assert.deepEqual(await agent.detect(), { available: true, binary: null });
  const st = await agent.getStatus();
  assert.equal(st.available, true);
  assert.equal(st.authenticated, null);
});

test('runTask without an active project fails honestly', async () => {
  const agent = new ProviderDevAgent({ provider: {}, projectManager: { active: null }, providerId: 'openrouter' });
  await assert.rejects(() => agent.runTask({ prompt: 'x' }), /No active project/);
});

test('developer system prompt carries the game engine guidelines', () => {
  assert.match(DEV_SYSTEM + GAME_GUIDELINES, /GAME ENGINE GUIDELINES/);
});

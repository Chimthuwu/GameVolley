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

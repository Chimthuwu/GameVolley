// Unit tests for the provider-backed Developer agent (mocks only — no network, no fs).
const { test } = require('node:test');
const assert = require('node:assert');
const { ProviderDevAgent, parseFiles } = require('../src/main/agents/provider-dev-agent.js');

function makePM() {
  const files = {};
  return {
    files,
    async writeFile(p, c) { files[p] = c; return { ok: true }; },
  };
}

const SAMPLE = 'junk preamble\n' +
  '=== FILE: index.html ===\n<html>hi</html>\n=== END FILE ===\n' +
  '=== FILE: js/game.js ===\r\nconsole.log(1);\r\n=== END FILE ===\n' +
  'trailing junk';

test('parseFiles extracts path/content pairs and tolerates CRLF', () => {
  const files = parseFiles(SAMPLE);
  assert.equal(files.length, 2);
  assert.equal(files[0].path, 'index.html');
  assert.equal(files[0].content, '<html>hi</html>');
  assert.equal(files[1].path, 'js/game.js');
  assert.equal(files[1].content, 'console.log(1);');
});

test('runTask writes parsed files through ProjectManager', async () => {
  const outputs = [];
  const pm = makePM();
  const agent = new ProviderDevAgent({
    provider: { async chat() { return { text: SAMPLE }; } },
    projectManager: pm,
    providerId: 'openrouter',
  });
  const r = await agent.runTask({ prompt: 'build', onEvent: (e) => outputs.push(e) });
  assert.equal(r.ok, true);
  assert.deepEqual(r.files, ['index.html', 'js/game.js']);
  assert.equal(pm.files['index.html'], '<html>hi</html>');
  assert.ok(outputs.some((e) => e.type === 'output' && e.text.includes('wrote index.html')));
});

test('runTask throws honestly when the model returns no file blocks', async () => {
  const agent = new ProviderDevAgent({
    provider: { async chat() { return { text: 'Here is your game! (no blocks)' }; } },
    projectManager: makePM(),
    providerId: 'openrouter',
  });
  await assert.rejects(() => agent.runTask({ prompt: 'x' }), /no file blocks/);
});

test('runTask refuses path escape / absolute paths from the model', async () => {
  for (const bad of ['../evil.js', '/etc/passwd', 'C:\\windows\\x.js']) {
    const pm = makePM();
    const agent = new ProviderDevAgent({
      provider: { async chat() { return { text: `=== FILE: ${bad} ===\nx\n=== END FILE ===` }; } },
      projectManager: pm,
      providerId: 'openrouter',
    });
    await assert.rejects(() => agent.runTask({ prompt: 'x' }), /unsafe file path/);
    assert.deepEqual(Object.keys(pm.files), []);
  }
});

test('runTask honors an already-aborted signal before and between writes', async () => {
  const pm = makePM();
  let calls = 0;
  const controller = new AbortController();
  controller.abort();
  const agent = new ProviderDevAgent({
    provider: { async chat() { calls++; return { text: SAMPLE }; } },
    projectManager: pm,
    providerId: 'openrouter',
  });
  await assert.rejects(() => agent.runTask({ prompt: 'x', signal: controller.signal }), /aborted/);
  assert.equal(calls, 0, 'provider.chat never called after abort');
});

test('detect/getStatus report available without pretending authentication', async () => {
  const agent = new ProviderDevAgent({ provider: {}, projectManager: makePM(), providerId: 'openai' });
  assert.deepEqual(await agent.detect(), { available: true, binary: null });
  const st = await agent.getStatus();
  assert.equal(st.available, true);
  assert.equal(st.authenticated, null);
});

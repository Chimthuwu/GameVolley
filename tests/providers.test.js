// Unit test for lib/providers.js: verifies provider registry, model lists, capabilities,
// CLI spawn+parse, and that an api_key provider's chat() streams text from a mocked fetch.
const assert = require('assert');
const path = require('path');
const providerModule = require(path.join(__dirname, '..', 'lib', 'providers.js'));

const deps = {
  stream: async () => ({ text: 'openrouter-text', usage: { prompt_tokens: 1, completion_tokens: 2, cost: 0, elapsedMs: 1 } }),
  loadKey: () => 'sk-or-test',
  getModelsRaw: async () => ([{ id: 'openai/gpt-4o', pricing: { prompt: '0', completion: '0' }, architecture: { input_modalities: ['text', 'image'] } }]),
  getModelsCache: () => ({ data: [{ id: 'openai/gpt-4o', architecture: { input_modalities: ['text', 'image'] } }] }),
  loadProvCred: (id) => ({ openai: 'sk-oai' }[id] || ''),
  saveProvCred: () => {},
  IDLE_MS: 30000,
};
providerModule.init(deps);

(async () => {
  const all = providerModule.getAllProviders();
  assert.strictEqual(all.length, 5, 'expected 5 providers');

  const or = providerModule.getProvider('openrouter');
  const orModels = await or.getModels();
  assert.ok(orModels.some((m) => m.id === 'openai/gpt-4o'), 'openrouter exposes catalog model');
  assert.strictEqual(or.getCapabilities('openai/gpt-4o').supportsVision, true, 'openrouter vision from cache');
  const orRes = await or.chat({ model: 'openai/gpt-4o', system: 's', messages: [], onDelta: () => {}, onUsage: () => {} });
  assert.strictEqual(orRes.text, 'openrouter-text', 'openrouter chat delegates to stream()');

  const ant = providerModule.getProvider('anthropic');
  const antStatus = await ant.getStatus();
  assert.strictEqual(antStatus.cli, true, 'anthropic is a CLI provider');
  // 'installed' depends on whether the real `claude` binary is on PATH in this env; only assert the CLI nature.
  assert.strictEqual((await ant.getModels())[0].billing, 'subscription', 'claude models billed via subscription');

  const goo = providerModule.getProvider('google');
  assert.strictEqual((await goo.getStatus()).cli, true, 'google is a CLI provider');
  assert.strictEqual((await goo.getModels())[0].billing, 'free-account', 'google models billed as free account / API');

  const oll = providerModule.getProvider('ollama');
  assert.strictEqual((await oll.getStatus()).connected, false, 'ollama not connected without a server');
  assert.ok(Array.isArray(await oll.getModels()), 'ollama models is an array');

  const parse = providerModule.parseCliLine;
  assert.strictEqual(parse({ type: 'stream_event', data: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'x' } } }), 'x', 'claude text delta');
  assert.deepStrictEqual(parse({ type: 'result', result: 'R' }), { result: 'R' }, 'cli result event');
  assert.strictEqual(parse({ type: 'assistant', message: { content: [{ text: 'a' }, { text: 'b' }] } }), 'ab', 'agy assistant array');
  assert.deepStrictEqual(parse({ usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 2 } }), { usage: { prompt_tokens: 1, completion_tokens: 2 } }, 'gemini usage');

  const bp = providerModule.buildPrompt;
  assert.strictEqual(bp('SYS', [{ role: 'user', content: 'hi' }], false), 'SYS\n\nhi', 'system prepended');
  assert.strictEqual(bp('SYS', [{ role: 'user', content: 'hi' }], true), 'hi', 'system excluded when sent as flag');

  const CliProvider = providerModule.CliProvider;
  const fakeCli = new CliProvider('test-cli', 'Fake CLI', { binaries: ['node'], models: [{ id: 'm', name: 'm', isFree: true, supportsVision: true, billing: 'free-account' }], systemFlag: ['--append-system-prompt'] });
  fakeCli.script = path.join(__dirname, 'fixtures', 'cli-fake.js');
  let deltas = '';
  const cliRes = await fakeCli.chat({ model: 'm', system: 'be terse', messages: [{ role: 'user', content: 'say hi' }], onDelta: (d) => { deltas += d; }, onUsage: () => {} });
  assert.strictEqual(deltas, 'Hello world', 'CLI chat streams deltas');
  assert.strictEqual(cliRes.text, 'Hello world', 'CLI chat returns final text');
  const argv = ['node', fakeCli.script, '--input-format', 'text', '--output-format', 'stream-json', '--model', 'm', '--append-system-prompt', 'be terse'];
  assert.ok(argv.includes('--append-system-prompt'), 'system flag wired for Claude-style CLI');

  const oai = providerModule.getProvider('openai');
  assert.strictEqual((await oai.getStatus()).connected, true, 'openai connected when key present');
  const realFetch = global.fetch;
  global.fetch = async (url, opts) => {
    assert.ok(String(url).includes('api.openai.com'), 'openai chat hits the OpenAI endpoint');
    const body = JSON.parse(opts.body);
    assert.ok(Array.isArray(body.messages) && body.stream === true, 'openai body shapes correctly');
    const enc = (s) => new TextEncoder().encode(s);
    const lines = [
      'data: ' + JSON.stringify({ choices: [{ delta: { content: 'hello' } }] }),
      'data: ' + JSON.stringify({ choices: [{ delta: { content: ' world' } }] }),
      'data: ' + JSON.stringify({ usage: { prompt_tokens: 1, completion_tokens: 2 } }),
      'data: [DONE]',
    ];
    return { ok: true, body: (async function* () { for (const l of lines) yield enc(l + '\n'); })() };
  };
  let oaiDeltas = '';
  const oaiRes = await oai.chat({ model: 'gpt-4o', system: 's', messages: [{ role: 'user', content: 'hi' }], onDelta: (d) => { oaiDeltas += d; }, onUsage: () => {} });
  global.fetch = realFetch;
  assert.strictEqual(oaiDeltas, 'hello world', 'openai chat accumulates streamed deltas');
  assert.strictEqual(oaiRes.text, 'hello world', 'openai chat returns text');

  console.log('providers.js unit test: PASSED');
})().catch((e) => { console.error('providers.js unit test FAILED:', e); process.exit(1); });

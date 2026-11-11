// Unit test for lib/providers.js: verifies provider registry, model lists, capabilities,
// and that a provider's chat() streams text from a mocked fetch.
const assert = require('assert');
const path = require('path');
const providerModule = require(path.join(__dirname, '..', 'lib', 'providers.js'));

const deps = {
  stream: async () => ({ text: 'openrouter-text', usage: { prompt_tokens: 1, completion_tokens: 2, cost: 0, elapsedMs: 1 } }),
  loadKey: () => 'sk-or-test',
  getModelsRaw: async () => ([{ id: 'openai/gpt-4o', pricing: { prompt: '0', completion: '0' }, architecture: { input_modalities: ['text', 'image'] } }]),
  getModelsCache: () => ({ data: [{ id: 'openai/gpt-4o', architecture: { input_modalities: ['text', 'image'] } }] }),
  loadProvCred: (id) => ({ anthropic: 'sk-ant', openai: 'sk-oai', google: 'AI' }[id] || ''),
  saveProvCred: () => {},
  IDLE_MS: 30000,
};
providerModule.init(deps);

(async () => {
  const all = providerModule.getAllProviders();
  assert.strictEqual(all.length, 5, 'expected 5 providers');

  // OpenRouter delegates to stream() and reads its model catalogue.
  const or = providerModule.getProvider('openrouter');
  const orModels = await or.getModels();
  assert.ok(orModels.some((m) => m.id === 'openai/gpt-4o'), 'openrouter exposes catalog model');
  assert.strictEqual(or.getCapabilities('openai/gpt-4o').supportsVision, true, 'openrouter vision from cache');
  const orRes = await or.chat({ model: 'openai/gpt-4o', system: 's', messages: [], onDelta: () => {}, onUsage: () => {} });
  assert.strictEqual(orRes.text, 'openrouter-text', 'openrouter chat delegates to stream()');

  // api_key providers: status reflects stored cred, model lists are hardcoded.
  const ant = providerModule.getProvider('anthropic');
  assert.strictEqual((await ant.getStatus()).connected, true, 'anthropic connected when cred present');
  assert.ok((await ant.getModels()).every((m) => m.supportsVision), 'anthropic models are vision-capable');
  assert.strictEqual(ant.getCapabilities().supportsVision, true, 'anthropic capabilities');

  const oai = providerModule.getProvider('openai');
  assert.strictEqual((await oai.getStatus()).connected, true, 'openai connected when cred present');
  const goo = providerModule.getProvider('google');
  assert.strictEqual((await goo.getStatus()).connected, true, 'google connected when cred present');

  // Ollama: no local server in CI -> status false, models [].
  const oll = providerModule.getProvider('ollama');
  assert.strictEqual((await oll.getStatus()).connected, false, 'ollama not connected without a server');
  const ollModels = await oll.getModels();
  assert.ok(Array.isArray(ollModels), 'ollama models is an array');

  // An api_key provider's chat() streams text from a mocked fetch.
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
    return {
      ok: true,
      body: (async function* () { for (const l of lines) yield enc(l + '\n'); })(),
    };
  };
  let deltas = '';
  const oaiRes = await oai.chat({ model: 'gpt-4o', system: 's', messages: [{ role: 'user', content: 'hi' }], onDelta: (d) => { deltas += d; }, onUsage: () => {} });
  global.fetch = realFetch;
  assert.strictEqual(deltas, 'hello world', 'openai chat accumulates streamed deltas');
  assert.strictEqual(oaiRes.text, 'hello world', 'openai chat returns text');

  console.log('providers.js unit test: PASSED');
})().catch((e) => { console.error('providers.js unit test FAILED:', e); process.exit(1); });

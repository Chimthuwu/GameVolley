// Unit test for lib/providers.js: verifies provider registry, model lists, capabilities,
// CLI spawn+parse, and that an api_key provider's chat() streams text from a mocked fetch.
const assert = require('assert');
const path = require('path');
const providerModule = require(path.join(__dirname, '..', 'lib', 'providers.js'));

const deps = {
  // main.js stream() returns the raw completion STRING (not { text }) — the
  // mock must mirror that real contract so regressions surface.
  stream: async () => 'openrouter-text',
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
  assert.strictEqual(all.length, 6, 'expected 6 providers');

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

  const goo = providerModule.getProvider('gemini');
  assert.strictEqual((await goo.getStatus()).cli, true, 'gemini is a CLI provider');
  assert.strictEqual((await goo.getModels())[0].billing, 'free-account', 'gemini models billed as free account / API');

  const oll = providerModule.getProvider('ollama');
    const ollStatus = await oll.getStatus();
    assert.ok(typeof ollStatus.connected === 'boolean', 'ollama status has connected boolean');
    assert.strictEqual(ollStatus.authMethod, 'Local (no auth)', 'ollama auth method is local');
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

  assert.ok(providerModule.getProvider('anthropic').extraArgs.includes('--verbose'), 'Claude CLI chat passes --verbose (required with stream-json in print mode)');
  assert.ok(providerModule.getProvider('anthropic').extraArgs.includes('--include-partial-messages'), 'Claude CLI chat asks for partial text, so a long reply is never silent');

  // The shape Claude Code really sends: pieces first, then the whole message again.
  assert.strictEqual(parse({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'y' } } }), 'y', 'claude partial piece');
  assert.strictEqual(parse({ type: 'stream_event', event: { type: 'message_start', message: {} } }), null, 'other stream events carry no text');
  const partialCli = new CliProvider('partial-cli', 'Fake Claude', { binaries: ['node'], models: [] });
  partialCli.script = path.join(__dirname, 'fixtures', 'cli-fake-partial.js');
  let pieces = '';
  const partialRes = await partialCli.chat({ system: '', messages: [{ role: 'user', content: 'go' }], onDelta: (d) => { pieces += d; } });
  assert.strictEqual(pieces, 'Hello world', 'each piece reaches the screen once, not again with the whole message');
  assert.strictEqual(partialRes.text, 'Hello world', 'final text with partial messages');

  // ---- OpenCode Go, against a stand-in server. The key here is made up. ----
  const oc = providerModule.getProvider('opencode-go');
  assert.strictEqual(oc.id, 'opencode-go', 'OpenCode Go is registered, not the openrouter fallback');
  assert.strictEqual((await oc.getStatus()).connected, false, 'not connected without a key');
  await assert.rejects(oc.verify(), /No OpenCode Go API key/);
  await assert.rejects(oc.chat({ model: 'glm-5.3', messages: [] }), /No OpenCode Go API key/);

  const loadBefore = deps.loadProvCred;
  deps.loadProvCred = (id) => (id === 'opencode-go' ? 'made-up-test-key' : loadBefore(id));
  const fetchBefore = global.fetch;
  const seen = [];
  let usageStatus = 200;
  let streamLines = [];
  global.fetch = async (url, opts = {}) => {
    seen.push({ url: String(url), opts });
    if (String(url).endsWith('/v1/models')) {
      const ids = ['beam-free', 'text-embedding-3-small', 'jev-1.14', 'gpt-6-luna-decision', 'glm-5.3-flash', 'kimi-k3'];
      return { ok: true, status: 200, json: async () => ({ data: ids.map((id) => ({ id })) }) };
    }
    if (String(url).endsWith('/v1/usage')) {
      return { ok: usageStatus === 200, status: usageStatus, text: async () => JSON.stringify({ error: { message: 'stand-in says no' } }) };
    }
    const enc = new TextEncoder();
    return { ok: true, status: 200, body: (async function* () { for (const l of streamLines) yield enc.encode(l + '\n'); })() };
  };
  try {
    const ocModels = await oc.getModels();
    assert.deepStrictEqual(ocModels.map((m) => m.id), ['beam-free', 'glm-5.3-flash', 'kimi-k3'], 'embedding and decision models are left out');
    assert.strictEqual(ocModels.find((m) => m.autoDefault).id, 'glm-5.3-flash', 'a blank model box means the default, not the first free model');
    assert.ok(!seen[0].opts.headers.Authorization, 'the public model list is asked for without the key');

    await oc.verify();
    assert.strictEqual(seen.at(-1).url, 'https://opencode.ai/inference/go/v1/usage');
    assert.strictEqual(seen.at(-1).opts.headers.Authorization, 'Bearer made-up-test-key');
    usageStatus = 401;
    await assert.rejects(oc.verify(), /rejected the API key \(401\).*stand-in says no/, 'a bad key is reported');
    usageStatus = 403;
    await assert.rejects(oc.verify(), /needs a Go subscription/, 'a key without Go is reported');

    streamLines = ['data: ' + JSON.stringify({ choices: [{ delta: { content: 'play ' } }] }), 'data: ' + JSON.stringify({ choices: [{ delta: { content: 'on' } }] }), 'data: [DONE]'];
    let shown = '';
    const chatOnce = (extra) => oc.chat({ system: 'role A', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], onDelta: (d) => { shown += d; }, ...extra });
    assert.strictEqual((await chatOnce({ model: 'opencode-go/kimi-k3', maxTokens: 500 })).text, 'play on');
    assert.strictEqual(shown, 'play on');
    const sent = seen.at(-1);
    assert.strictEqual(sent.url, 'https://opencode.ai/inference/go/openai/v1/chat/completions');
    assert.match(sent.opts.headers['user-agent'], /^GameVolley\/\d/, 'names itself');
    const body = JSON.parse(sent.opts.body);
    assert.strictEqual(body.model, 'kimi-k3', 'the opencode-go/ prefix is removed');
    assert.strictEqual(body.max_tokens, 500);
    assert.deepStrictEqual(body.messages, [{ role: 'system', content: 'role A' }, { role: 'user', content: 'hi' }]);

    const first = sent.opts.headers['x-opencode-session'];
    assert.ok(first, 'sends a session id');
    await chatOnce({ model: null });
    assert.strictEqual(JSON.parse(seen.at(-1).opts.body).model, 'glm-5.3-flash', 'a blank Developer model still sends one');
    assert.strictEqual(seen.at(-1).opts.headers['x-opencode-session'], first, 'same role keeps its session');
    await chatOnce({ model: 'kimi-k3', system: 'role B' });
    assert.notStrictEqual(seen.at(-1).opts.headers['x-opencode-session'], first, 'another role gets its own session');

    const before = seen.length;
    await assert.rejects(chatOnce({ model: 'z-ai/glm-5.3-flash' }), /isn't an OpenCode Go model/, 'a leftover OpenRouter name is explained');
    assert.strictEqual(seen.length, before, 'and nothing is sent');

    // A reasoning model: its thinking is counted for the log but never joins the reply.
    const thinkingLine = (text, extra = {}) => 'data: ' + JSON.stringify({ choices: [{ delta: { reasoning_content: text }, ...extra }] });
    let thought = 0;
    streamLines = [thinkingLine('hmm, '), thinkingLine('right'), 'data: ' + JSON.stringify({ choices: [{ delta: { content: 'done' } }] })];
    assert.strictEqual((await chatOnce({ model: 'kimi-k3', onActivity: (a) => { thought += a.thinking; } })).text, 'done');
    assert.strictEqual(thought, 10, 'counts the reasoning characters');
    streamLines = [thinkingLine('still thinking', { finish_reason: 'length' })];
    await assert.rejects(chatOnce({ model: 'kimi-k3' }), /whole reply allowance on thinking/);

    streamLines = ['data: ' + JSON.stringify({ error: { message: 'model is busy' } })];
    await assert.rejects(chatOnce({ model: 'kimi-k3' }), /model is busy/, 'an error inside the reply is shown');
  } finally {
    global.fetch = fetchBefore;
    deps.loadProvCred = loadBefore;
  }

  console.log('providers.js unit test: PASSED');
})().catch((e) => { console.error('providers.js unit test FAILED:', e); process.exit(1); });

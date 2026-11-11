// VolleyPrompt — multi-provider support.
//
// Each provider implements a consistent interface so the rest of the app (run:start,
// the settings UI) never needs to know which provider is in use:
//   getStatus()            -> { connected, authMethod?, user? }
//   getModels()            -> Promise<[{ id, name, isFree, supportsVision }]>
//   getCapabilities(model) -> { supportsVision, streaming }
//   chat({ model, system, messages, signal, onDelta, onUsage, onCtl })
//                          -> Promise<{ text, usage? }>
//
// OpenRouter reuses the application's existing stream()/loadKey()/modelsRawCache so its
// battle-tested behaviour is preserved exactly. The other providers talk to their official
// HTTP APIs. Credentials are kept out of the renderer and stored encrypted (safeStorage).

let deps = {};
function init(d) { deps = d; }

// ---- shared SSE/stream parser (OpenAI-compatible, Anthropic, Gemini all stream JSON lines) ----
async function streamSSE({ url, method = 'POST', headers, body, signal, onDelta, onUsage, onCtl, idleMs }) {
  const ctl = new AbortController();
  let idle = null;
  let stalled = false;
  const arm = () => { clearTimeout(idle); idle = setTimeout(() => { stalled = true; ctl.abort(); }, idleMs || 30000); };
  if (signal) { if (signal.aborted) ctl.abort(); else signal.addEventListener('abort', () => ctl.abort(), { once: true }); }
  if (onCtl) onCtl(() => ctl.abort());
  const startedAt = Date.now();
  let promptTokens = 0;
  let completionTokens = 0;
  let text = '';
  try {
    arm();
    const res = await fetch(url, { method, headers, body: JSON.stringify(body), signal: ctl.signal });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw new Error(`Provider returned HTTP ${res.status}. ${t.slice(0, 200)}`);
    }
    const dec = new TextDecoder();
    let buf = '';
    arm();
    for await (const chunk of res.body) {
      arm();
      buf += dec.decode(chunk, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        let j;
        try { j = JSON.parse(data); } catch { continue; }
        const out = deps.parse ? deps.parse(j) : parseOpenAI(j);
        if (typeof out === 'string') { text += out; onDelta(out); }
        else if (out && out.usage) {
          promptTokens += out.usage.prompt_tokens || 0;
          completionTokens += out.usage.completion_tokens || 0;
        }
      }
    }
    if (!text.trim()) throw new Error('The model returned nothing. Try a different model.');
    if (onUsage) onUsage({ prompt_tokens: promptTokens, completion_tokens: completionTokens, elapsedMs: Date.now() - startedAt });
    return { text };
  } catch (e) {
    if (stalled) throw new Error(`The model stopped responding (nothing for ${(idleMs / 1000)}s). Try again or pick a different model.`);
    throw e;
  } finally {
    clearTimeout(idle);
  }
}

function parseOpenAI(j) {
  if (j.usage) return { usage: { prompt_tokens: j.usage.prompt_tokens || 0, completion_tokens: j.usage.completion_tokens || 0 } };
  const d = j.choices && j.choices[0] && j.choices[0].delta && j.choices[0].delta.content;
return d || null;
}

function toAnthropicMessage(m) {
  const role = m.role === 'assistant' ? 'assistant' : 'user';
  const content = typeof m.content === 'string'
    ? m.content
    : m.content.map((c) => {
        if (c.type === 'image_url') {
          const comma = c.image_url.url.indexOf(',');
          const b64 = comma >= 0 ? c.image_url.url.slice(comma + 1) : '';
          return { type: 'image', source: { type: 'base64', media_type: 'image/png', data: b64 } };
        }
        return { type: 'text', text: c.text };
      }).filter(Boolean);
  return { role, content };
}

function toGeminiContent(m) {
  const role = m.role === 'assistant' ? 'model' : 'user';
  const parts = typeof m.content === 'string'
    ? [{ text: m.content }]
    : m.content.map((c) => {
        if (c.type === 'image_url') {
          const comma = c.image_url.url.indexOf(',');
          const b64 = comma >= 0 ? c.image_url.url.slice(comma + 1) : '';
          return { inline_data: { mime_type: 'image/png', data: b64 } };
        }
        return { text: c.text };
      }).filter(Boolean);
  return { role, parts };
}

class BaseProvider {
  constructor(id, name, authType, requiresExternalCli = false) {
    this.id = id;
    this.name = name;
    this.authType = authType;
    this.requiresExternalCli = requiresExternalCli;
  }
  async getStatus() { return { connected: false }; }
  async getModels() { return []; }
  getCapabilities() { return { supportsVision: false, streaming: true }; }
  async chat() { throw new Error('Not implemented'); }
}

// OpenRouter — reuses the app's existing stream() so behaviour is identical to before.
class OpenRouterProvider extends BaseProvider {
  constructor() { super('openrouter', 'OpenRouter', 'api_key', false); }
  async getStatus() { return { connected: !!deps.loadKey(), authMethod: 'API Key' }; }
  async getModels() {
    const data = await deps.getModelsRaw();
    return data.map((m) => ({
      id: m.id,
      name: m.id,
      isFree: /:free$/i.test(m.id) || ((parseFloat(m.pricing?.prompt || '0') + parseFloat(m.pricing?.completion || '0')) * 1e6) === 0,
      supportsVision: !!m.architecture?.input_modalities?.includes('image'),
    }));
  }
  getCapabilities(model) {
    const m = deps.getModelsCache().data.find((x) => x.id === model);
    return { supportsVision: m ? !!m.architecture?.input_modalities?.includes('image') : null, streaming: true };
  }
  async chat(opts) {
    return deps.stream(deps.loadKey(), opts.model, opts.system, opts.messages, opts.signal, opts.onDelta, opts.onUsage, opts.onCtl);
  }
}

// Anthropic — official Messages API, API key. Vision-capable.
class AnthropicProvider extends BaseProvider {
  constructor() { super('anthropic', 'Anthropic', 'api_key', false); }
  async getStatus() {
    const k = deps.loadProvCred('anthropic');
    return { connected: !!k, authMethod: 'API Key', user: k ? 'sk-ant-…' + k.slice(-4) : '' };
  }
  async getModels() {
    return [
      { id: 'claude-opus-4-5', name: 'Claude Opus 4.5', isFree: false, supportsVision: true },
      { id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5', isFree: false, supportsVision: true },
      { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5', isFree: false, supportsVision: true },
    ];
  }
  getCapabilities() { return { supportsVision: true, streaming: true }; }
  async chat({ model, system, messages, signal, onDelta, onUsage, onCtl }) {
    const apiKey = deps.loadProvCred('anthropic');
    if (!apiKey) throw new Error('No Anthropic API key. Open Settings and add one.');
    const parse = (j) => {
      if (j.type === 'content_block_delta' && j.delta && j.delta.type === 'text_delta') return j.delta.text;
      if (j.type === 'message_start' && j.message && j.message.usage) return { usage: { prompt_tokens: j.message.usage.input_tokens || 0 } };
      if (j.type === 'message_delta' && j.usage) return { usage: { completion_tokens: j.usage.output_tokens || 0 } };
      return null;
    };
    deps.parse = parse;
    return streamSSE({
      url: 'https://api.anthropic.com/v1/messages',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: { model, max_tokens: 8192, stream: true, system: system || undefined, messages: messages.map(toAnthropicMessage) },
      signal, onDelta, onUsage, onCtl, idleMs: deps.IDLE_MS,
    });
  }
}

// OpenAI — official Chat Completions API, API key (OpenAI-compatible).
class OpenAIProvider extends BaseProvider {
  constructor() { super('openai', 'OpenAI', 'api_key', false); }
  async getStatus() {
    const k = deps.loadProvCred('openai');
    return { connected: !!k, authMethod: 'API Key', user: k ? 'sk-…' + k.slice(-4) : '' };
  }
  async getModels() {
    return [
      { id: 'gpt-5', name: 'GPT-5', isFree: false, supportsVision: true },
      { id: 'gpt-5-mini', name: 'GPT-5 Mini', isFree: false, supportsVision: true },
      { id: 'gpt-4.1', name: 'GPT-4.1', isFree: false, supportsVision: true },
      { id: 'gpt-4o', name: 'GPT-4o', isFree: false, supportsVision: true },
      { id: 'gpt-4o-mini', name: 'GPT-4o Mini', isFree: false, supportsVision: true },
    ];
  }
  getCapabilities() { return { supportsVision: true, streaming: true }; }
  async chat({ model, system, messages, signal, onDelta, onUsage, onCtl }) {
    const apiKey = deps.loadProvCred('openai');
    if (!apiKey) throw new Error('No OpenAI API key. Open Settings and add one.');
    const full = system ? [{ role: 'system', content: system }, ...messages] : messages;
    return streamSSE({
      url: 'https://api.openai.com/v1/chat/completions',
      headers: { Authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: { model, stream: true, stream_options: { include_usage: true }, messages: full },
      signal, onDelta, onUsage, onCtl, idleMs: deps.IDLE_MS,
    });
  }
}

// Google Gemini — official Generative Language API, API key.
class GeminiProvider extends BaseProvider {
  constructor() { super('google', 'Google Gemini', 'api_key', false); }
  async getStatus() {
    const k = deps.loadProvCred('google');
    return { connected: !!k, authMethod: 'API Key', user: k ? 'AI…' + k.slice(-4) : '' };
  }
  async getModels() {
    return [
      { id: 'gemini-3-pro', name: 'Gemini 3 Pro', isFree: false, supportsVision: true },
      { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', isFree: false, supportsVision: true },
      { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', isFree: false, supportsVision: true },
    ];
  }
  getCapabilities() { return { supportsVision: true, streaming: true }; }
  async chat({ model, system, messages, signal, onDelta, onUsage, onCtl }) {
    const apiKey = deps.loadProvCred('google');
    if (!apiKey) throw new Error('No Google API key. Open Settings and add one.');
    const contents = messages.map(toGeminiContent);
    const parse = (j) => {
      if (j.usageMetadata) {
        return { usage: { prompt_tokens: j.usageMetadata.promptTokenCount || 0, completion_tokens: j.usageMetadata.candidatesTokenCount || 0 } };
      }
      const part = j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts;
      if (Array.isArray(part)) return part.map((p) => p.text || '').join('');
      return null;
    };
    deps.parse = parse;
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${apiKey}`;
    return streamSSE({
      url,
      headers: { 'content-type': 'application/json' },
      body: { systemInstruction: system ? { parts: [{ text: system }] } : undefined, contents },
      signal, onDelta, onUsage, onCtl, idleMs: deps.IDLE_MS,
    });
  }
}

// Ollama — local HTTP, no auth. OpenAI-compatible chat completions endpoint.
class OllamaProvider extends BaseProvider {
  constructor() { super('ollama', 'Ollama (Local)', 'local', false); }
  async getStatus() {
    try {
      const r = await fetch('http://localhost:11434/api/tags');
      if (!r.ok) return { connected: false };
      return { connected: true, authMethod: 'Local (no auth)' };
    } catch { return { connected: false }; }
  }
  async getModels() {
    try {
      const r = await fetch('http://localhost:11434/api/tags');
      if (!r.ok) return [];
      const j = await r.json();
      return (j.models || []).map((m) => ({ id: m.name, name: m.name, isFree: true, supportsVision: true }));
    } catch { return []; }
  }
  getCapabilities() { return { supportsVision: true, streaming: true }; }
  async chat({ model, system, messages, signal, onDelta, onUsage, onCtl }) {
    const full = system ? [{ role: 'system', content: system }, ...messages] : messages;
    return streamSSE({
      url: 'http://localhost:11434/v1/chat/completions',
      headers: { 'content-type': 'application/json' },
      body: { model, stream: true, stream_options: { include_usage: true }, messages: full },
      signal, onDelta, onUsage, onCtl, idleMs: deps.IDLE_MS,
    });
  }
}

const providers = {
  openrouter: new OpenRouterProvider(),
  anthropic: new AnthropicProvider(),
  openai: new OpenAIProvider(),
  google: new GeminiProvider(),
  ollama: new OllamaProvider(),
};

function getProvider(id) { return providers[id] || providers.openrouter; }
function getAllProviders() { return Object.values(providers); }
async function getProviderStatuses() {
  const results = {};
  for (const [id, p] of Object.entries(providers)) results[id] = await p.getStatus();
  return results;
}

module.exports = { init, getProvider, getAllProviders, getProviderStatuses, providers };

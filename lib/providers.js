// VolleyPrompt — multi-provider support.
//
// Each provider implements a consistent interface so the rest of the app (run:start,
// the settings UI) never needs to know which provider is in use:
//   getStatus()            -> { connected, authMethod?, user?, cli?, installed? }
//   getModels()            -> Promise<[{ id, name, isFree, supportsVision, billing }]>
//   getCapabilities(model) -> { supportsVision, streaming }
//   chat({ model, system, messages, signal, onDelta, onUsage, onCtl })
//                          -> Promise<{ text, usage? }>
//   meta()                 -> { id, name, authType, requiresExternalCli, cliBinaries,
//                               installHint, billingNote, paid }
//
// Three auth models are supported, matching what each vendor legitimately permits a
// third-party desktop app to use:
//
//   kind 'api'   — provider API key (paid: OpenAI/OpenRouter). Stored encrypted locally.
//   kind 'cli'   — the vendor's OFFICIAL desktop CLI (Claude Code CLI, Google Antigravity/
//                  Gemini CLI). VolleyPrompt shells out to the unmodified binary; the user
//                  authenticates via the vendor's own login flow (a browser). Credentials
//                  never touch VolleyPrompt. This is the legitimate way to use an existing
//                  Claude Pro/Max/Ultra subscription or a free Google account — no API key,
//                  no extra charge. (Anthropic explicitly permits an end user to sign into
//                  the unmodified Claude Code binary with their own subscription; Google's
//                  consumer free tier now runs through the `agy`/`gemini` CLI.)
//   kind 'local' — Ollama, no auth.
//
// OpenRouter reuses the application's existing stream()/loadKey()/modelsRawCache so its
// battle-tested behaviour is preserved exactly.

const { spawn, spawnSync } = require('child_process');

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

function contentOf(m) {
  if (typeof m.content === 'string') return m.content;
  return (m.content || []).map((c) => (c && c.text) || '').join('');
}

class BaseProvider {
  constructor(id, name, meta = {}) {
    this.id = id;
    this.name = name;
    this.authType = meta.authType || 'api_key';
    this.requiresExternalCli = !!meta.requiresExternalCli;
    this.cliBinaries = meta.cliBinaries || null;
    this.installHint = meta.installHint || '';
    this.billingNote = meta.billingNote || '';
    this.paid = !!meta.paid;
  }
  async getStatus() { return { connected: false }; }
  async getModels() { return []; }
  getCapabilities() { return { supportsVision: false, streaming: true }; }
  async chat() { throw new Error('Not implemented'); }
  meta() {
    return {
      id: this.id, name: this.name, authType: this.authType,
      requiresExternalCli: this.requiresExternalCli, cliBinaries: this.cliBinaries,
      installHint: this.installHint, billingNote: this.billingNote, paid: this.paid,
    };
  }
}

// OpenRouter — reuses the app's existing stream() so behaviour is identical to before.
class OpenRouterProvider extends BaseProvider {
  constructor() {
    super('openrouter', 'OpenRouter', {
      authType: 'api_key', paid: true,
      billingNote: 'Paid API (OpenRouter). Billed per token through your OpenRouter key.',
    });
  }
  async getStatus() { return { connected: !!deps.loadKey(), authMethod: 'API Key' }; }
  async getModels() {
    const data = await deps.getModelsRaw();
    return data.map((m) => ({
      id: m.id,
      name: m.id,
      isFree: /:free$/i.test(m.id) || ((parseFloat(m.pricing?.prompt || '0') + parseFloat(m.pricing?.completion || '0')) * 1e6) === 0,
      supportsVision: !!m.architecture?.input_modalities?.includes('image'),
      billing: 'api',
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

// OpenAI — official Chat Completions API, API key (paid). Vision-capable.
class OpenAIProvider extends BaseProvider {
  constructor() {
    super('openai', 'OpenAI', {
      authType: 'api_key', paid: true,
      billingNote: 'Paid API key (OpenAI). You are billed per token by OpenAI — separate from any ChatGPT subscription.',
    });
  }
  async getStatus() {
    const k = deps.loadProvCred('openai');
    return { connected: !!k, authMethod: 'API Key', user: k ? 'sk-…' + k.slice(-4) : '' };
  }
  async getModels() {
    return [
      { id: 'gpt-5', name: 'GPT-5 (API, paid)', isFree: false, supportsVision: true, billing: 'api' },
      { id: 'gpt-5-mini', name: 'GPT-5 Mini (API, paid)', isFree: false, supportsVision: true, billing: 'api' },
      { id: 'gpt-4.1', name: 'GPT-4.1 (API, paid)', isFree: false, supportsVision: true, billing: 'api' },
      { id: 'gpt-4o', name: 'GPT-4o (API, paid)', isFree: false, supportsVision: true, billing: 'api' },
      { id: 'gpt-4o-mini', name: 'GPT-4o Mini (API, paid)', isFree: false, supportsVision: true, billing: 'api' },
    ];
  }
  getCapabilities() { return { supportsVision: true, streaming: true }; }
  async chat({ model, system, messages, signal, onDelta, onUsage, onCtl }) {
    const apiKey = deps.loadProvCred('openai');
    if (!apiKey) throw new Error('No OpenAI API key. Open Settings and add one (this is a paid API key, separate from ChatGPT).');
    const full = system ? [{ role: 'system', content: system }, ...messages] : messages;
    return streamSSE({
      url: 'https://api.openai.com/v1/chat/completions',
      headers: { Authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: { model, stream: true, stream_options: { include_usage: true }, messages: full },
      signal, onDelta, onUsage, onCtl, idleMs: deps.IDLE_MS,
    });
  }
}

// Ollama — local HTTP, no auth. OpenAI-compatible chat completions endpoint.
class OllamaProvider extends BaseProvider {
  constructor() {
    super('ollama', 'Ollama (Local)', {
      authType: 'local',
      billingNote: 'Free — runs entirely on your machine. No account, no network, no billing.',
    });
  }
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
      return (j.models || []).map((m) => ({ id: m.name, name: m.name, isFree: true, supportsVision: true, billing: 'local' }));
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

// ---- CLI providers: shell out to the vendor's OFFICIAL desktop CLI ----
// The user installs the CLI and logs in via the vendor's own browser flow. VolleyPrompt
// never sees the credentials. We spawn the binary, pipe the prompt to stdin, and parse
// its newline-delimited JSON (`--output-format stream-json`) output into text deltas.
class CliProvider extends BaseProvider {
  // options: { binaries:[...], installHint, billingNote, models, systemFlag:[...]|null }
  constructor(id, name, opts) {
    super(id, name, {
      authType: 'cli', requiresExternalCli: true,
      cliBinaries: opts.binaries, installHint: opts.installHint,
      billingNote: opts.billingNote, paid: false,
    });
    this.binaries = opts.binaries;
    this.modelsList = opts.models;
    this.systemFlag = opts.systemFlag || null; // e.g. ['--append-system-prompt']; null => prepend to prompt text
  }

  // Find the first binary on PATH that responds to `--version`. On Windows npm-global
  // CLIs install as `<name>.cmd`, so we also try that.
  resolveBinary() {
    for (const b of this.binaries) {
      for (const cand of [b, `${b}.cmd`, `${b}.exe`]) {
        try {
          const r = spawnSync(cand, ['--version'], { timeout: 5000, windowsHide: true });
          if (!r.error) return cand;
        } catch { /* keep trying */ }
      }
    }
    return null;
  }

  async getStatus() {
    const bin = this.resolveBinary();
    if (!bin) return { connected: false, cli: true, installed: false, authMethod: 'CLI (your account)' };
    return { connected: true, cli: true, installed: true, authMethod: 'CLI (your account)', binary: bin };
  }

  async getModels() { return this.modelsList; }
  getCapabilities() { return { supportsVision: true, streaming: true }; }

  // Join system + conversation into a single prompt. When the CLI takes the system prompt
  // as a flag (Claude), we exclude it here so it isn't doubled.
  buildPrompt(system, messages, excludeSystem) {
    const parts = [];
    if (system && !excludeSystem) parts.push(system);
    for (const m of messages) parts.push(contentOf(m));
    return parts.join('\n\n');
  }

  // Parse one NDJSON line from a CLI stream into either a text delta (string) or a signal
  // object ({ result } or { usage }). Handles both Claude Code and Antigravity/Gemini shapes.
  parseCliLine(j) {
    if (!j || typeof j !== 'object') return null;
    if (j.type === 'result' && j.result !== undefined) return { result: j.result };
    if (j.usageMetadata || j.usage) {
      const u = j.usageMetadata || j.usage;
      return { usage: { prompt_tokens: u.promptTokenCount || u.input_tokens || 0, completion_tokens: u.candidatesTokenCount || u.output_tokens || 0 } };
    }
    let d = null;
    if (j.type === 'stream_event' && j.data) d = j.data;
    else if (j.type === 'content_block_delta') d = j;
    if (d) {
      if (d.type === 'content_block_delta' && d.delta && d.delta.type === 'text_delta') return d.delta.text;
      if (d.type === 'text' && typeof d.text === 'string') return d.text;
    }
    if (j.type === 'assistant' && j.message && j.message.content) {
      const c = j.message.content;
      if (typeof c === 'string') return c;
      if (Array.isArray(c)) return c.map((x) => (x && x.text) || '').join('');
    }
    if (typeof j.text === 'string') return j.text;
    return null;
  }

  async chat({ model, system, messages, signal, onDelta, onUsage, onCtl }) {
    const bin = this.resolveBinary();
    if (!bin) {
      throw new Error(`${this.name} CLI not found. ${this.installHint || 'Install it and log in first.'}`);
    }
    const excludeSystem = !!(this.systemFlag && system);
    const prompt = this.buildPrompt(system, messages, excludeSystem);
    const args = ['--input-format', 'text', '--output-format', 'stream-json'];
    if (model) args.push('--model', String(model));
    if (this.systemFlag && system) args.push(...this.systemFlag, system);
    // Test hook: prepend a script so we can exercise spawn+parse without the real CLI.
    const finalArgs = this.script ? [this.script, ...args] : args;

    const ctl = new AbortController();
    if (signal) { if (signal.aborted) ctl.abort(); else signal.addEventListener('abort', () => ctl.abort(), { once: true }); }
    if (onCtl) onCtl(() => ctl.abort());

    return new Promise((resolve, reject) => {
      const child = spawn(bin, finalArgs, { windowsHide: true });
      let buf = '';
      let stderr = '';
      let text = '';
      let stalled = false;
      let idle = null;
      const arm = () => { clearTimeout(idle); idle = setTimeout(() => { stalled = true; try { child.kill(); } catch {} }, deps.IDLE_MS || 30000); };
      const finish = (fn, val) => { clearTimeout(idle); fn(val); };

      child.on('error', (e) => finish(reject, new Error(`${this.name} CLI failed to start: ${e.message}`)));
      child.stdin.on('error', () => {});
      child.stderr.on('data', (d) => { stderr += d.toString(); });

      const handleLine = (line) => {
        let j;
        try { j = JSON.parse(line); } catch { return; }
        const out = this.parseCliLine(j);
        if (typeof out === 'string') { text += out; if (onDelta) onDelta(out); }
        else if (out && out.result !== undefined) { text = out.result; }
        else if (out && out.usage && onUsage) { onUsage(out.usage); }
      };

      child.stdout.on('data', (d) => {
        arm();
        buf += d.toString();
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (line) handleLine(line);
        }
      });

      child.on('close', (code) => {
        // Flush any trailing buffered line.
        const tail = buf.trim();
        if (tail) handleLine(tail);
        if (stalled) return finish(reject, new Error(`${this.name} stopped responding (no output for ${(deps.IDLE_MS || 30000) / 1000}s).`));
        if (code !== 0) {
          const s = stderr.trim();
          if (/not\s*logged|login|unauthor|auth|401|403/i.test(s)) {
            return finish(reject, new Error(`${this.name} CLI (${bin}) is not authenticated. Run "${bin} login" in a terminal first (it opens your browser), then try again.`));
          }
          return finish(reject, new Error(`${this.name} CLI (${bin}) failed: ${s.slice(0, 300) || 'exit code ' + code}`));
        }
        if (!text.trim()) return finish(reject, new Error('The model returned nothing. Try a different model.'));
        return finish(resolve, { text });
      });

      // Write the prompt to stdin and close it so the CLI begins processing.
      try { child.stdin.write(prompt); child.stdin.end(); } catch (e) { finish(reject, e); }
      arm();
    });
  }
}

// Claude — the official Claude Code CLI. Uses YOUR Claude Pro/Max/Ultra subscription.
// No API key, no extra charge. You install `claude` and run `claude login` once.
class ClaudeCliProvider extends CliProvider {
  constructor() {
    super('anthropic', 'Claude (Claude Code CLI)', {
      binaries: ['claude'],
      installHint: 'Install the Claude Code CLI (npm i -g @anthropic-ai/claude-code), then run "claude login" in a terminal (opens your browser). Uses your Claude Pro/Max/Ultra subscription — no API key.',
      billingNote: 'Your Claude Pro/Max/Ultra subscription. No API key, no extra charge.',
      systemFlag: ['--append-system-prompt'],
      models: [
        { id: 'sonnet', name: 'Claude Sonnet (your subscription)', isFree: false, supportsVision: true, billing: 'subscription' },
        { id: 'opus', name: 'Claude Opus (your subscription)', isFree: false, supportsVision: true, billing: 'subscription' },
        { id: 'haiku', name: 'Claude Haiku (your subscription)', isFree: false, supportsVision: true, billing: 'subscription' },
        { id: 'claude-opus-4-5', name: 'Claude Opus 4.5 (your subscription)', isFree: false, supportsVision: true, billing: 'subscription' },
        { id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5 (your subscription)', isFree: false, supportsVision: true, billing: 'subscription' },
        { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5 (your subscription)', isFree: false, supportsVision: true, billing: 'subscription' },
      ],
    });
  }
}

// Google — the official Antigravity/Gemini CLI (`agy` or `gemini`). Uses your free Google
// account allowance, or a Gemini API key if you set one. No subscription purchase needed.
class GoogleCliProvider extends CliProvider {
  constructor() {
    super('google', 'Google Gemini (CLI)', {
      binaries: ['gemini', 'agy'],
      installHint: 'Install the Google CLI: "npm i -g @google/gemini-cli" (or the Antigravity CLI "agy"). Run it once and sign in with your Google account. Free Google-account allowance, or set a GEMINI_API_KEY for API billing.',
      billingNote: 'Free Google account allowance (or a Gemini API key). No subscription purchase needed.',
      systemFlag: null, // prepend system to the prompt text (CLI has no reliable system flag)
      models: [
        { id: 'gemini-3-pro', name: 'Gemini 3 Pro (free account / API)', isFree: true, supportsVision: true, billing: 'free-account' },
        { id: 'gemini-3-flash', name: 'Gemini 3 Flash (free account / API)', isFree: true, supportsVision: true, billing: 'free-account' },
        { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro (free account / API)', isFree: true, supportsVision: true, billing: 'free-account' },
        { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash (free account / API)', isFree: true, supportsVision: true, billing: 'free-account' },
      ],
    });
  }
}

const providers = {
  openrouter: new OpenRouterProvider(),
  anthropic: new ClaudeCliProvider(),
  openai: new OpenAIProvider(),
  google: new GoogleCliProvider(),
  ollama: new OllamaProvider(),
};

function getProvider(id) { return providers[id] || providers.openrouter; }
function getAllProviders() { return Object.values(providers); }
async function getProviderStatuses() {
  const results = {};
  for (const [id, p] of Object.entries(providers)) results[id] = await p.getStatus();
  return results;
}

module.exports = {
  init, getProvider, getAllProviders, getProviderStatuses, providers,
  // exported for tests
  CliProvider,
  parseCliLine: (j) => new CliProvider('test', 'Test', { binaries: ['node'], models: [] }).parseCliLine(j),
  buildPrompt: (system, messages, excludeSystem) => new CliProvider('test', 'Test', { binaries: ['node'], models: [] }).buildPrompt(system, messages, excludeSystem),
};

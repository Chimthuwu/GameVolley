// provider-dev-agent.js
//
// A Developer role backed by a chat PROVIDER (OpenRouter / OpenAI / Anthropic /
// Gemini / Ollama) instead of a local coding-agent CLI. Used when the user has no
// coding CLI installed (or prefers their OpenRouter models).
//
// It is a REAL developer, not a fake one: the model is instructed to emit each file
// in a strict block format, we parse those blocks, and write the files into the
// actual project via ProjectManager (which validates paths against root escape).
// The existing snapshot-diff + checkpoint machinery in agent-manager sees exactly
// the same "files changed" results a CLI agent produces.
//
// No fake success: if the model returns no parseable files, runTask() throws and the
// pipeline reports the error honestly.

const DEV_SYSTEM = `You are an autonomous coding agent building a playable game inside an existing project directory.

You MUST respond ONLY with file blocks, one per file you create or fully rewrite. Exact format:

=== FILE: index.html ===
<complete file contents>
=== END FILE ===

Rules:
- ALWAYS output the COMPLETE contents of every file you touch — never diffs, never placeholders, never "... rest unchanged".
- Paths are relative to the project root (e.g. index.html, js/game.js). Never absolute, never with "..".
- The game must be playable by opening index.html (self-contained HTML + JS, Canvas or Three.js via CDN).
- No commentary, no markdown fences outside the file blocks. Your entire reply is file blocks.`;

const FILE_RE = /=== FILE: (.+?) ===\r?\n([\s\S]*?)\r?\n=== END FILE ===/g;

function parseFiles(text) {
  const files = [];
  FILE_RE.lastIndex = 0;
  let m;
  while ((m = FILE_RE.exec(text))) {
    let p = String(m[1]).trim().replace(/\\/g, '/');
    if (p.startsWith('./')) p = p.slice(2);
    files.push({ path: p, content: m[2] });
  }
  return files;
}

class ProviderDevAgent {
  // provider: a lib/providers instance (getProvider(id)) result — exposes chat().
  // projectManager: ProjectManager instance (writeFile validates paths).
  constructor({ provider, projectManager, providerId }) {
    this.provider = provider;
    this.projectManager = projectManager;
    this.providerId = providerId || 'provider';
    this.id = `prov:${this.providerId}`;
    this.name = `AI (${this.providerId})`;
  }

  // Always listed as available; if credentials are missing the chat call fails and
  // the error surfaces honestly instead of us pretending to know beforehand.
  async detect() {
    return { available: true, binary: null };
  }

  async getStatus() {
    return { available: true, authenticated: null, binary: null, detail: 'Writes files directly through the AI provider.' };
  }

  installHint() {
    return `Configure the ${this.providerId} provider (API key or CLI login) in the settings.`;
  }

  cancel() { /* the provider chat is cancelled via the AbortSignal */ }

  async runTask({ prompt, model = null, signal = null, onEvent = () => {} } = {}) {
    this._check(signal);
    this._emit(onEvent, { type: 'output', agent: this.id, text: `Asking ${this.providerId} to build the files…` });
    const res = await this.provider.chat({
      model: model || null,
      system: DEV_SYSTEM,
      messages: [{ role: 'user', content: prompt }],
      signal,
      onDelta: (d) => this._emit(onEvent, { type: 'output', agent: this.id, text: d }),
    });
    this._check(signal);
    const files = parseFiles(res && res.text ? res.text : '');
    if (!files.length) {
      const err = new Error(`${this.name} returned no file blocks — the model ignored the file format. Try a different model.`);
      this._emit(onEvent, { type: 'error', agent: this.id, message: err.message });
      throw err;
    }
    const written = [];
    for (const f of files) {
      this._check(signal);
      if (!f.path || f.path.startsWith('/') || f.path.includes('..') || /^[A-Za-z]:/.test(f.path)) {
        const err = new Error(`Refusing unsafe file path from model: "${f.path}"`);
        this._emit(onEvent, { type: 'error', agent: this.id, message: err.message });
        throw err;
      }
      await this.projectManager.writeFile(f.path, f.content);
      written.push(f.path);
      this._emit(onEvent, { type: 'output', agent: this.id, text: `wrote ${f.path} (${f.content.length} bytes)` });
    }
    return { ok: true, exitCode: 0, files: written, output: `${written.length} file(s) written` };
  }

  _check(signal) {
    if (signal && signal.aborted) throw new Error('aborted');
  }

  _emit(onEvent, ev) { onEvent && onEvent(ev); }
}

module.exports = { ProviderDevAgent, parseFiles, DEV_SYSTEM };

// provider-dev-agent.js
//
// A Developer role backed by a chat PROVIDER (OpenRouter / OpenAI / Anthropic /
// Gemini / Ollama) instead of a local coding-agent CLI. Used when the user has
// no coding CLI installed (or prefers their OpenRouter models).
//
// Pipeline: strict parse (canonical blocks, or fenced blocks carrying a path
// on the fence line) -> ONE format-recovery attempt (does not count as a
// correction round; raw output always saved to .gamevolley/diagnostics/) ->
// staged, preflighted write via commit-files.js (all-or-nothing; a late
// failure triggers the restore callback so the project is never left
// half-changed).
//
// No fake success: if the model returns no parseable files after recovery,
// runTask() throws and the pipeline reports the error honestly.

const { parseFiles } = require('../lib/parse-files.js');
const { commitFiles } = require('../lib/commit-files.js');
const { saveDiagnostic } = require('../lib/diagnostics.js');
const { resolveInside } = require('../lib/safe-path.js');

const DEV_SYSTEM = `You are an autonomous coding agent building a playable game inside an existing project directory.

You MUST respond ONLY with file blocks, one per file you create or fully rewrite. Exact format:

=== FILE: index.html ===
<complete file contents>
=== END FILE ===

Rules:
- ALWAYS output the COMPLETE contents of every file you touch — never diffs, never placeholders, never "... rest unchanged".
- Paths are relative to the project root (e.g. index.html, js/game.js). Never absolute, never with "..".
- The game must be playable by opening index.html (self-contained HTML + JS, Canvas or Three.js via CDN).
- No commentary, no markdown fences outside the file blocks. Your entire reply is file blocks.
- Close EVERY block you open. A response with an unterminated block is discarded.`;

const FORMAT_CONTRACT = `Return ONLY file blocks, no prose, exactly:
=== FILE: relative/path.ext ===
<full file contents>
=== END FILE ===
Every file must be complete. Close every block.`;

const GAME_GUIDELINES = `
GAME ENGINE GUIDELINES (apply those relevant to this game):
- Use one main loop driven by requestAnimationFrame (or the engine's equivalent). Compute dt in seconds from the timestamp, clamp it (e.g. max 0.05), and apply it exactly once. Express all durations in seconds, never frames.
- Use an explicit game state (e.g. menu, playing, paused, gameOver, victory). If the game has waves or rounds, add explicit transition states. Never re-arm a timer every frame. Empty waves and failed spawns must not stall the game. Victory and defeat states must persist.
- Use shape-appropriate collision (circle-circle for round objects, AABB or polygon otherwise). Keep radii/sizes in CONFIG. Pickup areas must match what is drawn.
- Canvas 2D: balance every ctx.save()/ctx.restore(); don't let one draw routine inherit another's styles or alpha.
- Put gameplay constants in one CONFIG object with descriptive names. No magic numbers.
- Pool only high-churn objects (projectiles, particles). Reset every field on reuse and handle pool exhaustion.
- Return complete files in the required file-block format. Do not truncate.`;

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

  async runTask({ prompt, model = null, signal = null, onEvent = () => {}, restore = null } = {}) {
    this._check(signal);
    this._emit(onEvent, { type: 'stage', stage: 'generating' });
    this._emit(onEvent, { type: 'output', agent: this.id, text: `Asking ${this.providerId} to build the files…` });
    const call = (system, messages) => this.provider.chat({
      model: model || null,
      system,
      messages,
      signal,
      onDelta: (d) => this._emit(onEvent, { type: 'output', agent: this.id, text: d }),
    });

    const root = this.projectManager.active && this.projectManager.active.path;
    if (!root) throw new Error('No active project. Open or create one first.');
    const res = await call(DEV_SYSTEM + GAME_GUIDELINES, [{ role: 'user', content: prompt }]);
    this._check(signal);

    this._emit(onEvent, { type: 'stage', stage: 'parsing' });
    let parsed = parseFiles(res && res.text ? res.text : '');
    const rawText = res && res.text ? res.text : '';

    if (!parsed.files.length && root) {
      const rawFile = await saveDiagnostic(root, 'raw-response', rawText, { error: parsed.error || 'empty response' });
      this._emit(onEvent, { type: 'stage', stage: 'recovering', detail: parsed.error, diagnostic: rawFile });

      // One recovery attempt. This does NOT count as a correction round.
      this._check(signal);
      const recovered = await call(FORMAT_CONTRACT, [{
        role: 'user',
        content: `Reformat this response into the required file blocks. Do not change the code.\n\n${rawText}`,
      }]);
      this._check(signal);
      parsed = parseFiles(recovered && recovered.text ? recovered.text : '');
      if (!parsed.files.length) {
        const failFile = await saveDiagnostic(root, 'recovery-failed', recovered && recovered.text ? recovered.text : '', { error: parsed.error || 'empty response' });
        const err = new Error(`${this.name} returned no usable file blocks after recovery (${parsed.error || 'empty response'}). Raw output saved to ${rawFile}`);
        this._emit(onEvent, { type: 'error', agent: this.id, message: err.message, diagnostic: failFile });
        throw err;
      }
    } else if (!parsed.files.length) {
      const err = new Error(`${this.name} returned no usable file blocks (${parsed.error || 'empty response'}).`);
      this._emit(onEvent, { type: 'error', agent: this.id, message: err.message });
      throw err;
    }

    // Staged, preflighted write: path safety is enforced inside commitFiles
    // (resolveInside), and a mid-write failure calls restore().
    this._emit(onEvent, { type: 'stage', stage: 'writing' });
    await commitFiles(root, parsed.files, restore);

    const written = parsed.files.map((f) => f.path);
    for (const p of written) {
      this._emit(onEvent, { type: 'output', agent: this.id, text: `wrote ${p}` });
    }
    return { ok: true, exitCode: 0, files: written, output: `${written.length} file(s) written` };
  }

  _check(signal) {
    if (signal && signal.aborted) throw new Error('aborted');
  }

  _emit(onEvent, ev) { onEvent && onEvent(ev); }
}

module.exports = { ProviderDevAgent, parseFiles, DEV_SYSTEM, FORMAT_CONTRACT, GAME_GUIDELINES, resolveInside };

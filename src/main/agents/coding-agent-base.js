// coding-agent-base.js
//
// Consistent interface for every local coding agent. A coding agent is a real CLI
// that edits files in the SELECTED project directory — not a chat model that merely
// returns code in a message. Subclasses implement buildArgs() and (optionally)
// checkAuth(); the shared runTask() spawns the binary, streams output, and supports
// cancellation.
//
// If a CLI is not installed or cannot be resolved, runTask() throws a CLEAR error
// rather than pretending the task ran. No fake success.

const { resolveExecutable, probe } = require('./executable-resolver.js');
const { streamProcess } = require('./agent-process.js');

class CodingAgentBase {
  constructor(meta) {
    this.id = meta.id;
    this.name = meta.name;
    this.binaries = meta.binaries || [meta.id];
    this.website = meta.website || '';
    this._binary = null;
    this._child = null;
  }

  // Resolve the binary + confirm it launches. Returns { available, binary, detail }.
  async detect() {
    const r = resolveExecutable(this.binaries);
    this._binary = r ? r.binary : null;
    return { available: !!r, binary: this._binary || null };
  }

  // Installed status. `authenticated` is null when we cannot verify without a
  // network/account call (we never claim auth that we haven't confirmed).
  async getStatus() {
    const d = await this.detect();
    if (!d.available) {
      return { available: false, authenticated: false, binary: null, installHint: this.installHint() };
    }
    const auth = await this.checkAuth(d.binary);
    return { available: true, authenticated: auth.authenticated, binary: d.binary, detail: auth.detail };
  }

  installHint() {
    return `Install the ${this.name} CLI and ensure "${this.binaries[0]}" is on your PATH, then run its login command.`;
  }

  // Override: return { authenticated: boolean|null, detail } for an installed binary.
  async checkAuth(/* binary */) {
    return { authenticated: null, detail: 'Installed. Log in via the CLI if this is your first run.' };
  }

  // Override: return an argument array for the task.
  buildArgs(/* { prompt, system, model } */) {
    throw new Error('buildArgs not implemented');
  }

  async runTask({ projectPath, prompt, system = '', model = null, signal = null, onEvent = () => {} } = {}) {
    const d = await this.detect();
    if (!d.available) {
      const err = new Error(`${this.name} CLI not found. ${this.installHint()}`);
      onEvent({ type: 'error', agent: this.id, message: err.message });
      throw err;
    }
    const args = this.buildArgs({ prompt, system, model });
    let output = '';
    const result = await streamProcess({
      binary: d.binary,
      args,
      cwd: projectPath,
      signal,
      onOutput: (line) => { output += line + '\n'; onEvent({ type: 'output', agent: this.id, text: line }); },
      onDiagnostic: (text) => onEvent({ type: 'diagnostic', agent: this.id, text }),
      idleMs: 240000,
    });
    result.output = output;
    return result;
  }

  cancel() {
    if (this._child) { try { this._child.kill('SIGTERM'); } catch {} this._child = null; }
  }
}

module.exports = CodingAgentBase;

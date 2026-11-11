// gemini-agent.js — Google Gemini CLI adapter.
//
// Uses the OFFICIAL `gemini`/`agy` CLI (your free Google account allowance, or a
// Gemini API key). Runs inside the selected project directory and edits files.
// `-p` passes the prompt; `--yolo` auto-approves tool calls so it can write files
// unattended.

const CodingAgentBase = require('./coding-agent-base.js');

class GeminiAgent extends CodingAgentBase {
  constructor() {
    super({
      id: 'gemini',
      name: 'Google Gemini CLI',
      binaries: ['gemini', 'agy'],
      website: 'https://github.com/google-gemini/gemini-cli',
    });
  }

  installHint() {
    return 'Install: npm i -g @google/gemini-cli  (or the Antigravity "agy" CLI). Run it once and sign in with your Google account.';
  }

  buildArgs({ prompt, system = '', model = null, useStdin = false }) {
    const args = [];
    if (!useStdin) {
      // Gemini has no system flag here: system text is merged into the positional prompt.
      const full = system ? `${system}\n\n${prompt}` : prompt;
      args.push('-p', full);
    } // useStdin: the base class writes prompt (+ system, via stdinNeedsSystem) to stdin.
    args.push('--yolo');
    if (model) args.push('--model', String(model));
    return args;
  }

  // Gemini merges the system text into the prompt, so the stdin payload must carry it.
  stdinNeedsSystem() { return true; }
}

module.exports = GeminiAgent;

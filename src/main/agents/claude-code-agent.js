// claude-code-agent.js — Anthropic Claude Code CLI adapter.
//
// Uses the OFFICIAL `claude` binary (your Claude Pro/Max/Ultra subscription — no
// API key, no extra charge). Runs inside the selected project directory and edits
// files there. `-p` selects non-interactive print mode; `--permission-mode
// bypassPermissions` lets it write files without prompting.

const CodingAgentBase = require('./coding-agent-base.js');

class ClaudeCodeAgent extends CodingAgentBase {
  constructor() {
    super({
      id: 'claude',
      name: 'Claude Code',
      binaries: ['claude'],
      website: 'https://github.com/anthropics/claude-code',
    });
  }

  installHint() {
    return 'Install: npm i -g @anthropic-ai/claude-code  (uses your Claude subscription). Run "claude login" in a terminal first.';
  }

  buildArgs({ prompt, system = '', model = null }) {
    const args = ['-p', prompt];
    if (model) args.push('--model', String(model));
    if (system) args.push('--append-system-prompt', system);
    args.push('--permission-mode', 'bypassPermissions');
    return args;
  }
}

module.exports = ClaudeCodeAgent;

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

  buildArgs({ prompt, system = '', model = null, useStdin = false }) {
    // `claude -p` reads the prompt from stdin when piped, so on Windows shim
    // launches the untrusted prompt travels via stdin, never as an argument.
    const args = useStdin ? ['-p'] : ['-p', prompt];
    if (model) args.push('--model', String(model));
    if (system) args.push('--append-system-prompt', system);
    // stream-json (--verbose is required with -p) streams each assistant message
    // as NDJSON instead of buffering everything until completion, so the UI shows
    // live progress and the idle-abort only trips on genuine silence.
    args.push('--output-format', 'stream-json', '--verbose');
    args.push('--permission-mode', 'bypassPermissions');
    return args;
  }

  // Parse one stream-json line into displayable text (or null to suppress it).
  // Raw NDJSON stays in result.output for diagnostics; only clean text reaches
  // the UI event stream.
  parseOutputLine(line) {
    let j;
    try { j = JSON.parse(line); } catch { return line ? line.trim() ? line : null : null; }
    if (!j || typeof j !== 'object') return null;
    if (j.type === 'result' && typeof j.result === 'string') return j.result;
    if (j.type === 'assistant' && j.message && Array.isArray(j.message.content)) {
      const text = j.message.content.filter((c) => c && c.type === 'text' && typeof c.text === 'string').map((c) => c.text).join('');
      return text || null;
    }
    if (j.type === 'assistant' && typeof j.message === 'string') return j.message;
    return null; // system/init/progress/user-tool lines stay out of the UI
  }
}

module.exports = ClaudeCodeAgent;

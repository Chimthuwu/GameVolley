// codex-agent.js — OpenAI Codex CLI adapter.
//
// Uses the OFFICIAL `codex` binary (your OpenAI API key / ChatGPT plan). The agent
// runs inside the selected project directory and is expected to create/edit real
// files there.
//
// FLAG WARNING: the exact non-interactive flags of the Codex CLI change between
// releases. The set below reflects the documented `codex exec` workflow
// (--full-auto for unattended edits). VERIFY against `codex --help` on the
// installed version; if a flag is rejected the process will error and we report it
// honestly instead of faking success.

const CodingAgentBase = require('./coding-agent-base.js');

class CodexAgent extends CodingAgentBase {
  constructor() {
    super({
      id: 'codex',
      name: 'OpenAI Codex',
      binaries: ['codex'],
      website: 'https://github.com/openai/codex',
    });
  }

  installHint() {
    return 'Install: npm i -g @openai/codex  (uses your OpenAI API key — set OPENAI_API_KEY). Then run "codex login" or export the key.';
  }

  buildArgs({ prompt, system = '', model = null }) {
    const args = ['exec', '--full-auto'];
    if (model) args.push('-m', String(model));
    if (system) args.push('--cd', process.cwd(), '-s', system);
    // The task prompt is the trailing positional argument.
    args.push(prompt);
    return args;
  }
}

module.exports = CodexAgent;

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

  buildArgs({ prompt, system = '', model = null, useStdin = false }) {
    const args = ['exec', '--full-auto'];
    if (model) args.push('-m', String(model));
    // The Codex exec CLI has NO system-prompt flag (the old `-s <system>` was
    // invalid and made the CLI reject the whole invocation — Q11). The system
    // text is folded into the task prompt instead. `--cd` was dropped too:
    // runTask already spawns with cwd = the project directory, so pointing at
    // process.cwd() was both redundant and wrong.
    if (!useStdin) args.push(system ? `${system}\n\n${prompt}` : prompt);
    return args;
  }
}

module.exports = CodexAgent;

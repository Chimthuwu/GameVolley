<div align="center">

# 🎮 GameVolley

**Describe a silly game idea. Watch multiple AI agents design, build, review and improve a real, playable game in your workspace — then play it right inside the app.**

[![Download for Windows](https://img.shields.io/badge/Download-Windows%20.exe-blue?style=for-the-badge&logo=windows)](https://github.com/Chimthuwu/Volley-Prompt/releases/latest)
[![License: MIT](https://img.shields.io/badge/License-MIT-purple?style=for-the-badge)](LICENSE)

</div>

GameVolley turns ordinary language into an actual game. Type *"Make me a funny little 3D game about a frog running a terrible pizza restaurant"*, hit **Create Game**, and a Creative Director designs it, a coding agent (Codex, Claude Code or Gemini CLI) writes and edits the real project files, and a Critic reviews the result and sends fixes back — all bounded to a few correction rounds. The finished game runs in an embedded, isolated preview you can play immediately.

The original **VolleyPrompt** prompt generator is still there — it's one tab away in the titlebar.

## How it works

```
USER IDEA
   → Creative Director   (designs a concise brief)
   → Coding Agent        (edits real files in the selected project)
   → Game Preview        (runs the game in an isolated WebContentsView)
   → Critic / QA         (reviews, returns actionable fixes)
   → Coding Agent again  (fixes — up to 3 rounds)
   → Playable result
```

You don't write technical prompts or coordinate agents by hand. **Follow-up instructions work too** — *"make the restaurant bigger, add angry customers, make the pizza explosions more ridiculous"* — GameVolley inspects the live project, modifies its files, reviews, and reloads.

## Features

- **Real local workspace** — projects live on disk; the agent edits actual files you can open in any editor. No prompt text pretending to be code.
- **Real coding agents** — drives installed CLIs (OpenAI Codex, Claude Code, Google Gemini CLI) in the selected project directory. If a CLI is missing, you get a clear install hint instead of fake progress.
- **Embedded playable preview** — an isolated Electron `WebContentsView` renders the genuine game; reload and fullscreen are wired.
- **Checkpoints** — automatic, reversible snapshots (Git stash when available, copy-fallback otherwise) before significant changes, so a bad iteration can't destroy a working build.
- **Honest status** — a live agent-activity panel shows what each role is doing; a working **Stop** button cancels the active process and aborts outstanding AI requests without losing completed work.
- **Provider choice** — pick different providers/models for the Creative Director and Critic; pick your installed coding agent for the Developer.
- **Live theming, images & project folders, encrypted keys** — carried over from VolleyPrompt.

## Getting started

1. Install at least one coding agent CLI (GameVolley will tell you which are missing):
   - `npm i -g @openai/codex`  (Codex)
   - `npm i -g @anthropic-ai/claude-code`  (Claude Code)
   - `npm i -g @google/gemini-cli`  (Gemini)
2. Grab the installer from [Releases](https://github.com/Chimthuwu/Volley-Prompt/releases/latest), or run from source:

```bash
git clone https://github.com/Chimthuwu/Volley-Prompt.git
cd Volley-Prompt
npm install
npm start        # launch GameVolley
npm run dist     # build a Windows installer
```

3. Open **Settings** and connect a provider for the Creative Director / Critic (OpenRouter, Anthropic, Gemini CLI, or Ollama).
4. Type an idea, hit **Create Game**.

## Notes & limitations

- The game-build loop needs a configured AI provider and at least one coding-agent CLI installed and authenticated. With neither, GameVolley reports the gap honestly rather than faking a result.
- The acceptance flow (idea → playable game) is genuinely wired end-to-end; running it with real providers requires your credentials and CLIs (not present in CI/tests, which use mocks).

## Privacy

API keys are encrypted on-disk via the OS keychain (`safeStorage`). Your game projects stay local; nothing is pushed to a remote unless you choose to share it.

## Stack

Electron + vanilla JS/HTML/CSS. No UI frameworks. New execution layer under `src/main/`; the original VolleyPrompt UI lives in `renderer/app.js` and remains accessible.

## License

MIT

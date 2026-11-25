<div align="center">

# 🎮 GameVolley

**Describe a silly game idea. Watch multiple AI agents design, build, review and improve a real, playable game in your workspace — then play it right inside the app.**

[![Download for Windows](https://img.shields.io/badge/Download-Windows%20.exe-blue?style=for-the-badge&logo=windows)](https://github.com/Chimthuwu/GameVolley/releases/latest/download/GameVolley-Windows-Setup-v1.3.0.exe)
[![Download for macOS](https://img.shields.io/badge/Download-macOS%20.dmg-lightgrey?style=for-the-badge&logo=apple)](https://github.com/Chimthuwu/GameVolley/releases/latest/download/VolleyPrompt-macOS-v1.3.0.dmg)
[![Download for Linux](https://img.shields.io/badge/Download-Linux%20AppImage-orange?style=for-the-badge&logo=linux)](https://github.com/Chimthuwu/GameVolley/releases/latest/download/VolleyPrompt-Linux-v1.3.0.AppImage)
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
   → Validation Gate     (entry refs, syntax, optional build, runtime health)
   → Critic / QA         (reviews, returns actionable fixes)
   → Coding Agent again  (fixes — up to 3 rounds)
   → Playable result
```

You don't write technical prompts or coordinate agents by hand. **Follow-up instructions work too** — *"make the restaurant bigger, add angry customers, make the pizza explosions more ridiculous"* — GameVolley inspects the live project, modifies its files, reviews, and reloads.

## Features

- **Real local workspace** — projects live on disk; the agent edits actual files you can open in any editor. No prompt text pretending to be code.
- **Real coding agents** — drives installed CLIs (OpenAI Codex, Claude Code, Google Gemini CLI) in the selected project directory. If a CLI is missing, you get a clear install hint instead of fake progress.
- **Embedded playable preview** — an isolated Electron `WebContentsView` renders the genuine game; reload and fullscreen are wired.
- **Checkpoints** — automatic, reversible snapshots (file-copy + hash manifest, stored outside the project) before and between rounds; failed iterations roll back and validation failures feed the next round.
- **Honest status** — a live agent-activity panel shows what each role is doing; a working **Stop** button cancels the active process and aborts outstanding AI requests without losing completed work.
- **Provider choice** — pick different providers/models for the Creative Director and Critic; pick your installed coding agent for the Developer.
- **Live theming, images & project folders, encrypted keys** — carried over from VolleyPrompt.
- **Device sync (Settings → Device sync)** — pair the desktop app with the web app using a 22-character code (copy/paste or QR). Settings, presets, model pairs and volley history merge per section; the profile is encrypted end-to-end and API keys are never synced.
- **Send to ▸** — hand the finished prompt to Cursor, Claude Code, Cline, VS Code or Hermes. Hermes starts locally as a direct CLI run — no Discord message is involved.
- **Scaffold** — have the Writer emit a file manifest, let the reviewer check it, preview it, then write a ready folder (with `PROMPT.md` and an actionable `todo.md` handoff). Desktop writes to a folder you pick; web uses the File System Access API or downloads a ZIP.

## Web, sync and handoff

The web build (same UI, served from `site/`) needs no backend for prompting — calls go straight to the provider. Optional pairing adds a Cloudflare Pages Functions backend in `functions/` (KV for the opaque profile, R2 for oversized run bodies). The server never sees the pairing code, the derived key, or plaintext data. See [functions/README.md](functions/README.md) for the bindings and [docs/SHARED-FRONTEND.md](docs/SHARED-FRONTEND.md) for how one source tree emits both bundles.

## Getting started

1. Install at least one coding agent CLI (GameVolley will tell you which are missing):
   - `npm i -g @openai/codex`  (Codex)
   - `npm i -g @anthropic-ai/claude-code`  (Claude Code)
   - `npm i -g @google/gemini-cli`  (Gemini)
2. Grab the installer from [Releases](https://github.com/Chimthuwu/GameVolley/releases/latest), or run from source:

```bash
git clone https://github.com/Chimthuwu/GameVolley.git
cd GameVolley
npm install
npm start        # launch GameVolley
npm run dist     # build a Windows installer
```

3. Open **Settings** and connect a provider for the Creative Director / Critic (OpenRouter, Anthropic, Gemini CLI, or Ollama).
4. Type an idea, hit **Create Game**.

## Artifacts

| Platform | Artifact name | Notes |
|----------|---------------|-------|
| Windows | `GameVolley - Windows Setup v<version>.exe` | NSIS installer, per-user or system install |
| macOS   | `VolleyPrompt - macOS v<version>.dmg` | Notarized DMG, runs on Apple Silicon & Intel |
| Linux   | `VolleyPrompt - Linux v<version>.AppImage` | Single-file executable, no install needed |

All artifacts are built by GitHub Actions on every tag push. See [STYLING.md](STYLING.md) for the design system used across the app.

## Notes & limitations

- The game-build loop needs a configured AI provider and at least one coding-agent CLI installed and authenticated. With neither, GameVolley reports the gap honestly rather than faking a result.
- The build pipeline is wired end-to-end with an execution-level validation gate (entry references, JS syntax, optional build, embedded-preview runtime health) plus a Critic review — but end-to-end runs need your real credentials/CLIs and are not exercised in CI, which uses mocks. If a project defines `npm run build`, that script runs with your user privileges (timeout + output cap are damage limiters, not a sandbox).

## Privacy

API keys are encrypted on-disk via the OS keychain (`safeStorage`). Your game projects stay local; nothing is pushed to a remote unless you choose to share it.

## Stack

Electron + vanilla JS/HTML/CSS. No UI frameworks. New execution layer under `src/main/`; the original VolleyPrompt UI lives in `renderer/app.js` and remains accessible.

## License

MIT

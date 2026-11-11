# GameVolley

GameVolley is an AI game-development studio built on top of the existing VolleyPrompt
Electron app. The original VolleyPrompt prompt generator remains one tab away;
GameVolley is the default landing workspace.

## The experience

1. Type a plain-English game idea (e.g. *"a frog running a terrible pizza restaurant"*).
2. Hit **Create Game**.
3. A **Creative Director** AI turns the idea into a concise development brief.
4. A **coding agent** (OpenAI Codex, Claude Code, or Google Gemini CLI) edits real
   files in the selected project directory.
5. The game loads in an **embedded, isolated preview** (`WebContentsView`).
6. A **Critic / QA** AI reviews the result and returns concrete, actionable fixes.
7. The coding agent applies fixes, up to **3 correction rounds** by default.
8. The playable game is presented; **follow-up instructions** (*"make it bigger, add
   angry customers"*) modify the live project and reload.

## Roles

| Role | What it is | Backend |
|---|---|---|
| Creative Director | Designs the brief from the idea | Any chat provider (OpenRouter/Anthropic/Gemini/Ollama) |
| Developer | Edits real project files | Coding-agent CLI adapter |
| Critic / QA | Reviews and returns fixes | Any chat provider |

Each role can use a different provider/model. The Developer role selects from the
coding-agent CLIs that are actually installed on the machine.

## Honesty guarantees

- If a coding-agent CLI is not installed, GameVolley reports it (with an install hint)
  rather than faking a build.
- If no AI provider is configured, the workflow stops with a clear message.
- A model returning code text is never treated as a file actually being edited; the
  project directory is the source of truth.
- The AI loop is bounded (max 3 correction rounds) so it cannot run forever.

See `docs/ARCHITECTURE.md` for the module layout and verification status.

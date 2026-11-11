# Architecture

GameVolley extends VolleyPrompt without disturbing its existing prompt-generator
functionality. New responsibilities live in `src/main/` (main process) and are exposed
to the renderer through the existing `pv` IPC bridge.

## Main process (`src/main/`)

| Module | Responsibility |
|---|---|
| `project-manager.js` | Real filesystem workspace over a selected project directory. Create/open/list/read/write/delete files, detect entry points, compute compact summaries. All paths validated against the project root (no traversal, no absolute escape). `.env*` and heavy/junk dirs are ignored. |
| `checkpoint-manager.js` | Reversible snapshots before significant AI changes. Git `stash push -u` when the project is a git repo; otherwise a copy fallback into `.gamevolley/checkpoints/`. Never touches history, branches, or remotes. |
| `preview-manager.js` | Embedded game preview via `WebContentsView`. Local HTML games are served by an isolated static HTTP server over `http://127.0.0.1`; framework games run their dev server. `safeJoin` refuses path traversal. Lazy-requires Electron so it is unit-testable in plain Node. |
| `agents/executable-resolver.js` | Reliable Windows-aware resolver: probes `bin`, `bin.cmd`, `bin.bat`, `bin.exe` via `spawnSync`, no shell strings. |
| `agents/agent-process.js` | Spawns a CLI in the project dir, streams stdout/stderr, enforces an idle timeout (default 180s), honours `AbortController`. |
| `agents/coding-agent-base.js` | Shared adapter: `detect()` confirms the CLI is installed; `runTask()` throws a clear error if not. |
| `agents/codex-agent.js`, `claude-code-agent.js`, `gemini-agent.js` | Per-CLI adapters. Each builds an argument array (never a shell string) and reports output/errors/exit status. |
| `agents/agent-manager.js` | Orchestration: Creative Director → Developer → Preview → Critic → (bounded) fix loop → final result. Emits `agent:status`, `project:changed`, `preview:*` events. Cancellable. |

## IPC surface (every `pv.*` must pair with an `ipcMain.handle` — see `test/ipc-contract.test.js`)

`project:create/open/active/listFiles/readFile/writeFile/deleteFile/summary/entry/openFolder`,
`checkpoint:list/restore/remove`, `dialog:openDir`, `agent:codingStatus/start/cancel`,
`preview:load/reload/setBounds/fullscreen/close`.

## Renderer (`renderer/`)

- `index.html` — adds **GameVolley** / **Volley** titlebar tabs and the `#gameRoot`
  workspace. Body classes `view-game` / `view-volley` switch the active surface.
- `gamevolley.js` / `gamevolley.css` — the workspace: idea composer, role selects,
  Create/Improve/Fix, agent-activity panel, preview controls. Talks only through `pv`.
- `app.js` / `style.css` — unchanged VolleyPrompt logic, with a `google → gemini`
  settings migration so legacy users keep working.

## Provider identity

The canonical Gemini id is `gemini` (not the legacy `google`). Credential loading and
renderer settings migrate `google` → `gemini` transparently.

## Verification status

- **Unit tests** (Node `node --test`): project-manager, checkpoint-manager,
  agent-manager (mocked), preview, provider id consistency, Volley smoke, GameVolley
  smoke, and the hard `pv ↔ ipcMain.handle` contract — all passing.
- **Real end-to-end acceptance** (idea → playable game) requires a configured AI
  provider and at least one installed/authenticated coding-agent CLI. Those paths are
  wired and event-complete but are exercised by the user's machine, not CI.

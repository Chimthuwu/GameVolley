# GameVolley — Repair Report (2026-11-12)

Commits: `1d874f9` (P0+P1) and `e9b7e1c` (P2+P3), pushed to `Chimthuwu/GameVolley` (main).

## 1. Audited defects — verification results

| # | Verdict | Evidence (before the fix) |
|---|---------|---------------------------|
| 1 | **Confirmed** | `src/main/checkpoint-manager.js` L75: `git stash push -u` moved the user's uncommitted work out of the tree. Copy fallback `copyDir` (L86-88) copied into the project but restore (L121-124) never deleted files created after the checkpoint. |
| 2 | **Confirmed** | `src/main/agents/agent-manager.js` L163-166 (old): catch emitted `agent:status error` and rethrew — no restore. |
| 3 | **Confirmed** | `src/main/agents/provider-dev-agent.js` L89-99 (old): `writeFile` per file inside the loop; a late failure left a half-changed project. |
| 4 | **Confirmed** | Old `agent-manager.js` L210/L214-215: `passed` = Critic SHIP/CLOSE with no HIGH/MED; no execution validation existed anywhere. |
| 5 | **Confirmed** | `preview-manager.js` emitted `preview:ready`/`preview:console` (old L122-126) into the app's event sink; `agent-manager` only called `hooks.loadPreview` (L181) and never consumed them. |
| 6 | **Confirmed** | Old `provider-dev-agent.js` L30/L83-87: one regex, prose-only → `AI returned no file blocks`, no recovery, raw response discarded. Also: the regex matched complete pairs only, so a truncated trailing file was **silently dropped** (worse than reported). |
| 7 | **Partly wrong** | `main.js` L951 already clamped `maxRounds` at the IPC boundary (`Math.min(6, Math.max(1, Math.floor(Number(cfg.maxRounds) || 3)))`) — added earlier. But `AgentManager` itself accepted any caller value unclamped. Fixed at the library level too. |

## 2. New defects found

- `PreviewManager.loadProject` started a new static HTTP server per call without closing the previous one — one leaked server (and port) per round. **Fixed** in `e9b7e1c`.
- Old `parseFiles` silently dropped a truncated trailing file block (partial acceptance). **Fixed** — unbalanced markers reject the whole response.
- Old provider path check used `f.path.includes('..')` (false positives like `a..b.js`, misses UNC). **Fixed** via `resolveInside`.

## 3. Files changed

- **New** `src/main/lib/safe-path.js`, `parse-files.js`, `commit-files.js`, `diagnostics.js`, `validate-project.js`
- **Rewritten** `src/main/checkpoint-manager.js`, `src/main/agents/provider-dev-agent.js`, `src/main/agents/agent-manager.js`
- **Modified** `src/main/preview-manager.js`, `main.js`, `README.md`
- **Tests** new `tests/safe-path.test.js`, `tests/parse-files.test.js`, `tests/execution-gate.test.js`; updated `tests/provider-dev-agent.test.js` (real tmp fs, recovery semantics)

## 4. Fixes and deviations from the guide

All implemented per the guide with these deliberate deviations:

1. **`parseFiles` returns `{ files, format, error }`, not a bare array** — the recovery path needs the error string and the strict parser must distinguish formats.
2. **Recovery writes the round's lastGood restore into `runTask` via a `restore` callback** (passed by the orchestrator) rather than creating checkpoints inside the agent — the orchestrator owns checkpoint lifecycle.
3. **`waitForPreview` listens to `preview:fail`** (added to `preview-manager` on `did-fail-load`) rather than reusing `preview:error`, because `preview:error` also fires for blocked navigation, which is not a load failure.
4. **`PreviewManager` gained an `on/off` listener registry** — it isn't an EventEmitter, so validate-project couldn't subscribe otherwise.
5. **Old checkpoints are not migrated**: legacy `.gamevolley/checkpoints/` copies and old git stashes stay on disk but are no longer listed (storage moved outside the project). Documented in the module header.
6. **Guide's `restore(projectPath, cp)` API changed to `restore(projectPath, id)`** (same as the old public API, so `main.js` IPC handlers keep working unchanged).
7. Validation runs **after** the per-round preview reload and additionally calls `preview.reload()` itself, so it never reads stale state.

## 5. Tests added (93/93 pass, real output)

```
ℹ tests 93
ℹ pass 93
ℹ fail 0
ℹ duration_ms 2950.7089
```

New coverage: canonical/fenced/truncated/prose parsing; path safety (incl. UNC, `a..b.js` false-positive case); clampRounds table (NaN, '2', 2.9, 100→5); staged-write mid-copy failure restores (and preflight failures do NOT restore); checkpoint restore removes post-checkpoint files and hash-restores damaged ones; validation failure never yields `completed:true` even with a SHIP verdict; developer crash restores baseline; final-round failure restores round-N-valid; runtime check fails on error-level console, ignores favicon 404, times out instead of hanging; guidelines present in the developer prompt.

## 6. Type check and build — honest output

- **No type check exists**: GameVolley is plain JavaScript (no `tsc`, no `jsconfig`). The guide's "run the type check" is not applicable; as a substitute every `src/main/**/*.js`, `main.js`, `preload.js` was run through `node --check` — all pass (`SYNTAX_OK`).
- **`npm run build` does not exist** in `package.json` (`npm error Missing script: "build"`); the packaged build is `npm run dist` (electron-builder, Windows NSIS). Not run here — packaging is unchanged by these commits and takes a full Electron-builder run; nothing in the `files` list changed except adding `src/**` which is already shipped.
- Gate evidence: `npm test` (node --test) — 93/93.

## 7. Not verified live

- Real provider calls (OpenRouter/Anthropic/etc.) — all provider interactions are mocks.
- Real coding-CLI launches (Codex/Claude Code/Gemini) and their filesystem effects.
- Electron UI interaction: the embedded `WebContentsView` runtime path, `preview:ready` in a real window, and the renderer's stage rendering of new `stage`/`validation:failed` events (renderer `gamevolley.js` was not modified; new event types are additive and it already renders unknown events as activity log lines — not verified in a running app).
- The `userData` checkpoint path wiring (verified by reading; unit tests use tmp dirs).

## 8. Remaining issues

- **Build-step trust limitation** (documented in README + code): when a generated project defines `npm run build`, validation executes it with the user's privileges. The timeout (120 s) and output cap are damage limiters, not a sandbox. `runBuildStep: false` disables it; a settings toggle is still to be wired in the UI.
- **Empty directories are not tracked** by checkpoints (documented in `checkpoint-manager.js`).
- Checkpoint storage is full file-copy per round — fine for small game projects, heavy for big ones; incremental snapshots would be a future improvement.
- `npm run dev` projects (devserver entries) get syntax + checklist validation only when the dev server URL is reachable; `waitForPreview` requires the preview view to actually load that URL.
- Renderer stage UI (`STAGES` list) not yet rendered as a dedicated progress panel (events are emitted; UI polish tracked in todo 3.6).
- Legacy checkpoints (old `.gamevolley/checkpoints/` copies, old git stashes from previous sessions) remain on disk but are unlisted.

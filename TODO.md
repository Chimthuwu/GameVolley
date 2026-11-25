# GameVolley — Repair & Studio UX (active)

Spec: Z:\HERMES\.hermes\attachments\pasted_content_2026-11-11_19-03-37-193_209f53.txt (full text there).

## AUDIT (2026-11-24) — app was broken, now fixed + verified; A1 still has real follow-up work

Ground truth from inspecting the actual code and running the test suite, not from the `[x]` labels below — several of which describe real, working code, confirmed independently (see 0.4).

### 0.1 — [x] FIXED: `escapeHtml` syntax error crashed renderer + site
`src/shared/app-core.js` had a leftover, broken duplicate `escapeHtml` (an HTML-entity map with `"'": '''` — three literal quote chars, a `SyntaxError`). Replaced with a correct standalone implementation (see 0.2 for why it needed to stay standalone rather than deferring to the platform files' own copy).

### 0.2 — [x] FIXED: A1 "unified frontend" concatenation crashed on duplicate top-level identifiers
`npm run build:shared` concatenates `src/shared/app-core.js` with `src/renderer/app.js` (→ `renderer/app.js`) and with `src/web/app.js` (→ `site/app.js`). `src/renderer/app.js` still has its own full copies of 51 of `app-core.js`'s 53 top-level identifiers (`store`, `applyTheme`, `loadPairs`, `addAttachmentFiles`, etc.) — same for `src/web/app.js` (46/53). Concatenation → `const store = {...}` declared twice in one scope → hard `SyntaxError`, renderer and site both failed to load entirely (confirmed via `node -c` and `tests/smoke.test.js`: 0 provider cards rendered).
- **Investigated deleting the duplicates from the platform files first** (the originally-planned fix) — **rejected**: a direct AST diff (via the `typescript` package, comparing top-level statements) showed several of `app-core.js`'s versions are not straight extractions but a *simpler* parallel implementation — e.g. `renderAttachments` in `src/renderer/app.js` also handles `pendingFolders`, which `app-core.js`'s version doesn't. Deleting the platform copies in favor of `app-core.js`'s would have silently dropped that feature.
- **Fix applied instead**: wrapped `src/shared/app-core.js`'s body in an IIFE, so none of its identifiers leak into the shared script scope the platform file is concatenated into — the only thing it still exposes is `window.__vpShared` (confirmed unused anywhere else in the codebase today, so this is a no-op risk-wise; it exists for `gamevolley.js` to adopt later, which currently has its own inline copies of what it needs, e.g. its own `escapeHtml`). This fixes the crash with zero behavior change to either platform's actual UI.
- **Still real follow-up work** (this is what A1's unchecked checkboxes below should mean going forward): `app-core.js` is not yet true shared code — it's a parallel, simpler reimplementation that only `gamevolley.js` could safely adopt today. Properly finishing A1 means diffing each duplicated function for real behavioral differences (not just text), porting any feature gaps (e.g. `pendingFolders` handling) into `app-core.js`, then actually deleting the platform-file copies — not blindly, function by function, with a test/manual pass after each.
- Verified: `npm run build:shared && node -c renderer/app.js && node -c site/app.js` → both parse clean. `npm test` → 93/93 pass (`tests/smoke.test.js` now renders all 5 provider cards). `npm run test:e2e` → real Electron app launches, loads history, right-click menus, rename/move/delete on volleys and folders — all pass end-to-end, not just "parses."

### 0.3 — [x] FIXED: unrelated real regression in `lib/providers.js`
`OllamaProvider.getStatus()` only returned `authMethod: 'Local (no auth)'` on the success branch — if the `fetch` to `localhost:11434` failed or 404'd (e.g. Ollama not running, true in CI/most dev machines), it returned `{ connected: false }` with `authMethod` missing entirely. `authMethod` describes the auth *mechanism*, not whether the service happens to be reachable right now, so it should always be present. Fixed to return it in both branches.

### 0.4 — Re-verified against actual code (not just commit messages) — genuinely solid, no action needed
Confirmed by reading the source + passing tests, not just trusting the `[x]`:
- Checkpoint/snapshot manager (1.3): snapshot+diff, create/modify/delete detection — tests pass.
- Project-manager path safety (2.2): traversal rejected, protected-file writes refused, delete requires explicit flag — tests pass.
- Preview server hardening (1.2): traversal/symlink-escape/hidden-file blocking — tests pass.
- Provider-dev strict parser (2.5): rejects truncated blocks, one-shot recovery, refuses path escapes — tests pass.
- Windows shim spawn handling (1.4): quoting, `.cmd`/`.bat` resolution — tests pass.
- No TODO/FIXME/HACK debt markers found in `main.js`/`preload.js`/`src/lib`; no new path-traversal or command-injection issues found beyond what's already covered by tests.

### 0.5 — Still open exactly as flagged below, re-confirmed
2.3 (readiness checks vs fixed delays, dev-server detection, app-quit cleanup), 3.4 (auto-pick UI semantics), the 30s OpenRouter timeout BUG, live-key smoke test, and site deploy `[!]` — all still genuinely unfinished, no new code found for any of them.

### Priority order from here
1. ~~Get the app loading and tests green again~~ — done this session (0.1–0.3); `npm test` is 93/93 and the real Electron e2e passes.
2. **A1 proper** — see 0.6 below for the actual per-function breakdown from this session's investigation; don't re-derive it from scratch.
3. Then resume the pre-existing P1/P2/Workstream-A/B backlog below.

### 0.6 — A1 follow-up: safe duplicates actually collapsed (2026-11-25, part 3)
Picked this back up and did the real collapse, not just the investigation. Key realization that part 2 (below, preserved for the "why") missed: **`app-core.js`'s IIFE wrapper hides its declarations from the platform files.** So "delete the platform file's copy, keep app-core.js's" only works for names that are declared *outside* the IIFE. Fix applied:
- Moved the **27 identifiers confirmed byte-identical (or cosmetic-only) against BOTH `src/renderer/app.js` and `src/web/app.js`** out of `app-core.js`'s IIFE to top-level scope: `store`, `SETTINGS_KEY`, `loadSettings`, `saveSettings`, `MODEL_ROWS`, `PAIRS_KEY`, `RECOMMENDED_PAIRS`, `loadPairs`, `storePairs`, `prettyModel`, `PRESETS_KEY`, `loadPresets`, `IMAGE_EXT`, `extOf`, `pendingAttachments`, `contextTarget`, `ALLOWED_EXT`, `MAX_FILES`, `attachmentIdSeq`, `formatSize`, `isDuplicateFile`, `removeAttachment`, `VISION_MAX_FILE_BYTES`, `VISION_MAX_DIM`, `imagesScaled`, `closeContextMenu`, `readFileAsDataURL`, `readFileAsText`.
- Deleted the now-redundant duplicate declarations of those same 27 names from both `src/renderer/app.js` and `src/web/app.js` — they're sourced from `app-core.js` alone now, for real, in the built bundle.
- Did **not** touch `MODEL_ROWS_BY_INPUT`/`PROVIDER_LIST`/`PROVIDER_MODEL_CACHE`/`PROVIDER_PAIRS`/`loadProviderModels`/`applyProviderToField` even though they're identical for renderer vs app-core — web's `app.js` doesn't declare them at all (no provider-pairs feature on web), so moving them to app-core's top level would silently add unused globals to the web bundle. Left as renderer-only for now; revisit if web ever gets that feature.
- Left the 10 genuinely platform-divergent items (`MAX_FILE_BYTES`, `THEME_BASE_HSL`, `THEME_SURFACE_HSL`, `applyTheme`, `setupModelAutocomplete`, `STARTER_PRESETS`, `escapeHtml`, `addAttachmentFiles`, `renderAttachments`, `runHistoryAction`) exactly as documented in part 2 below — still duplicated-but-functional dead weight inside `app-core.js`'s IIFE, still fully authoritative in the platform files. Not revisited this pass.
- Verified: `node -c` on all three built bundles, `npm test` 93/93, and a real `npm run test:e2e` Electron run — all pass.

### 0.6a — A1 follow-up investigation (2026-11-24, part 2): exactly which duplicates are safe to collapse
Used an AST diff (the TypeScript compiler's parser, comparing each top-level statement) rather than eyeballing text, across `src/shared/app-core.js` vs `src/renderer/app.js` (51 shared names) and vs `src/web/app.js` (46 shared names). Important: **this cleanup is no longer urgent** — 0.1/0.2 already fixed the actual crash by wrapping `app-core.js` in an IIFE, so these duplicates no longer collide; this is now a code-quality pass, not a blocker. Findings, so the next pass doesn't redo this analysis:

- **~45 identifiers per platform are genuinely identical or purely cosmetic** (comment/formatting-only, or the `$('x')` helper vs `document.getElementById('x')`) — e.g. `store`, `toast`, `loadSettings`/`saveSettings`, `loadPairs`/`storePairs`, `refreshPairSelect`, `diffOps`/`renderLineDiff`, `enhanceSelect`, `askText`/`askConfirm`, `contextMenu` wiring, `downscaleForVision`, `readFileAsDataURL`/`readFileAsText`. 27 of these (the subset identical for *both* platforms) were actually collapsed in 0.6 above; a handful more are renderer-only identical (see 0.6's note on provider-pairs) and remain undone.
- **A real bug found and fixed this session**: `src/renderer/app.js`'s `addAttachmentFiles` rejected oversized files with `"(over 25 MB)"` even though its actual enforced limit (`MAX_FILE_BYTES`) is 64 MB — found by diffing against `app-core.js`'s copy, which had the correct text. Fixed (commit after this one).
- **Several are genuinely, intentionally platform-divergent — do NOT collapse these, ever, without redesigning around the difference:**
  - `MAX_FILE_BYTES`: 64 MB on desktop, 25 MB on web (presumably a Cloudflare Pages Function payload cap) — this is a real platform constraint, not drift.
  - `THEME_BASE_HSL` / `THEME_SURFACE_HSL`: web's color tuning (saturation/lightness values) is deliberately different from desktop's.
  - `applyTheme`: web's version is a simplified subset — no "contrast" slider math at all, vs desktop's full hue/sat/contrast logic. Web apparently doesn't expose a contrast control.
  - `renderAttachments` / `addAttachmentFiles` (desktop-vs-shared only): desktop's version also renders/manages `pendingFolders` (the Project Context Explorer / GitHub-import folder chips) — a whole feature `app-core.js`'s simpler version doesn't have.
  - `runHistoryAction`: desktop keeps `currentHistoryName` as a plain module-scope variable; a hypothetical shared version using `window.currentHistoryName` would be touching a *different* variable, not the same state.
  - `setupModelAutocomplete`, `STARTER_PRESETS`, `escapeHtml` (web variant touches line-ending/formatting artifacts more than substance, re-verify before trusting this one specifically): also flagged as real (non-cosmetic) diffs for web; not individually dug into this session, so re-check before assuming they're safe to merge.
- **Attempted once this session, reverted**: tried removing the 10 non-shared items above from `app-core.js` itself (since they aren't actually shared) — broke other still-shared functions inside `app-core.js` that call them internally (`refreshPresetSelect` needs `STARTER_PRESETS`, `diffOps`/`renderLineDiff` need `escapeHtml`, the context-menu wiring calls `runHistoryAction`). Reverted rather than chase it further at low effort — `app-core.js` is currently dead code (nothing consumes `window.__vpShared` anywhere in the codebase yet), so leaving it internally duplicated-but-functional is harmless; just don't trust it as a drop-in replacement for the platform files' richer versions until this is sorted out properly.
- **Recommended real fix, for whoever picks this up next**: don't try to make `app-core.js` the single source of truth for functions that are legitimately platform-specific. Instead split it into (a) truly-shared utilities (done in 0.6 above for the 27 safe-for-both ones), and (b) leave the platform-divergent ones alone entirely, removed from `app-core.js`'s body *and* from `window.__vpShared`'s export list, with their internal callers (`refreshPresetSelect`, `diffOps`, the context-menu handler) adjusted to not assume those functions exist in that scope, or just left as platform-only code not exposed via `__vpShared` at all until `gamevolley.js` actually needs them.

## P0 — critical
- [x] 1.1 [DONE a0d9f03] npm ci sync (lockfile missing jsdom deps) + CI: Node 22 deploy, tests gate deploy, keep win/mac/linux builds
- [x] 1.2 [DONE this commit] Preview server hardening + HTTP security tests (secrets/hidden/symlink/traversal, keep assets working)
- [x] 1.3 [DONE 1d874f9] Checkpoint rewrite: file-copy + sha256 manifest, snapshots OUTSIDE project (userData), restore deletes post-checkpoint files + hash-restores; git-stash path removed entirely
- [x] 1.4 [DONE this commit] Windows shim process execution (.cmd/.bat via proper spawn, array args, cleanup, no orphans)
- [x] 1.5 [DONE earlier commit + e9b7e1c clampRounds] False-success: non-zero CLI exit ≠ success; malformed Critic verdict ≠ pass; maxRounds IPC validation

## P1 — reliability
- [x] 2.1 [DONE this commit] Immutable project context per build (prevent cross-project writes mid-build)
- [x] 2.2 [DONE this commit] realPath validation in project-manager (symlink escapes on read/write/delete/list/snapshot)
- [x] 2.3 [partial e9b7e1c] loadProject closes the previous static server (leak fixed); on/off listeners + preview:fail added for the validation gate. Remaining: readiness checks vs fixed delays, dev-server detection, app-quit shutdown cleanup
- [x] 2.4 [DONE e9b7e1c] Verification stage before Critic (validate-project.js: entry refs, syntax, optional build, preview runtime health); completed:true requires gate pass; verifiedFixes comes from validation checks only
- [x] 2.5 [DONE 1d874f9] provider-dev: strict parser rejects truncated/unbalanced blocks whole; one-shot format recovery w/ diagnostics saved; staged all-or-nothing writes with restore callback

## P2 — UI/UX
- [x] 3.1 [DONE this commit] Studio layout (explorer/viewport/agent-studio), fix 100vh+34px overflow, fullscreen bounds persist
- [x] 3.2 [DONE this commit] Agent cards (status, elapsed, expandable output)
- [x] 3.3 [DONE this commit] Changes & Diff panel (real data only)
- [x] 3.4 partial: auto-pick prefers free (pickAutoModel); explicit auto/prefer-free UI semantics still open
- [x] 3.5 [DONE this commit] Explorer tree (expand/collapse, icons, search, lazy)
- [x] 3.6 [DONE this commit] Activity panel (role filter, search, clear, bounded)
- [x] 3.7 [DONE this commit] Visual polish (reduced-motion, restrained accent)

## Docs/distribution
- [x] README links → Chimthuwu/GameVolley; mac/linux artifact names; STYLING.md; docs reflect reality

## Done
- [x] Model pickers all roles, prov:<id> AI developer, duplicate-dropdown + unified-list fixes, auto-pick prefers free (2d77775)

---

# VolleyPrompt — Architecture TODO (historical, pre-GameVolley)

> This file supersedes the old plain TODO (its status is preserved at the bottom under **"Where we already are"**).
> Two new workstreams: **(A) web ⇄ desktop sync with accounts**, and **(B) a "hand the finished prompt off" feature** (deep-link + an agentic Scaffold mode).

---

## TL;DR — the two decisions you asked me to weigh in on

**Accounts / login:** Do **not** start with Google. Your real goal today is *"sync my desktop install to the web app"*, not *"I have a SaaS with users and billing."* The cheapest, fastest, zero-PII way is exactly what you intuited: **a pairing secret (a high-entropy "hash")**. Press **Pair** on one device → it shows a **URL-safe base64 code** (plus a QR); paste it on the other; both read/write the same **encrypted** blob in a key-value store keyed by `sha256(secret)`. No email, no password, no OAuth app to register, no user-management screen, and the server **cannot read your data** (encrypted client-side with a key derived from the secret). Backend stays on Cloudflare — no third-party vendor in the data path.

Google login is **better later**, when you want *recoverable, multi-device, real accounts* (fresh machine, no code, history still comes back). Build storage so the pairing secret is just an *anonymous account id*, and Google sign-in is **another way to claim that same id**. Today `user_id = sha256(secret)`; tomorrow `user_id = google_sub`, and a signed-in Google user enters a pairing code to **migrate** their hash-account under their email. **Ship the hash now — same table row a Google account reuses later.** One backend, two ways into identity, no rewrite.

Hard rule: **the OpenRouter API key never syncs to the server.** It stays device-local as today (desktop = OS keychain `key.bin`; web = `localStorage['vp_api_key']`). Sync *settings, presets, model pairs, run history* — not the credential. Key-in-the-cloud = real OAuth + at-rest crypto review = its own milestone. Don't let a shared secret hash unlock your credit balance.

**Handoff feature:** do **both**. The button next to *Copy prompt* that "sends it to Hermes/Claude/Cursor" is nearly free (deep links) — **do it first**. But the bigger idea — *use the same Writer+Reviewer pair to scaffold a folder, prep it for the other coding agents, optionally get a head-start, and emit a `todo.md` handoff, depth driven by the existing "cycles" slider* — is the real feature, and **yes, it makes sense and it's the right shape.** It turns VolleyPrompt from "write a good prompt" into "start the project." One constraint to design around up front: **a browser cannot silently create a folder of files on your disk.** So Scaffold is **desktop-first**; on web it uses the Chromium **File System Access API** (`showDirectoryPicker`, Chrome/Edge), falls back to a **`.zip`** download, or writes into the synced blob and the desktop materializes it (ties to A).

---

## Where things are now (the real starting line)

- **Two front-ends that have already diverged.** `renderer/app.js` (Electron) and `site/app.js` (web) are ~96–98 KB copies of the same UI. Sync is hard **because the codebase is forked**, not because there's no backend. Unifying first makes everything below cheap.
- **The seam already exists.** `preload.js` (desktop) and `site/pv.js` (web) both expose the same `window.pv` bridge; `app.js` is written against it. That's the adapter we extend — no UI rewrite to add sync.
- **Web is static-only.** `wrangler.jsonc` serves `./site` as Cloudflare Pages *assets*. No Pages Functions/Workers backend, no datastore, no auth. Sync needs all three.
- **State is local only.** Keys: `vp_api_key`, `vp_history`, `vpSettings`, `vpPresets`, `vpModelPairs`, loose composer keys (`author`,`critic`,`rounds`,`idea`,`auto`, theme hue/sat/contrast); desktop also keeps runs on disk in `Documents/VolleyPrompt/`. None leaves the device.

---

## Workstream A — Synced accounts (web ⇄ desktop)

### A1. Unified frontend (do first — it's the tax on everything)
- [~] Make `renderer/` and `site/` share **one** source for `app.js`/`store.js`/styles (build step emits both, or web loads the same files Electron uses). Kill the hand-copied fork.
  - [x] Build infrastructure: src/ structure, build-shared.mjs, package.json hooks for dist/site:deploy
  - [ ] Extract common code to src/shared/app-core.js and src/shared/style.css
  - [ ] Add conditional compilation for platform-specific code
- [ ] Confirm `window.pv` is the *only* environment-specific surface; everything Electron-vs-web divergent routes through it.
- [ ] Acceptance: editing UI logic once updates both the desktop build and the deployed site; `npm run dist` and `npm run site:deploy` both pick it up.

### A2. Backend — **DECIDED (2026-11-01): Cloudflare. Supabase is off the table.**
Everything stays on the account the site is already deployed to. One `wrangler`, one dashboard, no third-party vendor holding your data.
- [x] **Pages Functions** (ships in the same deploy as `./site`) serve `/api/sync/*`. [DONE 2026-11-25] `functions/api/sync/profile/[blobId].js` + `functions/api/sync/body/[blobId]/[key].js`; Wrangler bundles them successfully.
- [x] **KV** holds the encrypted profile blob (opaque to the server); **R2** holds oversized run bodies with pointers left in KV; **D1** only if history needs querying rather than whole-blob reads. [DONE 2026-11-25] `lib/sync-api.js` + `tests/sync-api.test.js`; no D1 needed for whole-blob reads.
- [x] **No Supabase** (user's call, 2026-11-01). Do not reintroduce it as a shortcut when Google login comes up — real accounts then = Google OAuth verified **in a Pages Function** (`google_sub` → account row), still on Cloudflare, still no vendor in the data path. [CONFIRMED 2026-11-25] no Supabase dependency in the repo.
- [x] Add `functions/` to the Pages project so the API and the static site deploy together. [DONE 2026-11-25] `functions/` created with a README; bindings documented as commented examples in `wrangler.jsonc`.

### A3. Identity — pairing secret (now) — **DECIDED: base64 code, not a word mnemonic**
- [x] `generatePairSecret()`: 128-bit random → **URL-safe base64** (e.g. 22 chars, no padding). Chosen over a 12-word mnemonic on 2026-11-01. Entropy is what matters — a short "hash" is guessable and would let anyone read the blob. [DONE 2026-11-25] `src/shared/pairing.js` + `tests/pairing.test.js`.
- [x] Because base64 is ugly to type, make it **copy/paste and QR-first**: desktop shows the code in a selectable field + a QR; web has one paste box. Never ask a human to type 22 random characters off a screen. [DONE 2026-11-25] `src/shared/sync-ui.js` panel in both Settings pages: readonly selectable code + Copy + locally generated SVG QR (`src/shared/qr.js`), and a paste box when unpaired. No third-party QR service.
- [x] `derivedKey = PBKDF2/Argon2(secret)` client-side; `blobId = sha256(secret)`. [DONE 2026-11-25] `deriveIdentity()` in `src/shared/pairing.js`: PBKDF2-HMAC-SHA256 (210k) → non-extractable AES-GCM CryptoKey; `blobId = sha256(secret)` hex. Tested.
- [x] Desktop "Pair" → shows the secret + QR. Web "Have a code?" → enter it. Both derive the same `blobId`, encrypt the same payload, read/write each other's state. [DONE 2026-11-25] `sync:generate`/`sync:enter` IPC in `main.js`, web bridge in `src/web/pv.js`, shared boot in `sync-boot.js`; tested with two clients in `tests/sync-client.test.js`.
- [x] Persist secret locally on pair (desktop: keychain beside `key.bin`; web: `localStorage` — weaker than the keychain, but the **payload is E2E-encrypted**, so the threat is a leaked secret, not a server breach). [DONE 2026-11-25] `lib/pairing-store.js` (safeStorage-encrypted `pairing.bin`) + `vp_pair_code` in web localStorage; both tested.
- [x] Server stores **opaque encrypted blobs** keyed by `blobId` + version + timestamp only. [DONE 2026-11-25] `putProfile()` persists only `{version, updatedAt, payload}`; tested that no plaintext field names are stored.
- [x] Acceptance: pair desktop↔web with one code; change a preset on one, reload the other, it's there; unpair clears the local secret (orphaned server blob is fine). [DONE 2026-11-25] In-memory end-to-end test (`tests/sync-client.test.js`) covers pair → push → pull → per-section merge → R2 body round-trip → unpair. A live cross-device pass still needs the deploy (parked separately).

### A4. Sync protocol
- [x] Payload = one JSON "profile": settings, presets, pairs, composer defaults, theme, **run history (metadata + prompts, never attachment contents — matches current privacy stance)**. [DONE 2026-11-25] `buildProfile()` in `src/shared/sync-profile.js` — section allowlist, no credentials.
- [x] `pull()` on open/focus; `push()` debounced ~2 s after change. [DONE 2026-11-25] `sync-boot.js` pulls on load/focus and watches local state each second, re-arming a 2 s debounce before pushing; `sync-client.js` exposes `schedulePush`.
- [x] **Conflict rule:** last-write-wins **per top-level section** (not whole-blob) so a settings tweak and a new run don't clobber each other; `updatedAt` per section. (CRDT is overkill for two devices.) [DONE 2026-11-25] `mergeProfiles()` — ties keep local, tested.
- [x] Size caps: KV value ≤ 1 MB → big run bodies in **R2**, pointers in KV; trim history to N most-recent. [DONE 2026-11-25] `fitsInKv` (900 KiB), `extractLargeBodies`/`restoreLargeBodies`, `trimHistory`; tested.
- [x] Rate-limit `/api/sync` per `blobId` (the only "auth"). [DONE 2026-11-25] rolling 60s KV counter, 120 requests/window, tested including window reset.

### A5. Google login (later — same table)
- [ ] `accounts` row keyed by `google_sub` that can **claim** a `blobId` via pairing code → migrates hash-account data under the email identity; future devices use `google_sub` directly.
- [ ] OAuth **verified in a Pages Function** (Google id-token → `google_sub`); no auth vendor in the data path. Cloudflare Access is the alternative if you'd rather gate than integrate.
- [ ] Recovery: "lost my devices/secret" → sign in with Google, data's there.
- [ ] **Still never store the OpenRouter key server-side**, even for Google users (per-device key, or an opt-in encrypted "key vault" as its own crypto-reviewed milestone).

---

## Workstream B — Hand the finished prompt off

### B1. "Send to ▸" handoff (cheap — do first)
- [ ] Next to **Copy prompt**, add **Send to ▸** (Cursor / Claude Code / Cline / VS Code / **Hermes**).
- [ ] `main.js` already whitelists `cursor://`, `claude://`, `vscode://`, `https://` in `url:open`, and `clipboard:write` exists → "copy + open agent" is two existing calls.
- [ ] Web: `navigator.clipboard` + same scheme URLs (browser may block custom-protocol launch → "paste it in the agent" fallback).
- [ ] **Hermes is a DIRECT handoff, not a Discord message** (user's call, 2026-11-01: "should go to hermes but not through discord"). Two local paths, both bypassing the chat platform entirely:
  - **Preferred — the gateway's local API:** `POST /v1/runs` with the prompt as the run's first message, then poll `GET /v1/runs/{id}` / `/events` to show progress inside VolleyPrompt's own result panel. Needs `platforms.api_server` enabled locally (already configured in `config.yaml`: `api_server.max_concurrent_runs: 10`) and a token. `POST /v1/runs/{id}/steer` and `/stop` give the app live control over the run.
  - **Fallback — spawn the CLI:** `hermes chat -q "<prompt>"` as a detached child process (desktop only, no API/token needed); capture stdout to the result panel.
- [ ] Either way the app needs a **destination choice + a "what to do with it" prefix** — "build this" vs "review this" — because a bare prompt pasted at Hermes will just be answered, not executed. Keep the handoff text explicit about the expected action and the project folder.
- [ ] Acceptance: one click lands the approved prompt in the chosen agent, formatting intact; the Hermes path starts a real run with **zero Discord messages involved**.

### B2. Scaffold mode — the real feature (Writer+Reviewer build the folder)
> The same two models, in a new role, take the approved prompt and produce a ready project folder for downstream coding agents, optionally with a head-start, and always a `todo.md` handoff. **Depth = the existing "cycles" slider: 1 = scaffold + `todo.md`; more cycles = keep going into a real head-start ("three is plenty").**

- [ ] **Structured output mode:** add `SCAFFOLD_AUTHOR_SYSTEM` → "Emit a JSON file manifest `[{path, content}]`"; `SCAFFOLD_CRITIC_SYSTEM` reviews the manifest (missing dirs? no README? todo not actionable?) and revises. Reuse the round/verdict machinery — only "what a draft is" changes (a manifest, not prose).
- [ ] **Depth semantics — predictable, not "the model decides":**
  - cycle 1 — create folder; write structure + config + `PROMPT.md` (approved prompt) + `todo.md` (handoff).
  - cycle 2 — fill stub files / entry points / data models (still skeleton, opens clean).
  - cycle 3 — real head-start: implement the first milestone end-to-end. (Cap at the slider max already used.)
- [ ] **The `todo.md` handoff** is the deliverable: the scaffold writes a project `todo.md` (milestones, files to create, the volley's constraints) so the *next* agent (Hermes / Claude Code / Cursor) picks up cold. Mirror the shape of this very file.
- [ ] **Filesystem constraint:**
  - *Desktop:* write to a user-picked folder (`dialog.showOpenDialog`/`showSaveDialog` — Electron has it).
  - *Web:* browsers can't silently make folders → **File System Access API** (`showDirectoryPicker`) on Chrome/Edge; else produce a **`.zip`** download of the manifest; else write into the synced profile and let the desktop materialize it (ties to A).
- [ ] **Guardrails:** write *nothing* until the user picks a destination; preview ("about to create 14 files in `X`") with Confirm; never overwrite a non-empty dir without an explicit merge prompt.
- [ ] Acceptance: an approved prompt → a folder that opens in an IDE with `PROMPT.md`, `todo.md`, and (per cycle count) working stubs, produced by the same two models, no manual copy-paste.

---

## Suggested build order (cheapest unlock first)
1. **A1** unified frontend — every later step gets cheaper once the fork is gone.
2. **B1** deep-link "Send to" — hours, immediate payoff, no backend.
3. **A2 + A3 + A4** pairing-secret sync over Cloudflare Functions + KV — the thing you asked for.
4. **B2** Scaffold mode (desktop first) — the flagship "it starts the project" feature.
5. **A5** Google login — only when accounts/recovery are wanted; reuses the A4 table.
6. **B2-web** scaffold via File System Access API / zip / synced-profile.

---

## Open questions (need you to pick)
- ~~Backend~~ → **decided: Cloudflare Pages Functions + KV/R2** (see A2; Supabase ruled out 2026-11-01).
- ~~Pairing code format~~ → **decided: URL-safe base64 + QR/copy-paste-first** (see A3).
- ~~"Send to Hermes"~~ → **decided: direct to Hermes, NOT through Discord** — local `/v1/runs` API or a detached `hermes chat -q` spawn (see B1).
- Web Scaffold at launch: **desktop-only first** (recommended) or must the site scaffold from day one (needs File System Access API / zip)? ← **only one left**

---

## Where we already are (carried from the previous TODO)

**Status**
- App built (main.js / preload.js / renderer/); icon from `build/icon.svg`.
- Landing site deployed → https://volley-prompt.pages.dev (download button, GitHub link, OG/Twitter `site/assets/og-image.png`). Redeploy: `npm run site:deploy`.
- Repo **public** (confirmed 2026-10-30): https://github.com/Chimthuwu/Volley-Prompt — `latest/download/` links work anonymously. *(Old open question "GitHub username/repo for the download link?" → answered.)*
- Phases 1–6 done: big composer; image/text/folder attachments wired into real OpenRouter multimodal requests (both Writer & Reviewer, persisted across rounds); collapsible sidebar; speech-to-text dictation; titlebar settings/theme controls; Project Context Explorer (tri-state checkbox tree, lazy-rendered).
- Desktop shortcut → `dist\win-unpacked\VolleyPrompt.exe`. **Run `npm run dist` after every source change** or the shortcut goes stale (bit twice).
- [x] CI workflow builds installer (`VolleyPrompt - Windows Setup v<ver>.exe`); Mac/Linux builds.

**In flight / later**
- [!] Deploy site: `npx wrangler login` then `npm run site:deploy` (needs wrangler auth + outward deploy).
- [!] Smoke-test the app with a real OpenRouter key: vision accept/reject, reviewer-context, folder attachments all still want a live-key pass.
- Later: Markdown rendering in panels, custom rubric editor, run-history browser.
- Done earlier: editable final prompt, per-panel copy, round progress bar, Ctrl+Enter, re-run with tweaked idea, single-instance lock, auto-retry on 429/5xx/network.

**Overnight / `/sesh` ideas (from old inbox, still valid):** headless mode (`--headless`, log to `nitesesh/`); pre-build `dist/` before overnight runs; `.env` dark theme for overnight.
- [BUG] **`main.js` must add a hard ~30 s timeout** so a missing/stalled OpenRouter response can't hang it — this exact stall is what makes a volley hang (and why the Hermes plugin caps every HTTP call with a per-call timeout).

**Note:** a Hermes **`/volley`** Discord plugin now exists (`~/.hermes/plugins/volley-prompt`) — it reuses this app's exact Writer/Reviewer systems, presets, folder/GitHub filters and OpenRouter key, so "Send to Hermes" (B1) has a target today.

---

# VibeGame MCP — new project, to be run via `/sesh` through Hermes

> Not part of GameVolley/VolleyPrompt itself — a separate, new repo/project. Logged here per request so it can be picked up as a Hermes `/sesh` task. Full spec was pasted in chat on 2026-11-24; condensed below.

**Vision:** A universal MCP server + shared game-development library so any AI assistant (ChatGPT, Claude, DeepSeek, Gemini, GameVolley) can search templates/skills/mechanics/assets and assemble, build, run, test and repair a complete playable browser game from a one-line prompt. Philosophy: reuse working foundations, invent the funny stuff (comedy-game focus is a deliberate differentiator).

**Architecture (4 layers):**
- A. AI client integrations (provider-agnostic adapters)
- B. VibeGame MCP server (TypeScript/Node, official MCP SDK) — search/retrieve templates, skills, mechanics; create/modify projects; drive execution
- C. Game knowledge library — indexed templates, skills, mechanics, assets, docs, with metadata (engine, language, deps, licence, compatibility)
- D. Local Game Builder — isolated workspaces, template copy/adapt, file edits, dep install, dev server, browser preview (Playwright), console capture, tests, packaging

**MVP scope (first milestone):**
- TS MCP server + SQLite resource index
- 5 verified templates: single-file HTML arcade, Phaser 2D platformer, Three.js FPS, Three.js third-person, Three.js physics sandbox
- Small set of Three.js/Phaser dev skills + search
- Template file retrieval, local project creation, basic browser execution (Playwright)
- One working external MCP client connection
- Goal: AI asks for a ridiculous game → finds a template → modifies it → produces a working playable browser game

**Candidate source repos to inspect/ingest (untrusted until reviewed — check licence/deps/security before indexing):**
momozi1996/momozi-VibeGaming-Skills, majidmanzarpour/threejs-game-skills, sausi-7/games, Mudroljub/Three.js-Games, shipshitgames/skills, LeanEntropy/threejs-phaser-game-skills, gamedev-skills/awesome-gamedev-agent-skills, dragnoz/game-creation-skills, GrayWagner/phaser-examples, magejosh/one-page-games

**Roadmap phases (after MVP):** testing/repair automation (Playwright-based) → comedy game systems (ragdolls, vehicles, exaggerated physics, procedural events) → multi-provider integration (ChatGPT/Claude/DeepSeek/Gemini) → dashboard for library management → GameVolley integration (Creative Director/Developer roles reuse the shared library instead of duplicating templates).

**Security requirements carried over:** isolated project workspaces, filesystem access restricted to authorised dirs, no unrestricted shell from AI tool calls, no auto-executing untrusted imported code, execution timeouts/resource limits, no API keys exposed to the AI.

- [ ] Kick off via `/sesh` in Hermes: scaffold the `VibeGame-MCP` repo (structure per spec: `apps/mcp-server`, `apps/local-builder`, `apps/dashboard`, `packages/*`, `library/*`, `sources/*`, `projects/`, `docs/`), set up the MCP server skeleton, resource manifest format, and SQLite index — then begin Phase 1 (import/inspect the first 2-3 candidate repos, basic search).

## Decisions made (review me)
- 2026-11-25 — "Do the historical Workstream A/B tasks apply to this GameVolley repo?" Chose YES: implement them in-repo as bounded, testable modules plus Cloudflare Pages Functions source, stopping short of deploy/credential steps. CHECKPOINT SHA: `d74918212e9a538f396d96cffbdc876292b8aca3` (pushed). Reason: `ready-tasks.py` reports them READY and the brief forbids deferring big/plan-only work.
- 2026-11-25 — "How to keep the sync stack verifiable without Cloudflare credentials?" Chose UMD modules in `src/shared/` with Node unit tests, and Pages Functions handlers that accept injectable KV/R2 bindings for tests. Reason: deploy needs auth, but the logic does not.
- 2026-11-25 — "How to render the A3 pairing QR with no QR library installed?" Chose a self-contained fixed-version-2 QR encoder in `src/shared/qr.js` (SVG output, no network, no dependency). CHECKPOINT SHA: `157ce4e6ccf1195655d99becb1682701c8e470dd` (pushed). Reason: a third-party QR image service would leak the pairing secret; dropping QR would violate the written requirement.


# VolleyPrompt — Architecture TODO

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
- [ ] Make `renderer/` and `site/` share **one** source for `app.js`/`store.js`/styles (build step emits both, or web loads the same files Electron uses). Kill the hand-copied fork.
- [ ] Confirm `window.pv` is the *only* environment-specific surface; everything Electron-vs-web divergent routes through it.
- [ ] Acceptance: editing UI logic once updates both the desktop build and the deployed site; `npm run dist` and `npm run site:deploy` both pick it up.

### A2. Backend — **DECIDED (2026-11-01): Cloudflare. Supabase is off the table.**
Everything stays on the account the site is already deployed to. One `wrangler`, one dashboard, no third-party vendor holding your data.
- [ ] **Pages Functions** (ships in the same deploy as `./site`) serve `/api/sync/*`.
- [ ] **KV** holds the encrypted profile blob (opaque to the server); **R2** holds oversized run bodies with pointers left in KV; **D1** only if history needs querying rather than whole-blob reads.
- [ ] **No Supabase** (user's call, 2026-11-01). Do not reintroduce it as a shortcut when Google login comes up — real accounts then = Google OAuth verified **in a Pages Function** (`google_sub` → account row), still on Cloudflare, still no vendor in the data path.
- [ ] Add `functions/` to the Pages project so the API and the static site deploy together.

### A3. Identity — pairing secret (now) — **DECIDED: base64 code, not a word mnemonic**
- [ ] `generatePairSecret()`: 128-bit random → **URL-safe base64** (e.g. 22 chars, no padding). Chosen over a 12-word mnemonic on 2026-11-01. Entropy is what matters — a short "hash" is guessable and would let anyone read the blob.
- [ ] Because base64 is ugly to type, make it **copy/paste and QR-first**: desktop shows the code in a selectable field + a QR; web has one paste box. Never ask a human to type 22 random characters off a screen.
- [ ] `derivedKey = PBKDF2/Argon2(secret)` client-side; `blobId = sha256(secret)`.
- [ ] Desktop "Pair" → shows the secret + QR. Web "Have a code?" → enter it. Both derive the same `blobId`, encrypt the same payload, read/write each other's state.
- [ ] Persist secret locally on pair (desktop: keychain beside `key.bin`; web: `localStorage` — weaker than the keychain, but the **payload is E2E-encrypted**, so the threat is a leaked secret, not a server breach).
- [ ] Server stores **opaque encrypted blobs** keyed by `blobId` + version + timestamp only.
- [ ] Acceptance: pair desktop↔web with one code; change a preset on one, reload the other, it's there; unpair clears the local secret (orphaned server blob is fine).

### A4. Sync protocol
- [ ] Payload = one JSON "profile": settings, presets, pairs, composer defaults, theme, **run history (metadata + prompts, never attachment contents — matches current privacy stance)**.
- [ ] `pull()` on open/focus; `push()` debounced ~2 s after change.
- [ ] **Conflict rule:** last-write-wins **per top-level section** (not whole-blob) so a settings tweak and a new run don't clobber each other; `updatedAt` per section. (CRDT is overkill for two devices.)
- [ ] Size caps: KV value ≤ 1 MB → big run bodies in **R2**, pointers in KV; trim history to N most-recent.
- [ ] Rate-limit `/api/sync` per `blobId` (the only "auth").

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

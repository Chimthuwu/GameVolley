# Shared frontend (A1) — verified 2026-11-25

## One source tree, two emitted bundles

`npm run build:shared` (`scripts/build-shared.mjs`) is the only supported way to update the
frontends. Nobody edits `renderer/app.js`, `renderer/style.css`, `site/app.js` or
`site/style.css` by hand — they are generated.

Sources:

- `src/shared/` — code and styles emitted into BOTH bundles (`app-core.js`, `style.css`,
  `pairing.js`, `sync-profile.js`, `sync-client.js`, `sync-apply.js`, `sync-ui.js`,
  `sync-boot.js`, `qr.js`).
- `src/renderer/` — desktop-only additions (`app.js`, `style.css`, `gamevolley.js`,
  `gamevolley.css`, `index.html`).
- `src/web/` — web-only additions (`app.js`, `style.css`, `pv.js`, `index.html`).

`tests/conditionals.test.js` asserts that each shared file is emitted unchanged into both
targets and that both bundles exist. `npm test` also parses both built `app.js` files.

## Conditional compilation

`scripts/conditionals.mjs` implements two directives:

- `// @if:renderer` … `// @endif` (or `@if:web`) — include a block for one platform only.
- `// @platform:renderer <code>` — emit `<code>` for one platform only.

The single-line form previously compared the *entire* trailing line to the platform name,
so it never emitted anything. That bug is fixed and covered by a test.

## `window.pv` is the only environment-specific surface

Audited by comparing the method names in `preload.js` (`exposeInMainWorld`) with the
`window.pv` object in `src/web/pv.js` (`tests/pv-surface.test.js`).

- Every method used by the shared UI (`copy`, `openUrl`, `hasKey`, `saveKey`, `start`,
  `stop`, `runs`, `onEvent`) exists on both bridges.
- Sync is a deliberate exception in *placement*, not in surface: desktop uses
  `pv.syncGenerate`/`syncPull`/… (secret in OS-encrypted storage in the main process), web
  uses `window.GameVolleyWebSync` (secret in localStorage). Both expose the same operations
  through `sync-boot.js`.
- Desktop-only methods are GameVolley workspace methods (`project*`, `checkpoint*`,
  `preview*`, `agent*`, `gameOnEvent`, `openDir`, `openRun`) plus the multi-provider
  credential methods and the direct Hermes CLI handoff (`hermesStart`, `onHandoffEvent`),
  plus local scaffold writing (`scaffoldPickDir`, `scaffoldWrite`).
  The web shell deliberately does not load `gamevolley.js`, and the web UI has no provider
  panel or local CLI, so those methods are unreachable there (web scaffolding uses the
  File System Access API via `GameVolleyScaffoldWeb` instead). No shared UI code calls
  a method that is missing from the web bridge.

`src/shared/app-core.js` remains a parallel, simpler implementation with an IIFE wrapper:
it is not yet a drop-in replacement for the platform files' richer versions. See
`TODO.md` section 0.6 for the per-function analysis. Platform-divergent functions
(`MAX_FILE_BYTES`, theme HSL tuning, `applyTheme`, `renderAttachments`, `addAttachmentFiles`,
`runHistoryAction`, `setupModelAutocomplete`, `STARTER_PRESETS`, `escapeHtml`) MUST stay in
their platform files until that analysis is resolved properly.

## Acceptance status

- `npm run build:shared` emits both bundles from one source tree: verified.
- `npm test` (including the new conditionals/build-parity and bridge-surface tests): green.
- `npm run dist` packages the desktop app from the built `renderer/` directory: available,
  not run in an unattended session (it rewrites `dist/` and needs the Windows code-sign toolchain).
- There is no `site:deploy` script (it targeted VolleyPrompt's Pages project). A deploy would need `wrangler` credentials and is an outward-facing step — parked
  in `TODO.md` and left for the owner.

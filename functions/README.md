# Sync API (Cloudflare Pages Functions)

These routes implement the zero-knowledge backend described in `TODO.md` workstreams A2/A4.
They ship in the same Pages deployment as `site/` — Pages auto-discovers this `functions/`
directory, so no separate Worker deploy is needed.

## Routes

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/sync/profile/:blobId` | Pull the opaque encrypted profile |
| PUT | `/api/sync/profile/:blobId` | Push the opaque encrypted profile |
| DELETE | `/api/sync/profile/:blobId` | Unpair (delete the stored blob) |
| GET | `/api/sync/body/:blobId/:key` | Read an oversized run body from R2 |
| PUT | `/api/sync/body/:blobId/:key` | Write an oversized run body to R2 |

`blobId` is `sha256(pairingCode)` — a 64-character lowercase hex string. The server never
sees the pairing code, the derived AES key, plaintext profile data, or an OpenRouter key.

## Required bindings

Add these to `wrangler.jsonc` (see the commented examples there):

- `SYNC_KV` — KV namespace. Holds `profile:<blobId>` (a JSON object with only
  `version`, `updatedAt` and the opaque ciphertext `payload`), plus rolling
  rate-limit counters `rl:<blobId>:<window>`.
- `SYNC_R2` — R2 bucket. Holds run bodies too large for the 1 MiB KV value cap,
  keyed `<blobId>/<key>`.

GameVolley has no deploy script or deploy workflow. The ones it had targeted the
`volley-prompt` Pages project, which belongs to VolleyPrompt, and would have
replaced that site and its sync service. If this web build is ever published,
give it its own Pages project with a different name.

## Testing

All logic lives in `lib/sync-api.js` (no Cloudflare globals), so it is unit-tested with
in-memory KV/R2 doubles via `tests/sync-api.test.js`. Verify the route bundle compiles
with:

```
npx wrangler pages functions build --outdir <temp-dir>
```

# Rebuild V2 Fresh Start (`rebuild/v2`)

This directory is a **fresh-start workspace** for the Emerald web rebuild effort. Existing code under `rebuild/` remains intact and unchanged as a parallel path.

## Non-changing goals

- **Server authority remains required**: server-owned simulation, state, and validation from first playable milestones.
- **Behavioral parity remains required**: user-visible outcomes should match Emerald reference behavior.
- **Stack boundaries remain unchanged**:
  - `server/` = Rust + Tokio + Axum + WebSocket authoritative core.
  - `client/` = TypeScript + PixiJS renderer/input frontend.
  - `shared/` = protocol/schema contract placeholders for versioned binary evolution.

## First rendering target in this restart

The first rendering objective is a **32x32 (16-metatile) buffer-wheel overworld renderer**, wired to authoritative server state over WebSocket.

## Development assets

`rebuild/v2` defaults to using extracted assets from:

- `rebuild/assets`

No asset duplication is introduced. Asset root is configurable via `V2_ASSET_ROOT`.

## Single-server deployment model

V2 supports standalone deployment from one Axum process:

- App shell + browser bundle are served by the server from `rebuild/v2/client/dist-v2`.
- Authoritative gameplay assets are served from `rebuild/assets` at `/v2/assets/*`.
- WebSocket transport remains at `/ws`.

Route namespace split:

- `/` and bundle output paths (for example `/assets/*`) -> Vite build output (`dist-v2`)
- `/v2/assets/*` -> filesystem-backed authoritative assets (`rebuild/assets`)
- `/ws` -> authoritative realtime socket endpoint

SPA fallback is enabled only for app routes served from the client bundle. It does not replace `/v2/assets/*` or `/ws`.

### Production startup (no browser-local files required)

1. Build the client bundle:

   ```bash
   cd rebuild/v2/client
   npm ci
   npm run build
   ```

2. Start the server:

   ```bash
   cd ../server
   cargo run
   ```

Optional environment overrides:

- `V2_ASSET_ROOT` (default `../../assets`)
- `V2_CLIENT_DIST_ROOT` (default `../client/dist-v2`)
- `V2_SERVER_BIND_ADDR` (default `127.0.0.1:4100`)

After startup, open `http://127.0.0.1:4100/`. The browser loads everything from the v2 server (bundle + assets + websocket endpoint).

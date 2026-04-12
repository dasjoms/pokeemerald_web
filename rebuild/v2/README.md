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

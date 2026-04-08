# Emerald Rebuild (`rebuild/`)

This directory contains a modern, server-authoritative rebuild of Pokémon Emerald internals while preserving user-visible gameplay behavior.

## Phase 1 Scope

Phase 1 is intentionally narrow and focuses on first-playable overworld movement:

- Load overworld map data.
- Render the world in the browser.
- Accept and process **walking inputs only**.
- Validate and apply movement on the authoritative server.

Out of scope for Phase 1:

- Warps.
- Non-walking button interactions.
- Additional gameplay systems.

## Reference Behavior Sources (Legacy Decomp)

The rebuild uses the existing decompilation as **reference behavior only**. The new implementation remains isolated under `rebuild/`.

Movement and map behavior parity should be validated against legacy references such as:

- `src/field_player_avatar.c`
- `src/fieldmap.c`
- `src/metatile_behavior.c`
- `data/maps/`
- `data/layouts/`
- `data/tilesets/`

## Directory Layout

- `server/` — Rust server (Tokio + Axum), authoritative simulation and validation.
- `client/` — TypeScript + PixiJS browser renderer/input client.
- `shared/` — protocol/schema definitions and shared constants.
- `tools/` — extraction/parity tooling and validation scripts.
- `docs/` — parity notes and architecture decision records.

# Rebuild Architecture Requirements

## Core Principle: Server Authority

From the first playable version onward, the server is authoritative.

The server must:

1. **Validate movement** (tile/collision rules and movement acceptance).
2. **Own RNG** (all gameplay-relevant randomness originates server-side).
3. **Own game state** (authoritative world and player state transitions).
4. **Own saves/state persistence** (server is source of truth for persistent progress).

## Runtime/Stack Targets

- Server language: Rust.
- Server runtime/framework: Tokio + Axum.
- Transport: WebSocket.
- Browser client: TypeScript + PixiJS.
- Shared protocol/schema: centralized under `rebuild/shared/`.

## Client Responsibility Boundaries

The browser client should remain lightweight:

- Renders authoritative state.
- Captures local input intent.
- Does not become source of truth for movement, RNG, or saves.

## Deterministic Parity Goal

For equivalent inputs, rebuild outcomes must match expected legacy Emerald behavior in player-visible systems.

## Camera Parity Shadow Mode (Client)

The client includes a shadow-mode camera parity module (`rebuild/client/src/fieldCameraParity.ts`) that computes ROM-style camera offsets and metatile boundary-cross events from `renderTileX/renderTileY`.

Current intent:
- Observe and validate parity counters/events without changing gameplay behavior.
- Keep module read-only relative to movement/prediction/reconciliation.

Intentionally not switched yet:
- No map slice redraws are driven by parity events.
- No viewport crop/window logic is driven by parity offsets.
- Existing camera transform/rendering path remains active.

Next planned integration step:
- Feed `metatile-cross` events into a ring-buffer renderer that performs parity-consistent metatile strip updates.

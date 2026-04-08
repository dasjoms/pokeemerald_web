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

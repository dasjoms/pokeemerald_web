# AGENTS.md

## Project Mission (Read First)
This repository started as a clean fork of the **Pokémon Emerald ROM decompilation** and is being evolved into a **server/client web-playable rebuild**.

The product goal is to let players connect from web browsers to a remote server and play a version that is user-facingly as close to the original game as possible, while non-user-facing internals are modernized for server authority, maintainability, and scale.

---

## Non-Negotiable Rules

1. **Original decomp code is immutable reference material.**
   - Do **not** modify original decomp files.
   - Do **not** directly import/call original ROM code from rebuild code.
   - The rebuild must be fully self-sufficient.

2. **User-visible parity is top priority.**
   - When tradeoffs happen, preserve player-facing behavior of original Emerald first.

3. **Deterministic parity is required.**
   - Same inputs must produce same outcomes as the reference implementation.
   - Even where parity is hard to auto-verify, agents must carefully replicate behavior.

4. **Server authority is required from the first playable version.**
   - Server validates movement.
   - Server owns RNG.
   - Server owns game logic.
   - Server owns saves/state.

---

## Rebuild Location and Repository Boundaries
All new implementation work belongs under `rebuild/`.

Required core structure:
- `rebuild/server/` — authoritative game server.
- `rebuild/client/` — browser client/UI renderer.
- Additional supporting folders may be added as needed (for example shared protocol/schema/tooling folders), but all rebuild code stays under `rebuild/`.

The legacy/original code paths outside `rebuild/` remain the canonical behavioral reference only.

---

## First Playable Milestone Scope (Phase 1)
Initial implementation is intentionally narrow:

- Must load overworld map.
- Must render the world in browser.
- Must accept and process **walking inputs only**.
- Must allow walking through the world with correct validation.

Out of scope for phase 1:
- warps,
- non-walking button interactions,
- additional gameplay systems.

Even in this reduced scope, authority remains server-side.

---

## Approved Tech Stack
This stack is pre-approved for this project:

- **Server/core language:** Rust
- **Server runtime/framework:** Tokio + Axum
- **Realtime transport:** WebSocket (default protocol)
- **Data serialization:** compact versioned binary/MessagePack-style schema
- **Persistence:** PostgreSQL (authoritative saves and persistent player state)
- **Optional infra (as scale grows):** Redis for session/cache coordination
- **Web client:** TypeScript + PixiJS (2D rendering)
- **Schema/protocol alignment:** shared schema/codegen approach between server and client

Design intent:
- Keep browser client mostly as interface/renderer with minimal authority.
- Keep simulation and truth on the server.

---

## Asset Strategy (Dual Source, Build-Time Switch)
The project uses original game assets and supports two source roots:

1. **Development source:** existing original asset folder structure in this repository.
2. **Rebuild source:** mirrored/similar asset structure under rebuild-owned paths.

Rules:
- Asset source selection is **build-time only**.
- Rebuild asset layout must currently remain **the same as original structure** (no custom remapping yet).

---

## Hardware-Era Constraints: What Can Be Dropped Internally
The rebuild targets a modern server/browser architecture, so many GBA-era implementation constraints do not need to be preserved internally.

Examples of droppable internal constraints:
- fixed flash sector/saveblock size restrictions,
- strict EWRAM/IWRAM/manual memory placement concerns,
- direct register programming (`REG_*`) and interrupt choreography,
- DMA/VBlank/HBlank transfer timing mechanics,
- link cable/RFU transport-level limitations,
- compression/decompression flows tied to VRAM-era loading,
- hardware-driven object/sprite memory ceilings,
- fixed-point-only patterns used due historical hardware constraints.

### Critical caveat
Dropping internal constraints does **not** permit output drift.

Agents must preserve behavioral parity where players can observe outcomes:
- movement and collision results,
- RNG outcomes,
- map state behavior,
- timing/animation feel where gameplay-relevant,
- authoritative game-state transitions.

**Rule of thumb:** modernize internals freely, but never change gameplay outcomes for equivalent inputs.

---

## Save Data Policy
- Save format in rebuild may be fully new (not bound to GBA flash-sector format).
- Rebuild saves must still represent all gameplay-relevant save data covered by original Emerald.
- Server remains the source of truth for saved state.

---

## Agent Working Guidelines
When implementing features:

1. Start from behavior parity expectations, not from hardware implementation details.
2. Treat original code/data as reference for expected results only.
3. Keep authoritative logic server-side.
4. Keep client lightweight and non-authoritative.
5. Prefer explicit protocol contracts and deterministic state updates.
6. Keep rebuild code and tooling isolated under `rebuild/`.
7. Do not edit original decomp files.

---

## Summary for Future Agents
You are not building a ROM hack in place. You are building a **separate, modern, server-authoritative Emerald rebuild** under `rebuild/`, using original assets and original behavior as reference.

If uncertain between “authentic behavior” vs “implementation convenience,” choose authentic behavior.

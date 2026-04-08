# WebSocket Protocol (Phase 1 Walking)

This document defines the authoritative WebSocket protocol for the rebuild. The
single source of truth for field shapes and binary encoding is
`rebuild/shared/protocol.py`.

## Goals

- Preserve deterministic Emerald-like movement outcomes.
- Keep authoritative state on the server.
- Use compact binary frames (length-prefixed little-endian payloads).

## Frame Envelope

Every WebSocket binary frame is encoded as:

- `protocol_version: u16`
- `message_type: u8`
- `payload_len: u32`
- `payload: [payload_len]bytes`

`protocol_version` is currently `1`.

## Message Types

### Client → Server

#### `JoinSession`

Used once at connect-time to request admission to a playable session.

Payload fields:

- `player_id: string` (u32 length + UTF-8 bytes)

#### `WalkInput`

Client walking intent for Phase 1 movement.

Payload fields:

- `direction: u8` (`0=Up`, `1=Down`, `2=Left`, `3=Right`)
- `input_seq: u32` (strictly increasing per client stream)
- `client_time: u64` (client-local monotonic timestamp)

`input_seq` is the deterministic sequencing key used to pair this input with the
server's `WalkResult`.

### Server → Client

#### `SessionAccepted`

Confirms session creation and returns server sequencing anchor.

Payload fields:

- `session_id: u32`
- `server_frame: u32`

#### `WorldSnapshot`

Authoritative baseline state after join (and for hard resyncs).

Payload fields:

- `map_id: u16`
- `player_pos.x: u16`
- `player_pos.y: u16`
- `facing: u8` (`Direction` enum)
- `server_frame: u32`
- `map_chunk_hash: bytes` (`u8 hash_len` + bytes)
- `map_chunk: bytes` (`u32 len` + bytes)

`map_chunk_hash` identifies the chunk payload deterministically and supports
future cache-based snapshot optimization.

#### `WalkResult`

Authoritative movement decision for one `WalkInput`.

Payload fields:

- `input_seq: u32` (echo from input)
- `accepted: u8` (`0`/`1`)
- `authoritative_pos.x: u16`
- `authoritative_pos.y: u16`
- `facing: u8`
- `reason: u8` (`RejectionReason` enum)
- `server_frame: u32`

#### `WorldDelta` (optional)

Incremental nearby map updates.

Payload fields:

- `map_id: u16`
- `server_frame: u32`
- `delta_blob: bytes` (`u32 len` + bytes)

`delta_blob` is intentionally opaque in Phase 1 so nearby update format can
iterate without changing envelope semantics.

## Rejection Reasons

`WalkResult.reason` codes:

- `0 NONE` — input accepted.
- `1 COLLISION` — destination tile is blocked by map collision rules.
- `2 OUT_OF_BOUNDS` — destination coordinate is outside valid map bounds.
- `3 SEQUENCE_MISMATCH` — stale, duplicate, or skipped `input_seq`.
- `4 NOT_JOINED` — movement received before successful join.
- `5 INVALID_DIRECTION` — direction byte is unknown.

For collision and out-of-bounds attempts, server must keep
`authoritative_pos` unchanged from the last valid position and still advance
`server_frame` deterministically.

## Determinism Rules

- Client sends monotonic `input_seq`; server responds with exactly one
  `WalkResult` per accepted input record.
- Server includes `server_frame` in all authoritative state messages
  (`SessionAccepted`, `WorldSnapshot`, `WalkResult`, `WorldDelta`).
- In conflict, client must treat server position/facing/frame as ground truth.

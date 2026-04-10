"""Authoritative wire protocol definitions for rebuild WebSocket traffic.

This module is the single source of truth for client/server message types,
message IDs, deterministic sequencing fields, and compact binary
serialization/deserialization.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import IntEnum
import struct

PROTOCOL_VERSION = 12

_HEADER = struct.Struct("<HBI")  # protocol_version, message_type, payload_len
_U8 = struct.Struct("<B")
_U16 = struct.Struct("<H")
_U32 = struct.Struct("<I")
_U64 = struct.Struct("<Q")


class ProtocolError(ValueError):
    """Raised when a frame cannot be decoded as a valid protocol message."""


class MessageType(IntEnum):
    # Client -> Server
    JOIN_SESSION = 0x01
    WALK_INPUT = 0x02
    PLAYER_ACTION_INPUT = 0x03
    DEBUG_TRAVERSAL_INPUT = 0x04
    HELD_INPUT_STATE = 0x05

    # Server -> Client
    SESSION_ACCEPTED = 0x81
    WORLD_SNAPSHOT = 0x82
    WALK_RESULT = 0x83
    WORLD_DELTA = 0x84
    BIKE_RUNTIME_DELTA = 0x85


class Direction(IntEnum):
    UP = 0
    DOWN = 1
    LEFT = 2
    RIGHT = 3


class MovementMode(IntEnum):
    WALK = 0
    RUN = 1


class StepSpeed(IntEnum):
    STEP1 = 0
    STEP2 = 1
    STEP3 = 2
    STEP4 = 3
    STEP8 = 4


class HeldButtons(IntEnum):
    NONE = 0
    B = 1 << 0


class DebugTraversalAction(IntEnum):
    TOGGLE_MOUNT = 0
    SWAP_BIKE_TYPE = 1


class PlayerAction(IntEnum):
    USE_REGISTERED_BIKE = 0
    SWAP_BIKE_TYPE = 1


class TraversalState(IntEnum):
    ON_FOOT = 0
    MACH_BIKE = 1
    ACRO_BIKE = 2


class AcroBikeSubstate(IntEnum):
    NONE = 0
    STANDING_WHEELIE = 1
    MOVING_WHEELIE = 2
    BUNNY_HOP = 3


class BikeTransitionType(IntEnum):
    NONE = 0
    MOUNT = 1
    DISMOUNT = 2
    ENTER_WHEELIE = 3
    EXIT_WHEELIE = 4
    HOP = 5
    WHEELIE_IDLE = 6
    WHEELIE_POP = 7
    WHEELIE_END = 8
    HOP_STANDING = 9
    HOP_MOVING = 10
    SIDE_JUMP = 11
    TURN_JUMP = 12
    NORMAL_TO_WHEELIE = 13
    WHEELIE_TO_NORMAL = 14
    WHEELIE_HOPPING_STANDING = 15
    WHEELIE_HOPPING_MOVING = 16
    WHEELIE_MOVING = 17
    WHEELIE_RISING_MOVING = 18
    WHEELIE_LOWERING_MOVING = 19


class RejectionReason(IntEnum):
    NONE = 0
    COLLISION = 1
    OUT_OF_BOUNDS = 2
    SEQUENCE_MISMATCH = 3
    NOT_JOINED = 4
    INVALID_DIRECTION = 5
    FORCED_MOVEMENT_DISABLED = 6


class PlayerAvatar(IntEnum):
    BRENDAN = 0
    MAY = 1

class HopLandingParticleClass(IntEnum):
    NORMAL_GROUND_DUST = 0
    TALL_GRASS_JUMP = 1
    LONG_GRASS_JUMP = 2
    SHALLOW_WATER_SPLASH = 3
    DEEP_WATER_SPLASH = 4


@dataclass(frozen=True)
class Position:
    x: int
    y: int


@dataclass(frozen=True)
class JoinSession:
    player_id: str


@dataclass(frozen=True)
class WalkInput:
    direction: Direction
    movement_mode: MovementMode
    held_buttons: int
    input_seq: int
    client_time: int


@dataclass(frozen=True)
class HeldInputState:
    held_direction: Direction | None
    held_buttons: int
    input_seq: int
    client_time: int


@dataclass(frozen=True)
class DebugTraversalInput:
    action: DebugTraversalAction


@dataclass(frozen=True)
class PlayerActionInput:
    action: PlayerAction


@dataclass(frozen=True)
class SessionAccepted:
    session_id: int
    server_frame: int
    avatar: PlayerAvatar


@dataclass(frozen=True)
class WorldSnapshot:
    map_id: int
    player_pos: Position
    facing: Direction
    avatar: PlayerAvatar
    map_chunk_hash: bytes
    map_chunk: bytes
    server_frame: int
    traversal_state: TraversalState
    preferred_bike_type: TraversalState
    authoritative_step_speed: StepSpeed | None = None
    mach_speed_stage: int | None = None
    acro_substate: AcroBikeSubstate | None = None
    bike_transition: BikeTransitionType | None = None
    bunny_hop_cycle_tick: int | None = None
    bike_effect_flags: int = 0


@dataclass(frozen=True)
class WalkResult:
    input_seq: int
    accepted: bool
    authoritative_pos: Position
    facing: Direction
    reason: RejectionReason
    server_frame: int
    traversal_state: TraversalState
    preferred_bike_type: TraversalState
    authoritative_step_speed: StepSpeed | None = None
    mach_speed_stage: int | None = None
    acro_substate: AcroBikeSubstate | None = None
    bike_transition: BikeTransitionType | None = None
    bike_effect_flags: int = 0
    bunny_hop_cycle_tick: int | None = None
    hop_landing_particle_class: HopLandingParticleClass | None = None
    hop_landing_tile_x: int | None = None
    hop_landing_tile_y: int | None = None


@dataclass(frozen=True)
class WorldDelta:
    map_id: int
    server_frame: int
    delta_blob: bytes


@dataclass(frozen=True)
class BikeRuntimeDelta:
    server_frame: int
    traversal_state: TraversalState
    authoritative_step_speed: StepSpeed | None = None
    mach_speed_stage: int | None = None
    acro_substate: AcroBikeSubstate | None = None
    bike_transition: BikeTransitionType | None = None
    bunny_hop_cycle_tick: int | None = None
    hop_landing_particle_class: HopLandingParticleClass | None = None
    hop_landing_tile_x: int | None = None
    hop_landing_tile_y: int | None = None


WireMessage = (
    JoinSession
    | WalkInput
    | HeldInputState
    | PlayerActionInput
    | DebugTraversalInput
    | SessionAccepted
    | WorldSnapshot
    | WalkResult
    | WorldDelta
    | BikeRuntimeDelta
)


def encode_message(message: WireMessage) -> bytes:
    message_type, payload = _encode_payload(message)
    return _HEADER.pack(PROTOCOL_VERSION, int(message_type), len(payload)) + payload


def decode_message(frame: bytes) -> WireMessage:
    if len(frame) < _HEADER.size:
        raise ProtocolError("frame too short")

    version, raw_type, payload_len = _HEADER.unpack_from(frame)
    if version != PROTOCOL_VERSION:
        raise ProtocolError(f"unsupported protocol version {version}")

    payload = frame[_HEADER.size :]
    if len(payload) != payload_len:
        raise ProtocolError("payload length mismatch")

    try:
        message_type = MessageType(raw_type)
    except ValueError as exc:
        raise ProtocolError(f"unknown message type: {raw_type}") from exc

    return _decode_payload(message_type, payload)


def _encode_payload(message: WireMessage) -> tuple[MessageType, bytes]:
    if isinstance(message, JoinSession):
        return MessageType.JOIN_SESSION, _pack_str(message.player_id)

    if isinstance(message, WalkInput):
        return MessageType.WALK_INPUT, b"".join(
            [
                _U8.pack(int(message.direction)),
                _U8.pack(int(message.movement_mode)),
                _U8.pack(message.held_buttons),
                _U32.pack(message.input_seq),
                _U64.pack(message.client_time),
            ]
        )

    if isinstance(message, HeldInputState):
        has_direction = message.held_direction is not None
        return MessageType.HELD_INPUT_STATE, b"".join(
            [
                _U8.pack(1 if has_direction else 0),
                _U8.pack(int(message.held_direction or Direction.UP)),
                _U8.pack(message.held_buttons),
                _U32.pack(message.input_seq),
                _U64.pack(message.client_time),
            ]
        )

    if isinstance(message, PlayerActionInput):
        return MessageType.PLAYER_ACTION_INPUT, _U8.pack(int(message.action))

    if isinstance(message, DebugTraversalInput):
        return MessageType.DEBUG_TRAVERSAL_INPUT, _U8.pack(int(message.action))

    if isinstance(message, SessionAccepted):
        return MessageType.SESSION_ACCEPTED, b"".join(
            [
                _U32.pack(message.session_id),
                _U32.pack(message.server_frame),
                _U8.pack(int(message.avatar)),
            ]
        )

    if isinstance(message, WorldSnapshot):
        hash_len = len(message.map_chunk_hash)
        if hash_len > 255:
            raise ProtocolError("map_chunk_hash must be <= 255 bytes")

        runtime_payload, runtime_flags = _encode_bike_runtime(
            message.authoritative_step_speed,
            message.mach_speed_stage,
            message.acro_substate,
            message.bike_transition,
            message.bunny_hop_cycle_tick,
        )

        return MessageType.WORLD_SNAPSHOT, b"".join(
            [
                _U16.pack(message.map_id),
                _U16.pack(message.player_pos.x),
                _U16.pack(message.player_pos.y),
                _U8.pack(int(message.facing)),
                _U8.pack(int(message.avatar)),
                _U32.pack(message.server_frame),
                _U8.pack(int(message.traversal_state)),
                _U8.pack(int(message.preferred_bike_type)),
                _U8.pack(runtime_flags),
                runtime_payload,
                _U8.pack(message.bike_effect_flags),
                _U8.pack(hash_len),
                message.map_chunk_hash,
                _pack_bytes(message.map_chunk),
            ]
        )

    if isinstance(message, WalkResult):
        runtime_payload, runtime_flags = _encode_bike_runtime(
            message.authoritative_step_speed,
            message.mach_speed_stage,
            message.acro_substate,
            message.bike_transition,
            message.bunny_hop_cycle_tick,
        )
        return MessageType.WALK_RESULT, b"".join(
            [
                _U32.pack(message.input_seq),
                _U8.pack(1 if message.accepted else 0),
                _U16.pack(message.authoritative_pos.x),
                _U16.pack(message.authoritative_pos.y),
                _U8.pack(int(message.facing)),
                _U8.pack(int(message.reason)),
                _U32.pack(message.server_frame),
                _U8.pack(int(message.traversal_state)),
                _U8.pack(int(message.preferred_bike_type)),
                _U8.pack(runtime_flags),
                runtime_payload,
                _U8.pack(message.bike_effect_flags),
                _U8.pack(1 if message.hop_landing_particle_class is not None else 0),
                _U8.pack(int(message.hop_landing_particle_class or 0)),
                _U8.pack(
                    1
                    if message.hop_landing_tile_x is not None
                    and message.hop_landing_tile_y is not None
                    else 0
                ),
                _U16.pack(message.hop_landing_tile_x or 0),
                _U16.pack(message.hop_landing_tile_y or 0),
            ]
        )

    if isinstance(message, WorldDelta):
        return MessageType.WORLD_DELTA, b"".join(
            [_U16.pack(message.map_id), _U32.pack(message.server_frame), _pack_bytes(message.delta_blob)]
        )

    if isinstance(message, BikeRuntimeDelta):
        runtime_payload, runtime_flags = _encode_bike_runtime(
            message.authoritative_step_speed,
            message.mach_speed_stage,
            message.acro_substate,
            message.bike_transition,
            message.bunny_hop_cycle_tick,
        )
        return MessageType.BIKE_RUNTIME_DELTA, b"".join(
            [
                _U32.pack(message.server_frame),
                _U8.pack(int(message.traversal_state)),
                _U8.pack(runtime_flags),
                runtime_payload,
                _U8.pack(1 if message.hop_landing_particle_class is not None else 0),
                _U8.pack(int(message.hop_landing_particle_class or 0)),
                _U8.pack(
                    1
                    if message.hop_landing_tile_x is not None
                    and message.hop_landing_tile_y is not None
                    else 0
                ),
                _U16.pack(message.hop_landing_tile_x or 0),
                _U16.pack(message.hop_landing_tile_y or 0),
            ]
        )

    raise TypeError(f"unsupported message type: {type(message).__name__}")


def _decode_payload(message_type: MessageType, payload: bytes) -> WireMessage:
    offset = 0

    if message_type is MessageType.JOIN_SESSION:
        player_id, _ = _unpack_str(payload, offset)
        return JoinSession(player_id=player_id)

    if message_type is MessageType.WALK_INPUT:
        direction, offset = _unpack_u8(payload, offset)
        movement_mode, offset = _unpack_u8(payload, offset)
        held_buttons, offset = _unpack_u8(payload, offset)
        input_seq, offset = _unpack_u32(payload, offset)
        client_time, offset = _unpack_u64(payload, offset)
        _ensure_done(payload, offset)
        return WalkInput(
            direction=Direction(direction),
            movement_mode=MovementMode(movement_mode),
            held_buttons=held_buttons,
            input_seq=input_seq,
            client_time=client_time,
        )

    if message_type is MessageType.HELD_INPUT_STATE:
        has_direction, offset = _unpack_u8(payload, offset)
        direction, offset = _unpack_u8(payload, offset)
        held_buttons, offset = _unpack_u8(payload, offset)
        input_seq, offset = _unpack_u32(payload, offset)
        client_time, offset = _unpack_u64(payload, offset)
        _ensure_done(payload, offset)
        return HeldInputState(
            held_direction=Direction(direction) if has_direction != 0 else None,
            held_buttons=held_buttons,
            input_seq=input_seq,
            client_time=client_time,
        )

    if message_type is MessageType.PLAYER_ACTION_INPUT:
        action, offset = _unpack_u8(payload, offset)
        _ensure_done(payload, offset)
        return PlayerActionInput(action=PlayerAction(action))

    if message_type is MessageType.DEBUG_TRAVERSAL_INPUT:
        action, offset = _unpack_u8(payload, offset)
        _ensure_done(payload, offset)
        return DebugTraversalInput(action=DebugTraversalAction(action))

    if message_type is MessageType.SESSION_ACCEPTED:
        session_id, offset = _unpack_u32(payload, offset)
        server_frame, offset = _unpack_u32(payload, offset)
        avatar, offset = _unpack_u8(payload, offset)
        _ensure_done(payload, offset)
        return SessionAccepted(
            session_id=session_id,
            server_frame=server_frame,
            avatar=PlayerAvatar(avatar),
        )

    if message_type is MessageType.WORLD_SNAPSHOT:
        map_id, offset = _unpack_u16(payload, offset)
        x, offset = _unpack_u16(payload, offset)
        y, offset = _unpack_u16(payload, offset)
        facing, offset = _unpack_u8(payload, offset)
        avatar, offset = _unpack_u8(payload, offset)
        server_frame, offset = _unpack_u32(payload, offset)
        traversal_state, offset = _unpack_u8(payload, offset)
        preferred_bike_type, offset = _unpack_u8(payload, offset)
        runtime, offset = _decode_bike_runtime(payload, offset)
        bike_effect_flags, offset = _unpack_u8(payload, offset)
        hash_len, offset = _unpack_u8(payload, offset)
        map_chunk_hash, offset = _unpack_exact(payload, offset, hash_len)
        map_chunk, offset = _unpack_bytes(payload, offset)
        _ensure_done(payload, offset)
        return WorldSnapshot(
            map_id=map_id,
            player_pos=Position(x=x, y=y),
            facing=Direction(facing),
            avatar=PlayerAvatar(avatar),
            map_chunk_hash=map_chunk_hash,
            map_chunk=map_chunk,
            server_frame=server_frame,
            traversal_state=TraversalState(traversal_state),
            preferred_bike_type=TraversalState(preferred_bike_type),
            authoritative_step_speed=runtime.step_speed,
            mach_speed_stage=runtime.mach_speed_stage,
            acro_substate=runtime.acro_substate,
            bike_transition=runtime.bike_transition,
            bunny_hop_cycle_tick=runtime.bunny_hop_cycle_tick,
            bike_effect_flags=bike_effect_flags,
        )

    if message_type is MessageType.WALK_RESULT:
        input_seq, offset = _unpack_u32(payload, offset)
        accepted, offset = _unpack_u8(payload, offset)
        x, offset = _unpack_u16(payload, offset)
        y, offset = _unpack_u16(payload, offset)
        facing, offset = _unpack_u8(payload, offset)
        reason, offset = _unpack_u8(payload, offset)
        server_frame, offset = _unpack_u32(payload, offset)
        traversal_state, offset = _unpack_u8(payload, offset)
        preferred_bike_type, offset = _unpack_u8(payload, offset)
        runtime, offset = _decode_bike_runtime(payload, offset)
        bike_effect_flags, offset = _unpack_u8(payload, offset)
        has_hop_landing_particle_class, offset = _unpack_u8(payload, offset)
        hop_landing_particle_class_raw, offset = _unpack_u8(payload, offset)
        has_hop_landing_tile, offset = _unpack_u8(payload, offset)
        hop_landing_tile_x, offset = _unpack_u16(payload, offset)
        hop_landing_tile_y, offset = _unpack_u16(payload, offset)
        _ensure_done(payload, offset)
        return WalkResult(
            input_seq=input_seq,
            accepted=bool(accepted),
            authoritative_pos=Position(x=x, y=y),
            facing=Direction(facing),
            reason=RejectionReason(reason),
            server_frame=server_frame,
            traversal_state=TraversalState(traversal_state),
            preferred_bike_type=TraversalState(preferred_bike_type),
            authoritative_step_speed=runtime.step_speed,
            mach_speed_stage=runtime.mach_speed_stage,
            acro_substate=runtime.acro_substate,
            bike_transition=runtime.bike_transition,
            bunny_hop_cycle_tick=runtime.bunny_hop_cycle_tick,
            bike_effect_flags=bike_effect_flags,
            hop_landing_particle_class=(
                HopLandingParticleClass(hop_landing_particle_class_raw)
                if has_hop_landing_particle_class != 0
                else None
            ),
            hop_landing_tile_x=hop_landing_tile_x if has_hop_landing_tile != 0 else None,
            hop_landing_tile_y=hop_landing_tile_y if has_hop_landing_tile != 0 else None,
        )

    if message_type is MessageType.WORLD_DELTA:
        map_id, offset = _unpack_u16(payload, offset)
        server_frame, offset = _unpack_u32(payload, offset)
        delta_blob, offset = _unpack_bytes(payload, offset)
        _ensure_done(payload, offset)
        return WorldDelta(map_id=map_id, server_frame=server_frame, delta_blob=delta_blob)

    if message_type is MessageType.BIKE_RUNTIME_DELTA:
        server_frame, offset = _unpack_u32(payload, offset)
        traversal_state, offset = _unpack_u8(payload, offset)
        runtime, offset = _decode_bike_runtime(payload, offset)
        has_hop_landing_particle_class, offset = _unpack_u8(payload, offset)
        hop_landing_particle_class_raw, offset = _unpack_u8(payload, offset)
        has_hop_landing_tile, offset = _unpack_u8(payload, offset)
        hop_landing_tile_x, offset = _unpack_u16(payload, offset)
        hop_landing_tile_y, offset = _unpack_u16(payload, offset)
        _ensure_done(payload, offset)
        return BikeRuntimeDelta(
            server_frame=server_frame,
            traversal_state=TraversalState(traversal_state),
            authoritative_step_speed=runtime.step_speed,
            mach_speed_stage=runtime.mach_speed_stage,
            acro_substate=runtime.acro_substate,
            bike_transition=runtime.bike_transition,
            bunny_hop_cycle_tick=runtime.bunny_hop_cycle_tick,
            hop_landing_particle_class=(
                HopLandingParticleClass(hop_landing_particle_class_raw)
                if has_hop_landing_particle_class != 0
                else None
            ),
            hop_landing_tile_x=hop_landing_tile_x if has_hop_landing_tile != 0 else None,
            hop_landing_tile_y=hop_landing_tile_y if has_hop_landing_tile != 0 else None,
        )

    raise ProtocolError(f"unsupported message type: {message_type}")


@dataclass(frozen=True)
class _DecodedBikeRuntime:
    step_speed: StepSpeed | None
    mach_speed_stage: int | None
    acro_substate: AcroBikeSubstate | None
    bike_transition: BikeTransitionType | None
    bunny_hop_cycle_tick: int | None


def _encode_bike_runtime(
    step_speed: StepSpeed | None,
    mach_speed_stage: int | None,
    acro_substate: AcroBikeSubstate | None,
    bike_transition: BikeTransitionType | None,
    bunny_hop_cycle_tick: int | None,
) -> tuple[bytes, int]:
    flags = 0
    payload = bytearray()

    if step_speed is not None:
        flags |= 0b1000
        payload.extend(_U8.pack(int(step_speed)))
    if mach_speed_stage is not None:
        flags |= 0b001
        payload.extend(_U8.pack(mach_speed_stage))
    if acro_substate is not None:
        flags |= 0b010
        payload.extend(_U8.pack(int(acro_substate)))
    if bike_transition is not None:
        flags |= 0b100
        payload.extend(_U8.pack(int(bike_transition)))
    if bunny_hop_cycle_tick is not None:
        flags |= 0b1_0000
        payload.extend(_U8.pack(bunny_hop_cycle_tick))

    return bytes(payload), flags


def _decode_bike_runtime(raw: bytes, offset: int) -> tuple[_DecodedBikeRuntime, int]:
    flags, offset = _unpack_u8(raw, offset)

    step_speed = None
    mach_speed_stage = None
    acro_substate = None
    bike_transition = None
    bunny_hop_cycle_tick = None

    if flags & 0b1000:
        value, offset = _unpack_u8(raw, offset)
        step_speed = StepSpeed(value)
    if flags & 0b001:
        mach_speed_stage, offset = _unpack_u8(raw, offset)
    if flags & 0b010:
        value, offset = _unpack_u8(raw, offset)
        acro_substate = AcroBikeSubstate(value)
    if flags & 0b100:
        value, offset = _unpack_u8(raw, offset)
        bike_transition = BikeTransitionType(value)
    if flags & 0b1_0000:
        bunny_hop_cycle_tick, offset = _unpack_u8(raw, offset)

    return (
        _DecodedBikeRuntime(
            step_speed=step_speed,
            mach_speed_stage=mach_speed_stage,
            acro_substate=acro_substate,
            bike_transition=bike_transition,
            bunny_hop_cycle_tick=bunny_hop_cycle_tick,
        ),
        offset,
    )


def _pack_str(value: str) -> bytes:
    return _pack_bytes(value.encode("utf-8"))


def _unpack_str(raw: bytes, offset: int) -> tuple[str, int]:
    value, offset = _unpack_bytes(raw, offset)
    return value.decode("utf-8"), offset


def _pack_bytes(value: bytes) -> bytes:
    return _U32.pack(len(value)) + value


def _unpack_bytes(raw: bytes, offset: int) -> tuple[bytes, int]:
    length, offset = _unpack_u32(raw, offset)
    return _unpack_exact(raw, offset, length)


def _unpack_exact(raw: bytes, offset: int, size: int) -> tuple[bytes, int]:
    end = offset + size
    if end > len(raw):
        raise ProtocolError("truncated payload")
    return raw[offset:end], end


def _unpack_u8(raw: bytes, offset: int) -> tuple[int, int]:
    return _U8.unpack_from(raw, offset)[0], offset + _U8.size


def _unpack_u16(raw: bytes, offset: int) -> tuple[int, int]:
    return _U16.unpack_from(raw, offset)[0], offset + _U16.size


def _unpack_u32(raw: bytes, offset: int) -> tuple[int, int]:
    return _U32.unpack_from(raw, offset)[0], offset + _U32.size


def _unpack_u64(raw: bytes, offset: int) -> tuple[int, int]:
    return _U64.unpack_from(raw, offset)[0], offset + _U64.size


def _ensure_done(raw: bytes, offset: int) -> None:
    if offset != len(raw):
        raise ProtocolError("unexpected trailing bytes")

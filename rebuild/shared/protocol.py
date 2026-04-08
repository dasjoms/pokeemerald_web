"""Authoritative wire protocol definitions for rebuild WebSocket traffic.

This module is the single source of truth for client/server message types,
message IDs, deterministic sequencing fields, and compact binary
serialization/deserialization.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import IntEnum
import struct

PROTOCOL_VERSION = 1

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

    # Server -> Client
    SESSION_ACCEPTED = 0x81
    WORLD_SNAPSHOT = 0x82
    WALK_RESULT = 0x83
    WORLD_DELTA = 0x84


class Direction(IntEnum):
    UP = 0
    DOWN = 1
    LEFT = 2
    RIGHT = 3


class RejectionReason(IntEnum):
    NONE = 0
    COLLISION = 1
    OUT_OF_BOUNDS = 2
    SEQUENCE_MISMATCH = 3
    NOT_JOINED = 4
    INVALID_DIRECTION = 5


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
    input_seq: int
    client_time: int


@dataclass(frozen=True)
class SessionAccepted:
    session_id: int
    server_frame: int


@dataclass(frozen=True)
class WorldSnapshot:
    map_id: int
    player_pos: Position
    facing: Direction
    map_chunk_hash: bytes
    map_chunk: bytes
    server_frame: int


@dataclass(frozen=True)
class WalkResult:
    input_seq: int
    accepted: bool
    authoritative_pos: Position
    facing: Direction
    reason: RejectionReason
    server_frame: int


@dataclass(frozen=True)
class WorldDelta:
    map_id: int
    server_frame: int
    delta_blob: bytes


WireMessage = JoinSession | WalkInput | SessionAccepted | WorldSnapshot | WalkResult | WorldDelta


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
                _U32.pack(message.input_seq),
                _U64.pack(message.client_time),
            ]
        )

    if isinstance(message, SessionAccepted):
        return MessageType.SESSION_ACCEPTED, b"".join(
            [_U32.pack(message.session_id), _U32.pack(message.server_frame)]
        )

    if isinstance(message, WorldSnapshot):
        hash_len = len(message.map_chunk_hash)
        if hash_len > 255:
            raise ProtocolError("map_chunk_hash must be <= 255 bytes")

        return MessageType.WORLD_SNAPSHOT, b"".join(
            [
                _U16.pack(message.map_id),
                _U16.pack(message.player_pos.x),
                _U16.pack(message.player_pos.y),
                _U8.pack(int(message.facing)),
                _U32.pack(message.server_frame),
                _U8.pack(hash_len),
                message.map_chunk_hash,
                _pack_bytes(message.map_chunk),
            ]
        )

    if isinstance(message, WalkResult):
        return MessageType.WALK_RESULT, b"".join(
            [
                _U32.pack(message.input_seq),
                _U8.pack(1 if message.accepted else 0),
                _U16.pack(message.authoritative_pos.x),
                _U16.pack(message.authoritative_pos.y),
                _U8.pack(int(message.facing)),
                _U8.pack(int(message.reason)),
                _U32.pack(message.server_frame),
            ]
        )

    if isinstance(message, WorldDelta):
        return MessageType.WORLD_DELTA, b"".join(
            [_U16.pack(message.map_id), _U32.pack(message.server_frame), _pack_bytes(message.delta_blob)]
        )

    raise TypeError(f"unsupported message type: {type(message).__name__}")


def _decode_payload(message_type: MessageType, payload: bytes) -> WireMessage:
    offset = 0

    if message_type is MessageType.JOIN_SESSION:
        player_id, _ = _unpack_str(payload, offset)
        return JoinSession(player_id=player_id)

    if message_type is MessageType.WALK_INPUT:
        direction, offset = _unpack_u8(payload, offset)
        input_seq, offset = _unpack_u32(payload, offset)
        client_time, offset = _unpack_u64(payload, offset)
        _ensure_done(payload, offset)
        return WalkInput(direction=Direction(direction), input_seq=input_seq, client_time=client_time)

    if message_type is MessageType.SESSION_ACCEPTED:
        session_id, offset = _unpack_u32(payload, offset)
        server_frame, offset = _unpack_u32(payload, offset)
        _ensure_done(payload, offset)
        return SessionAccepted(session_id=session_id, server_frame=server_frame)

    if message_type is MessageType.WORLD_SNAPSHOT:
        map_id, offset = _unpack_u16(payload, offset)
        x, offset = _unpack_u16(payload, offset)
        y, offset = _unpack_u16(payload, offset)
        facing, offset = _unpack_u8(payload, offset)
        server_frame, offset = _unpack_u32(payload, offset)
        hash_len, offset = _unpack_u8(payload, offset)
        map_chunk_hash, offset = _unpack_exact(payload, offset, hash_len)
        map_chunk, offset = _unpack_bytes(payload, offset)
        _ensure_done(payload, offset)
        return WorldSnapshot(
            map_id=map_id,
            player_pos=Position(x=x, y=y),
            facing=Direction(facing),
            map_chunk_hash=map_chunk_hash,
            map_chunk=map_chunk,
            server_frame=server_frame,
        )

    if message_type is MessageType.WALK_RESULT:
        input_seq, offset = _unpack_u32(payload, offset)
        accepted, offset = _unpack_u8(payload, offset)
        x, offset = _unpack_u16(payload, offset)
        y, offset = _unpack_u16(payload, offset)
        facing, offset = _unpack_u8(payload, offset)
        reason, offset = _unpack_u8(payload, offset)
        server_frame, offset = _unpack_u32(payload, offset)
        _ensure_done(payload, offset)
        return WalkResult(
            input_seq=input_seq,
            accepted=bool(accepted),
            authoritative_pos=Position(x=x, y=y),
            facing=Direction(facing),
            reason=RejectionReason(reason),
            server_frame=server_frame,
        )

    if message_type is MessageType.WORLD_DELTA:
        map_id, offset = _unpack_u16(payload, offset)
        server_frame, offset = _unpack_u32(payload, offset)
        delta_blob, offset = _unpack_bytes(payload, offset)
        _ensure_done(payload, offset)
        return WorldDelta(map_id=map_id, server_frame=server_frame, delta_blob=delta_blob)

    raise ProtocolError(f"unsupported message type: {message_type}")


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

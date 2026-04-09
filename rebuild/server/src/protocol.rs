#[path = "protocol_generated.rs"]
mod protocol_generated;

pub use protocol_generated::{
    AcroBikeSubstate, BikeTransitionType, DebugTraversalAction, DebugTraversalInput, Direction,
    HeldButtons, JoinSession, MessageType, MovementMode, PlayerAvatar, Position, RejectionReason,
    SessionAccepted, TraversalState, WalkInput, WalkResult, WorldDelta, WorldSnapshot,
    PROTOCOL_VERSION,
};
pub type Facing = Direction;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ClientMessage {
    JoinSession(JoinSession),
    WalkInput(WalkInput),
    DebugTraversalInput(DebugTraversalInput),
    WalkInputInvalidDirection { input_seq: u32, client_time: u64 },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ServerMessage {
    SessionAccepted(SessionAccepted),
    WorldSnapshot(WorldSnapshot),
    WalkResult(WalkResult),
    WorldDelta(WorldDelta),
}

#[derive(Debug, thiserror::Error)]
pub enum ProtocolError {
    #[error("frame too short")]
    FrameTooShort,
    #[error("unsupported protocol version: {0}")]
    UnsupportedVersion(u16),
    #[error("unknown message type: {0}")]
    UnknownMessageType(u8),
    #[error("payload length mismatch")]
    PayloadLengthMismatch,
    #[error("truncated payload")]
    TruncatedPayload,
    #[error("unexpected trailing bytes")]
    UnexpectedTrailingBytes,
    #[error("utf8 decode failure")]
    InvalidUtf8,
    #[error("invalid enum value")]
    InvalidEnum,
    #[error("invalid direction value: {0}")]
    InvalidDirection(u8),
    #[error("invalid movement mode value: {0}")]
    InvalidMovementMode(u8),
    #[error("map_chunk_hash must be <= 255 bytes")]
    MapChunkHashTooLong,
}

pub fn encode_server_message(message: &ServerMessage) -> Result<Vec<u8>, ProtocolError> {
    let (message_type, payload) = match message {
        ServerMessage::SessionAccepted(msg) => (
            MessageType::SessionAccepted,
            [
                msg.session_id.to_le_bytes().as_slice(),
                msg.server_frame.to_le_bytes().as_slice(),
                &[msg.avatar as u8],
            ]
            .concat(),
        ),
        ServerMessage::WorldSnapshot(msg) => {
            if msg.map_chunk_hash.len() > u8::MAX as usize {
                return Err(ProtocolError::MapChunkHashTooLong);
            }

            let mut payload = Vec::new();
            payload.extend_from_slice(&msg.map_id.to_le_bytes());
            payload.extend_from_slice(&msg.player_pos.x.to_le_bytes());
            payload.extend_from_slice(&msg.player_pos.y.to_le_bytes());
            payload.push(msg.facing as u8);
            payload.push(msg.avatar as u8);
            payload.extend_from_slice(&msg.server_frame.to_le_bytes());
            payload.push(msg.traversal_state as u8);
            payload.push(msg.preferred_bike_type as u8);
            encode_bike_runtime(
                &mut payload,
                msg.mach_speed_stage,
                msg.acro_substate,
                msg.bike_transition,
            );
            payload.push(msg.bike_effect_flags);
            payload.push(msg.map_chunk_hash.len() as u8);
            payload.extend_from_slice(&msg.map_chunk_hash);
            push_bytes(&mut payload, &msg.map_chunk);
            (MessageType::WorldSnapshot, payload)
        }
        ServerMessage::WalkResult(msg) => {
            let mut payload = Vec::new();
            payload.extend_from_slice(&msg.input_seq.to_le_bytes());
            payload.push(u8::from(msg.accepted));
            payload.extend_from_slice(&msg.authoritative_pos.x.to_le_bytes());
            payload.extend_from_slice(&msg.authoritative_pos.y.to_le_bytes());
            payload.push(msg.facing as u8);
            payload.push(msg.reason as u8);
            payload.extend_from_slice(&msg.server_frame.to_le_bytes());
            payload.push(msg.traversal_state as u8);
            payload.push(msg.preferred_bike_type as u8);
            encode_bike_runtime(
                &mut payload,
                msg.mach_speed_stage,
                msg.acro_substate,
                msg.bike_transition,
            );
            payload.push(msg.bike_effect_flags);
            (MessageType::WalkResult, payload)
        }
        ServerMessage::WorldDelta(msg) => {
            let mut payload = Vec::new();
            payload.extend_from_slice(&msg.map_id.to_le_bytes());
            payload.extend_from_slice(&msg.server_frame.to_le_bytes());
            push_bytes(&mut payload, &msg.delta_blob);
            (MessageType::WorldDelta, payload)
        }
    };

    let mut frame = Vec::with_capacity(7 + payload.len());
    frame.extend_from_slice(&PROTOCOL_VERSION.to_le_bytes());
    frame.push(message_type as u8);
    frame.extend_from_slice(&(payload.len() as u32).to_le_bytes());
    frame.extend_from_slice(&payload);
    Ok(frame)
}

pub fn decode_client_message(frame: &[u8]) -> Result<ClientMessage, ProtocolError> {
    if frame.len() < 7 {
        return Err(ProtocolError::FrameTooShort);
    }

    let version = u16::from_le_bytes([frame[0], frame[1]]);
    if version != PROTOCOL_VERSION {
        return Err(ProtocolError::UnsupportedVersion(version));
    }

    let message_type = frame[2];
    let payload_len = u32::from_le_bytes([frame[3], frame[4], frame[5], frame[6]]) as usize;
    let payload = &frame[7..];
    if payload.len() != payload_len {
        return Err(ProtocolError::PayloadLengthMismatch);
    }

    match message_type {
        x if x == MessageType::JoinSession as u8 => {
            let (player_id, offset) = unpack_string(payload, 0)?;
            ensure_done(payload, offset)?;
            Ok(ClientMessage::JoinSession(JoinSession { player_id }))
        }
        x if x == MessageType::WalkInput as u8 => {
            let (raw_direction, offset) = unpack_u8(payload, 0)?;
            let (raw_movement_mode, offset) = unpack_u8(payload, offset)?;
            let (held_buttons, offset) = unpack_u8(payload, offset)?;
            let (input_seq, offset) = unpack_u32(payload, offset)?;
            let (client_time, offset) = unpack_u64(payload, offset)?;
            ensure_done(payload, offset)?;
            match decode_direction(raw_direction) {
                Ok(direction) => match decode_movement_mode(raw_movement_mode) {
                    Ok(movement_mode) => Ok(ClientMessage::WalkInput(WalkInput {
                        direction,
                        movement_mode,
                        held_buttons,
                        input_seq,
                        client_time,
                    })),
                    Err(_) => Ok(ClientMessage::WalkInput(WalkInput {
                        direction,
                        movement_mode: MovementMode::Walk,
                        held_buttons,
                        input_seq,
                        client_time,
                    })),
                },
                Err(_) => Ok(ClientMessage::WalkInputInvalidDirection {
                    input_seq,
                    client_time,
                }),
            }
        }
        x if x == MessageType::DebugTraversalInput as u8 => {
            let (action, offset) = unpack_u8(payload, 0)?;
            ensure_done(payload, offset)?;
            Ok(ClientMessage::DebugTraversalInput(DebugTraversalInput {
                action: decode_debug_traversal_action(action)?,
            }))
        }
        _ => Err(ProtocolError::UnknownMessageType(message_type)),
    }
}

fn decode_debug_traversal_action(raw: u8) -> Result<DebugTraversalAction, ProtocolError> {
    match raw {
        0 => Ok(DebugTraversalAction::ToggleMount),
        1 => Ok(DebugTraversalAction::SwapBikeType),
        _ => Err(ProtocolError::InvalidEnum),
    }
}

fn decode_movement_mode(raw: u8) -> Result<MovementMode, ProtocolError> {
    match raw {
        0 => Ok(MovementMode::Walk),
        1 => Ok(MovementMode::Run),
        _ => Err(ProtocolError::InvalidMovementMode(raw)),
    }
}

fn encode_bike_runtime(
    payload: &mut Vec<u8>,
    mach_speed_stage: Option<u8>,
    acro_substate: Option<AcroBikeSubstate>,
    bike_transition: Option<BikeTransitionType>,
) {
    let mut flags = 0u8;
    if mach_speed_stage.is_some() {
        flags |= 0b001;
    }
    if acro_substate.is_some() {
        flags |= 0b010;
    }
    if bike_transition.is_some() {
        flags |= 0b100;
    }
    payload.push(flags);
    if let Some(speed) = mach_speed_stage {
        payload.push(speed);
    }
    if let Some(substate) = acro_substate {
        payload.push(substate as u8);
    }
    if let Some(transition) = bike_transition {
        payload.push(transition as u8);
    }
}

fn decode_direction(raw: u8) -> Result<Direction, ProtocolError> {
    match raw {
        0 => Ok(Direction::Up),
        1 => Ok(Direction::Down),
        2 => Ok(Direction::Left),
        3 => Ok(Direction::Right),
        _ => Err(ProtocolError::InvalidDirection(raw)),
    }
}

fn push_bytes(buffer: &mut Vec<u8>, bytes: &[u8]) {
    buffer.extend_from_slice(&(bytes.len() as u32).to_le_bytes());
    buffer.extend_from_slice(bytes);
}

fn unpack_string(raw: &[u8], offset: usize) -> Result<(String, usize), ProtocolError> {
    let (bytes, next) = unpack_bytes(raw, offset)?;
    let value = std::str::from_utf8(bytes).map_err(|_| ProtocolError::InvalidUtf8)?;
    Ok((value.to_owned(), next))
}

fn unpack_bytes(raw: &[u8], offset: usize) -> Result<(&[u8], usize), ProtocolError> {
    let (len, offset) = unpack_u32(raw, offset)?;
    unpack_exact(raw, offset, len as usize)
}

fn unpack_exact(raw: &[u8], offset: usize, size: usize) -> Result<(&[u8], usize), ProtocolError> {
    let end = offset.saturating_add(size);
    if end > raw.len() {
        return Err(ProtocolError::TruncatedPayload);
    }
    Ok((&raw[offset..end], end))
}

fn unpack_u8(raw: &[u8], offset: usize) -> Result<(u8, usize), ProtocolError> {
    let bytes = raw
        .get(offset)
        .copied()
        .ok_or(ProtocolError::TruncatedPayload)?;
    Ok((bytes, offset + 1))
}

fn unpack_u32(raw: &[u8], offset: usize) -> Result<(u32, usize), ProtocolError> {
    let bytes = raw
        .get(offset..offset + 4)
        .ok_or(ProtocolError::TruncatedPayload)?;
    Ok((
        u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]),
        offset + 4,
    ))
}

fn unpack_u64(raw: &[u8], offset: usize) -> Result<(u64, usize), ProtocolError> {
    let bytes = raw
        .get(offset..offset + 8)
        .ok_or(ProtocolError::TruncatedPayload)?;
    Ok((
        u64::from_le_bytes([
            bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5], bytes[6], bytes[7],
        ]),
        offset + 8,
    ))
}

fn ensure_done(raw: &[u8], offset: usize) -> Result<(), ProtocolError> {
    if offset != raw.len() {
        return Err(ProtocolError::UnexpectedTrailingBytes);
    }
    Ok(())
}

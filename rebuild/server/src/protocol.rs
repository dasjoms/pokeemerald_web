use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum Facing {
    Up,
    Down,
    Left,
    Right,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(tag = "type", content = "payload")]
pub enum ClientMessage {
    WalkInput(WalkInput),
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct WalkInput {
    pub input_seq: u32,
    pub facing: Facing,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(tag = "type", content = "payload")]
pub enum ServerMessage {
    SessionAccepted(SessionAccepted),
    WorldSnapshot(WorldSnapshot),
    WalkResult(WalkResult),
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct SessionAccepted {
    pub connection_id: u64,
    pub player_id: String,
    pub server_tick: u64,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct WorldSnapshot {
    pub map_id: String,
    pub map_width: u16,
    pub map_height: u16,
    pub player_tile_x: u16,
    pub player_tile_y: u16,
    pub facing: Facing,
    pub server_tick: u64,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct WalkResult {
    pub input_seq: u32,
    pub accepted: bool,
    pub player_tile_x: u16,
    pub player_tile_y: u16,
    pub facing: Facing,
    pub reason: WalkRejectReason,
    pub server_tick: u64,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum WalkRejectReason {
    None,
    Collision,
    OutOfBounds,
    ForcedMovementDisabled,
}

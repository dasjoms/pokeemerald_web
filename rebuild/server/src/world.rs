use std::{
    collections::HashMap,
    fs,
    sync::atomic::{AtomicU64, Ordering},
};

use anyhow::{anyhow, Context};
use serde::Deserialize;
use tokio::sync::{mpsc, RwLock};

use crate::{
    movement::{validate_walk, MoveRejectReason, MoveValidation, MovementMap},
    protocol::{Facing, ServerMessage, WalkInput, WalkRejectReason, WalkResult},
    session::{PlayerState, Session, SessionInit},
};

const DEFAULT_MAP_ID: &str = "MAP_LITTLEROOT_TOWN";

#[derive(Debug, Clone)]
pub struct MapData {
    pub map_id: String,
    pub width: u16,
    pub height: u16,
    pub collision: Vec<u8>,
    pub behavior: Vec<u8>,
}

#[derive(Debug)]
pub struct World {
    tick: AtomicU64,
    next_connection_id: AtomicU64,
    map: MapData,
    sessions: RwLock<HashMap<u64, Session>>,
}

impl World {
    pub fn load_littleroot(layout_path: &str) -> anyhow::Result<Self> {
        let map = MapData::from_layout_file(layout_path)?;
        Ok(Self {
            tick: AtomicU64::new(0),
            next_connection_id: AtomicU64::new(1),
            map,
            sessions: RwLock::new(HashMap::new()),
        })
    }

    pub fn map(&self) -> &MapData {
        &self.map
    }

    pub async fn current_tick(&self) -> u64 {
        self.tick.load(Ordering::SeqCst)
    }

    pub async fn create_session(
        &self,
        outbound: mpsc::UnboundedSender<ServerMessage>,
    ) -> SessionInit {
        let connection_id = self.next_connection_id.fetch_add(1, Ordering::SeqCst);
        let player_id = format!("player-{connection_id}");

        let (spawn_x, spawn_y) = self.map.first_walkable_tile().unwrap_or((0, 0));
        let session = Session::new(
            connection_id,
            player_id,
            PlayerState {
                tile_x: spawn_x,
                tile_y: spawn_y,
                facing: Facing::Down,
            },
            outbound,
        );

        let init = SessionInit::from(&session);
        self.sessions.write().await.insert(connection_id, session);
        init
    }

    pub async fn remove_session(&self, connection_id: u64) {
        self.sessions.write().await.remove(&connection_id);
    }

    pub async fn enqueue_walk_input(
        &self,
        connection_id: u64,
        input: WalkInput,
    ) -> anyhow::Result<()> {
        let mut sessions = self.sessions.write().await;
        let session = sessions
            .get_mut(&connection_id)
            .ok_or_else(|| anyhow!("unknown session {connection_id}"))?;
        session.enqueue_walk_input(input);
        Ok(())
    }

    pub async fn tick(&self) {
        let tick = self.tick.fetch_add(1, Ordering::SeqCst) + 1;
        let mut sessions = self.sessions.write().await;

        for session in sessions.values_mut() {
            let queued = session.take_ready_walk_inputs();
            for input in queued {
                session.player_state.facing = input.facing;
                let (accepted, reason) = match validate_walk(
                    session.player_state.tile_x,
                    session.player_state.tile_y,
                    input.facing,
                    MovementMap {
                        width: self.map.width,
                        height: self.map.height,
                        collision: &self.map.collision,
                        behavior: &self.map.behavior,
                    },
                ) {
                    MoveValidation::Accepted { next_x, next_y } => {
                        session.player_state.tile_x = next_x;
                        session.player_state.tile_y = next_y;
                        (true, WalkRejectReason::None)
                    }
                    MoveValidation::Rejected(reason) => (false, map_reject_reason(reason)),
                };

                let result = ServerMessage::WalkResult(WalkResult {
                    input_seq: input.input_seq,
                    accepted,
                    player_tile_x: session.player_state.tile_x,
                    player_tile_y: session.player_state.tile_y,
                    facing: session.player_state.facing,
                    reason,
                    server_tick: tick,
                });

                let _ = session.send(result);
            }
        }
    }
}

fn map_reject_reason(reason: MoveRejectReason) -> WalkRejectReason {
    match reason {
        MoveRejectReason::Collision => WalkRejectReason::Collision,
        MoveRejectReason::OutOfBounds => WalkRejectReason::OutOfBounds,
        MoveRejectReason::ForcedMovementDisabled => WalkRejectReason::ForcedMovementDisabled,
    }
}
impl MapData {
    fn from_layout_file(layout_path: &str) -> anyhow::Result<Self> {
        let raw = fs::read_to_string(layout_path)
            .with_context(|| format!("failed to read map layout at {layout_path}"))?;
        let decoded: LayoutArtifact = serde_json::from_str(&raw)
            .with_context(|| format!("failed to parse layout artifact at {layout_path}"))?;

        let tile_count = decoded.tiles.len();
        if tile_count != (decoded.width as usize * decoded.height as usize) {
            return Err(anyhow!(
                "layout tile count mismatch: got {tile_count}, expected {}",
                decoded.width as usize * decoded.height as usize
            ));
        }

        let mut collision = Vec::with_capacity(tile_count);
        let mut behavior = Vec::with_capacity(tile_count);
        for tile in decoded.tiles {
            collision.push(tile.collision);
            behavior.push(tile.behavior_id);
        }

        Ok(Self {
            map_id: DEFAULT_MAP_ID.to_string(),
            width: decoded.width,
            height: decoded.height,
            collision,
            behavior,
        })
    }

    pub fn first_walkable_tile(&self) -> Option<(u16, u16)> {
        self.collision
            .iter()
            .enumerate()
            .find(|(_, collision)| **collision == 0)
            .map(|(index, _)| {
                let x = (index % self.width as usize) as u16;
                let y = (index / self.width as usize) as u16;
                (x, y)
            })
    }
}

#[derive(Debug, Deserialize)]
struct LayoutArtifact {
    width: u16,
    height: u16,
    tiles: Vec<LayoutTile>,
}

#[derive(Debug, Deserialize)]
struct LayoutTile {
    collision: u8,
    behavior_id: u8,
}

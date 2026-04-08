use std::{
    collections::{HashMap, HashSet, VecDeque},
    fs,
    path::Path,
    sync::atomic::{AtomicU64, Ordering},
};

use anyhow::{anyhow, Context};
use serde::Deserialize;
use tokio::sync::{mpsc, RwLock};
use tracing::{error, trace};

use crate::{
    map_chunk::{serialize_world_snapshot_map_chunk, world_snapshot_map_chunk_hash},
    movement::{
        facing_delta, validate_walk, ConnectedDestination, MoveRejectReason, MoveValidation,
        MovementMap,
    },
    protocol::{
        Direction, RejectionReason, ServerMessage, SessionAccepted, WalkInput, WalkResult,
        WorldSnapshot,
    },
    session::{PlayerState, Session, SessionInit},
};

#[derive(Debug, Clone)]
pub struct MapConnection {
    pub direction: ConnectionDirection,
    pub offset: i32,
    pub target_map_id: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ConnectionDirection {
    Up,
    Down,
    Left,
    Right,
}

#[derive(Debug, Clone)]
pub struct MapData {
    pub map_id: String,
    pub width: u16,
    pub height: u16,
    pub metatile_id: Vec<u16>,
    pub collision: Vec<u8>,
    pub behavior: Vec<u8>,
    pub connections: Vec<MapConnection>,
}

#[derive(Debug)]
pub struct World {
    tick: AtomicU64,
    next_connection_id: AtomicU64,
    initial_map_id: String,
    maps: HashMap<String, MapData>,
    protocol_map_ids: HashMap<String, u16>,
    sessions: RwLock<HashMap<u64, Session>>,
}

impl World {
    pub fn load_from_assets(
        initial_map_id: &str,
        maps_index_path: &str,
        layouts_index_path: &str,
    ) -> anyhow::Result<Self> {
        let maps_index = load_maps_index(maps_index_path)?;
        let layouts_index = load_layouts_index(layouts_index_path)?;

        let mut known = HashMap::new();
        let mut protocol_map_ids = HashMap::new();
        for map in maps_index.maps {
            let protocol_map_id =
                to_protocol_map_id(map.group_index, map.map_index).with_context(|| {
                    format!(
                        "invalid protocol map id for {} with group_index={} map_index={}",
                        map.map_id, map.group_index, map.map_index
                    )
                })?;
            protocol_map_ids.insert(map.map_id.clone(), protocol_map_id);
            known.insert(map.map_id.clone(), map);
        }

        if !known.contains_key(initial_map_id) {
            return Err(anyhow!(
                "map id {initial_map_id} was not found in {maps_index_path}"
            ));
        }

        let mut loaded = HashMap::new();
        let mut queue = VecDeque::from([initial_map_id.to_string()]);
        let mut seen = HashSet::new();
        while let Some(map_id) = queue.pop_front() {
            if !seen.insert(map_id.clone()) {
                continue;
            }

            let map_entry = known
                .get(&map_id)
                .ok_or_else(|| anyhow!("missing map entry for connected map id {map_id}"))?;
            let layout_path =
                layout_path_for(&layouts_index, &map_entry.layout_id, layouts_index_path)?;
            let map = MapData::from_layout_file(
                &map_id,
                &layout_path,
                map_entry
                    .connections
                    .iter()
                    .cloned()
                    .map(Into::into)
                    .collect(),
            )?;

            for connection in &map.connections {
                if known.contains_key(&connection.target_map_id) {
                    queue.push_back(connection.target_map_id.clone());
                }
            }

            loaded.insert(map_id, map);
        }

        Ok(Self {
            tick: AtomicU64::new(0),
            next_connection_id: AtomicU64::new(1),
            initial_map_id: initial_map_id.to_string(),
            maps: loaded,
            protocol_map_ids,
            sessions: RwLock::new(HashMap::new()),
        })
    }

    pub fn map(&self, map_id: &str) -> Option<&MapData> {
        self.maps.get(map_id)
    }

    pub async fn current_tick(&self) -> u64 {
        self.tick.load(Ordering::SeqCst)
    }

    pub async fn create_session(
        &self,
        outbound: mpsc::UnboundedSender<ServerMessage>,
    ) -> anyhow::Result<SessionInit> {
        let connection_id = self.next_connection_id.fetch_add(1, Ordering::SeqCst);
        let player_id = format!("player-{connection_id}");

        let map = self
            .maps
            .get(&self.initial_map_id)
            .ok_or_else(|| anyhow!("initial map {} not loaded", self.initial_map_id))?;

        let (spawn_x, spawn_y) = map.first_walkable_tile().unwrap_or((0, 0));
        let session = Session::new(
            connection_id,
            player_id,
            PlayerState {
                map_id: self.initial_map_id.clone(),
                tile_x: spawn_x,
                tile_y: spawn_y,
                facing: Direction::Down,
            },
            outbound,
        );

        let init = SessionInit::from(&session);
        self.sessions.write().await.insert(connection_id, session);
        Ok(init)
    }

    pub async fn remove_session(&self, connection_id: u64) {
        self.sessions.write().await.remove(&connection_id);
    }

    pub async fn enqueue_walk_input(
        &self,
        connection_id: u64,
        input: WalkInput,
    ) -> anyhow::Result<()> {
        let tick = self.current_tick().await as u32;
        let mut sessions = self.sessions.write().await;
        let session = sessions
            .get_mut(&connection_id)
            .ok_or_else(|| anyhow!("unknown session {connection_id}"))?;

        if !session.joined {
            trace!(
                connection_id,
                expected_seq = session.next_expected_input_seq,
                received_seq = input.input_seq,
                reject_reason = ?RejectionReason::NotJoined,
                "rejecting walk input"
            );
            let _ = session.send(self.walk_rejection_for_session(
                session,
                input.input_seq,
                RejectionReason::NotJoined,
                tick,
            ));
            return Ok(());
        }

        if input.input_seq != session.next_expected_input_seq {
            trace!(
                connection_id,
                expected_seq = session.next_expected_input_seq,
                received_seq = input.input_seq,
                reject_reason = ?RejectionReason::SequenceMismatch,
                "rejecting walk input"
            );
            let _ = session.send(self.walk_rejection_for_session(
                session,
                input.input_seq,
                RejectionReason::SequenceMismatch,
                tick,
            ));
            return Ok(());
        }

        session.next_expected_input_seq = session.next_expected_input_seq.saturating_add(1);
        session.enqueue_walk_input(input);
        Ok(())
    }

    pub async fn reject_invalid_direction_input(
        &self,
        connection_id: u64,
        input_seq: u32,
    ) -> anyhow::Result<()> {
        let tick = self.current_tick().await as u32;
        let mut sessions = self.sessions.write().await;
        let session = sessions
            .get_mut(&connection_id)
            .ok_or_else(|| anyhow!("unknown session {connection_id}"))?;

        trace!(
            connection_id,
            expected_seq = session.next_expected_input_seq,
            received_seq = input_seq,
            reject_reason = ?RejectionReason::InvalidDirection,
            "rejecting walk input"
        );
        let _ = session.send(self.walk_rejection_for_session(
            session,
            input_seq,
            RejectionReason::InvalidDirection,
            tick,
        ));
        Ok(())
    }

    pub async fn join_session(&self, connection_id: u64) -> anyhow::Result<()> {
        let tick = self.current_tick().await as u32;
        let mut sessions = self.sessions.write().await;
        let session = sessions
            .get_mut(&connection_id)
            .ok_or_else(|| anyhow!("unknown session {connection_id}"))?;

        if session.joined {
            return Ok(());
        }

        let session_map_id = session.player_state.map_id.clone();
        let protocol_map_id = self
            .protocol_map_ids
            .get(&session_map_id)
            .copied()
            .ok_or_else(|| {
                let message = format!(
                    "failed to map session map id {} to protocol u16 for connection {}",
                    session_map_id, connection_id
                );
                error!(connection_id, map_id = %session_map_id, "{message}");
                anyhow!(message)
            })?;
        let map_chunk = {
            let map = self.maps.get(&session_map_id).ok_or_else(|| {
                let message = format!(
                    "failed to load map {} for world snapshot connection {}",
                    session_map_id, connection_id
                );
                error!(connection_id, map_id = %session_map_id, "{message}");
                anyhow!(message)
            })?;
            serialize_world_snapshot_map_chunk(map)
        };
        let map_chunk_hash = world_snapshot_map_chunk_hash(&map_chunk);

        session.joined = true;
        session.send(ServerMessage::SessionAccepted(SessionAccepted {
            session_id: session.connection_id as u32,
            server_frame: tick,
        }))?;
        session.send(ServerMessage::WorldSnapshot(WorldSnapshot {
            map_id: protocol_map_id,
            player_pos: crate::protocol::Position {
                x: session.player_state.tile_x,
                y: session.player_state.tile_y,
            },
            facing: session.player_state.facing,
            map_chunk_hash,
            map_chunk,
            server_frame: tick,
        }))?;

        Ok(())
    }

    pub async fn tick(&self) {
        let tick = self.tick.fetch_add(1, Ordering::SeqCst) + 1;
        let mut sessions = self.sessions.write().await;

        for session in sessions.values_mut() {
            let queued = session.take_ready_walk_inputs();
            for input in queued {
                session.player_state.facing = input.direction;

                let Some(current_map) = self.maps.get(&session.player_state.map_id) else {
                    let _ = session.send(ServerMessage::WalkResult(WalkResult {
                        input_seq: input.input_seq,
                        accepted: false,
                        authoritative_pos: crate::protocol::Position {
                            x: session.player_state.tile_x,
                            y: session.player_state.tile_y,
                        },
                        facing: session.player_state.facing,
                        reason: RejectionReason::OutOfBounds,
                        server_frame: tick as u32,
                    }));
                    continue;
                };

                let (dx, dy) = facing_delta(input.direction);
                let attempted_x = session.player_state.tile_x as i32 + dx;
                let attempted_y = session.player_state.tile_y as i32 + dy;

                let connection = if attempted_x < 0
                    || attempted_y < 0
                    || attempted_x >= current_map.width as i32
                    || attempted_y >= current_map.height as i32
                {
                    self.resolve_connected_destination(
                        current_map,
                        session.player_state.tile_x,
                        session.player_state.tile_y,
                        input.direction,
                    )
                } else {
                    None
                };

                let connected_destination =
                    connection.as_ref().map(|resolved| ConnectedDestination {
                        x: resolved.destination_x,
                        y: resolved.destination_y,
                        collision_bits: resolved.destination_collision,
                        behavior_id: resolved.destination_behavior,
                    });

                let (accepted, reason) = match validate_walk(
                    session.player_state.tile_x,
                    session.player_state.tile_y,
                    input.direction,
                    MovementMap {
                        width: current_map.width,
                        height: current_map.height,
                        collision: &current_map.collision,
                        behavior: &current_map.behavior,
                    },
                    connected_destination,
                ) {
                    MoveValidation::Accepted { next_x, next_y } => {
                        session.player_state.tile_x = next_x;
                        session.player_state.tile_y = next_y;
                        if let Some(resolved) = connection {
                            session.player_state.map_id = resolved.target_map_id;
                        }
                        (true, RejectionReason::None)
                    }
                    MoveValidation::Rejected(reason) => (false, map_reject_reason(reason)),
                };

                let result = ServerMessage::WalkResult(WalkResult {
                    input_seq: input.input_seq,
                    accepted,
                    authoritative_pos: crate::protocol::Position {
                        x: session.player_state.tile_x,
                        y: session.player_state.tile_y,
                    },
                    facing: session.player_state.facing,
                    reason,
                    server_frame: tick as u32,
                });

                let _ = session.send(result);
            }
        }
    }

    fn resolve_connected_destination(
        &self,
        current_map: &MapData,
        source_x: u16,
        source_y: u16,
        facing: Direction,
    ) -> Option<ResolvedConnection> {
        let connection = current_map
            .connections
            .iter()
            .find(|candidate| candidate.direction.matches_direction(facing))?;
        let target_map = self.maps.get(&connection.target_map_id)?;

        let (dest_x, dest_y) = match connection.direction {
            ConnectionDirection::Left => (
                target_map.width as i32 - 1,
                source_y as i32 - connection.offset,
            ),
            ConnectionDirection::Right => (0, source_y as i32 - connection.offset),
            ConnectionDirection::Up => (
                source_x as i32 - connection.offset,
                target_map.height as i32 - 1,
            ),
            ConnectionDirection::Down => (source_x as i32 - connection.offset, 0),
        };

        if dest_x < 0
            || dest_y < 0
            || dest_x >= target_map.width as i32
            || dest_y >= target_map.height as i32
        {
            return None;
        }

        let tile_index = dest_y as usize * target_map.width as usize + dest_x as usize;
        let destination_collision = *target_map.collision.get(tile_index)?;
        let destination_behavior = *target_map.behavior.get(tile_index)?;

        Some(ResolvedConnection {
            target_map_id: target_map.map_id.clone(),
            destination_x: dest_x as u16,
            destination_y: dest_y as u16,
            destination_collision,
            destination_behavior,
        })
    }

    fn walk_rejection_for_session(
        &self,
        session: &Session,
        input_seq: u32,
        reason: RejectionReason,
        server_frame: u32,
    ) -> ServerMessage {
        ServerMessage::WalkResult(WalkResult {
            input_seq,
            accepted: false,
            authoritative_pos: crate::protocol::Position {
                x: session.player_state.tile_x,
                y: session.player_state.tile_y,
            },
            facing: session.player_state.facing,
            reason,
            server_frame,
        })
    }
}

#[derive(Debug)]
struct ResolvedConnection {
    target_map_id: String,
    destination_x: u16,
    destination_y: u16,
    destination_collision: u8,
    destination_behavior: u8,
}

fn map_reject_reason(reason: MoveRejectReason) -> RejectionReason {
    match reason {
        MoveRejectReason::Collision => RejectionReason::Collision,
        MoveRejectReason::OutOfBounds => RejectionReason::OutOfBounds,
        MoveRejectReason::ForcedMovementDisabled => RejectionReason::ForcedMovementDisabled,
    }
}

impl ConnectionDirection {
    fn matches_direction(self, facing: Direction) -> bool {
        matches!(
            (self, facing),
            (ConnectionDirection::Up, Direction::Up)
                | (ConnectionDirection::Down, Direction::Down)
                | (ConnectionDirection::Left, Direction::Left)
                | (ConnectionDirection::Right, Direction::Right)
        )
    }
}

impl MapData {
    pub fn tile_count(&self) -> usize {
        self.width as usize * self.height as usize
    }

    fn from_layout_file(
        map_id: impl Into<String>,
        layout_path: &str,
        connections: Vec<MapConnection>,
    ) -> anyhow::Result<Self> {
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
        let mut metatile_id = Vec::with_capacity(tile_count);
        for tile in decoded.tiles {
            metatile_id.push(tile.metatile_id);
            collision.push(tile.collision);
            behavior.push(tile.behavior_id);
        }

        Ok(Self {
            map_id: map_id.into(),
            width: decoded.width,
            height: decoded.height,
            metatile_id,
            collision,
            behavior,
            connections,
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
    metatile_id: u16,
    collision: u8,
    behavior_id: u8,
}

#[derive(Debug, Deserialize)]
struct MapsIndex {
    maps: Vec<MapEntry>,
}

#[derive(Debug, Deserialize)]
struct MapEntry {
    map_id: String,
    group_index: u16,
    map_index: u16,
    layout_id: String,
    #[serde(default)]
    connections: Vec<MapIndexConnection>,
}

#[derive(Debug, Deserialize, Clone)]
struct MapIndexConnection {
    direction: ConnectionDirection,
    offset: i32,
    target_map_id: String,
}

#[derive(Debug, Deserialize)]
struct LayoutsIndex {
    layouts: Vec<LayoutEntry>,
}

#[derive(Debug, Deserialize)]
struct LayoutEntry {
    id: String,
    decoded_path: String,
}

fn load_maps_index(path: &str) -> anyhow::Result<MapsIndex> {
    let raw = std::fs::read_to_string(path)
        .with_context(|| format!("failed to read maps index at {path}"))?;
    serde_json::from_str(&raw).with_context(|| format!("failed to parse maps index at {path}"))
}

fn load_layouts_index(path: &str) -> anyhow::Result<LayoutsIndex> {
    let raw = std::fs::read_to_string(path)
        .with_context(|| format!("failed to read layouts index at {path}"))?;
    serde_json::from_str(&raw).with_context(|| format!("failed to parse layouts index at {path}"))
}

fn layout_path_for(
    layouts: &LayoutsIndex,
    layout_id: &str,
    layouts_index_path: &str,
) -> anyhow::Result<String> {
    let layout = layouts
        .layouts
        .iter()
        .find(|candidate| candidate.id == layout_id)
        .ok_or_else(|| anyhow!("layout id {layout_id} was not found in layouts index"))?;

    let base = Path::new(layouts_index_path).parent().ok_or_else(|| {
        anyhow!("layouts index path {layouts_index_path} had no parent directory")
    })?;
    Ok(base
        .join(&layout.decoded_path)
        .to_string_lossy()
        .into_owned())
}

impl From<MapIndexConnection> for MapConnection {
    fn from(value: MapIndexConnection) -> Self {
        Self {
            direction: value.direction,
            offset: value.offset,
            target_map_id: value.target_map_id,
        }
    }
}

fn to_protocol_map_id(group_index: u16, map_index: u16) -> anyhow::Result<u16> {
    if group_index > u8::MAX as u16 {
        return Err(anyhow!(
            "group index {group_index} is out of range for protocol map id"
        ));
    }
    if map_index > u8::MAX as u16 {
        return Err(anyhow!(
            "map index {map_index} is out of range for protocol map id"
        ));
    }

    Ok((group_index << 8) | map_index)
}

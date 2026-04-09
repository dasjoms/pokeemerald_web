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
    acro::{AcroAnimationAction, AcroState},
    map_chunk::{serialize_world_snapshot_map_chunk, world_snapshot_map_chunk_hash},
    movement::{
        facing_delta, get_player_speed, mach_speed_tier_for_frame_counter, player_speed_step_speed,
        validate_walk_with_context, ConnectedDestination, MoveRejectReason, MoveValidation,
        MovementMap, PlayerSpeed, TraversalContext, WALK_SAMPLE_MS,
    },
    protocol::{
        AcroBikeSubstate, BikeTransitionType, DebugTraversalAction, DebugTraversalInput, Direction,
        MovementMode, PlayerAvatar, RejectionReason, ServerMessage, SessionAccepted,
        TraversalState, WalkInput, WalkResult, WorldSnapshot,
    },
    session::{
        ActiveWalkTransition, BikeRuntimeState, CrackedFloorRuntimeState, PlayerState, Session,
        SessionInit, MAX_PENDING_WALK_INPUTS,
    },
};

const BIKE_EFFECT_TIRE_TRACKS: u8 = 1 << 0;
const BIKE_EFFECT_HOP_SFX: u8 = 1 << 1;
const BIKE_EFFECT_COLLISION_SFX: u8 = 1 << 2;
const BIKE_EFFECT_CYCLING_BGM_MOUNT: u8 = 1 << 3;
const BIKE_EFFECT_CYCLING_BGM_DISMOUNT: u8 = 1 << 4;

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
    pub allow_cycling: bool,
    pub allow_running: bool,
    pub connections: Vec<MapConnection>,
}

#[derive(Debug)]
pub struct World {
    tick: AtomicU64,
    next_connection_id: AtomicU64,
    initial_map_id: String,
    maps: HashMap<String, MapData>,
    protocol_map_ids: HashMap<String, u16>,
    player_profiles: RwLock<HashMap<String, PlayerProfile>>,
    sessions: RwLock<HashMap<u64, Session>>,
}

#[derive(Debug, Clone, Copy)]
struct PlayerProfile {
    avatar: PlayerAvatar,
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
                map_entry.allow_cycling,
                map_entry.allow_running,
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
            player_profiles: RwLock::new(HashMap::new()),
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
                avatar: PlayerAvatar::Brendan,
                traversal_state: TraversalState::OnFoot,
                preferred_bike_type: TraversalState::MachBike,
                bike_runtime: BikeRuntimeState::default(),
                cracked_floor: CrackedFloorRuntimeState::default(),
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

        if session.walk_inputs_len() >= MAX_PENDING_WALK_INPUTS {
            let dropped = session.drop_oldest_walk_input();
            if let Some(dropped_input) = dropped {
                trace!(
                    connection_id,
                    dropped_seq = dropped_input.input_seq,
                    incoming_seq = input.input_seq,
                    queue_capacity = MAX_PENDING_WALK_INPUTS,
                    "walk input queue at capacity; dropping oldest queued input"
                );
            }
        }

        session.next_expected_input_seq = session.next_expected_input_seq.saturating_add(1);
        session.held_direction = Some(input.direction);
        session.held_buttons = input.held_buttons;
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

    pub async fn join_session(
        &self,
        connection_id: u64,
        requested_player_id: &str,
    ) -> anyhow::Result<()> {
        let tick = self.current_tick().await as u32;
        let profile = self.load_or_create_profile(requested_player_id).await;
        let mut sessions = self.sessions.write().await;
        let session = sessions
            .get_mut(&connection_id)
            .ok_or_else(|| anyhow!("unknown session {connection_id}"))?;

        if session.joined {
            return Ok(());
        }

        session.player_id = requested_player_id.to_string();
        session.player_state.avatar = profile.avatar;
        session.joined = true;
        session.send(ServerMessage::SessionAccepted(SessionAccepted {
            session_id: session.connection_id as u32,
            server_frame: tick,
            avatar: session.player_state.avatar,
        }))?;
        session.send(ServerMessage::WorldSnapshot(
            self.world_snapshot_for_player_state(&session.player_state, tick)?,
        ))?;

        Ok(())
    }

    pub async fn handle_debug_traversal_input(
        &self,
        connection_id: u64,
        input: DebugTraversalInput,
    ) -> anyhow::Result<()> {
        let tick = self.current_tick().await as u32;
        let mut sessions = self.sessions.write().await;
        let session = sessions
            .get_mut(&connection_id)
            .ok_or_else(|| anyhow!("unknown session {connection_id}"))?;
        let Some(current_map) = self.maps.get(&session.player_state.map_id) else {
            return Ok(());
        };

        session.player_state.bike_runtime.last_transition = BikeTransitionType::None;
        match input.action {
            DebugTraversalAction::ToggleMount => {
                if current_map.allow_cycling {
                    if matches!(session.player_state.traversal_state, TraversalState::OnFoot) {
                        session.player_state.traversal_state =
                            session.player_state.preferred_bike_type;
                        session.player_state.bike_runtime = BikeRuntimeState::default();
                        session.player_state.bike_runtime.last_transition =
                            BikeTransitionType::Mount;
                    } else {
                        session.player_state.traversal_state = TraversalState::OnFoot;
                        session.player_state.bike_runtime = BikeRuntimeState::default();
                        session.player_state.bike_runtime.last_transition =
                            BikeTransitionType::Dismount;
                    }
                }
            }
            DebugTraversalAction::SwapBikeType => {
                session.player_state.preferred_bike_type =
                    swap_bike_type(session.player_state.preferred_bike_type);
                if matches!(
                    session.player_state.traversal_state,
                    TraversalState::MachBike | TraversalState::AcroBike
                ) {
                    session.player_state.traversal_state = session.player_state.preferred_bike_type;
                    session.player_state.bike_runtime = BikeRuntimeState::default();
                }
            }
        }

        session.send(ServerMessage::WorldSnapshot(
            self.world_snapshot_for_player_state(&session.player_state, tick)?,
        ))?;
        Ok(())
    }

    pub async fn tick(&self) {
        let tick = self.tick.fetch_add(1, Ordering::SeqCst) + 1;
        let mut sessions = self.sessions.write().await;
        const SERVER_TICK_MS: f32 = WALK_SAMPLE_MS;

        for session in sessions.values_mut() {
            session.player_state.bike_runtime.last_transition = BikeTransitionType::None;
            update_bike_runtime_per_tick(
                &mut session.player_state,
                session.held_direction,
                session.held_buttons,
            );

            if let Some(active_walk) = session.active_walk_transition.as_mut() {
                active_walk.advance(SERVER_TICK_MS);
                if active_walk.is_complete() {
                    session.player_state.map_id = active_walk.target_map_id.clone();
                    session.player_state.tile_x = active_walk.target_x;
                    session.player_state.tile_y = active_walk.target_y;
                    session.player_state.facing = active_walk.direction;

                    if session.player_state.map_id != active_walk.start_map_id {
                        match self
                            .world_snapshot_for_player_state(&session.player_state, tick as u32)
                        {
                            Ok(snapshot) => {
                                let _ = session.send(ServerMessage::WorldSnapshot(snapshot));
                            }
                            Err(error) => {
                                error!(
                                    connection_id = session.connection_id,
                                    previous_map_id = %active_walk.start_map_id,
                                    map_id = %session.player_state.map_id,
                                    "failed to build world snapshot after map transition: {error:#}"
                                );
                            }
                        }
                    }
                    session.active_walk_transition = None;
                } else if cfg!(debug_assertions) {
                    trace!(
                        connection_id = session.connection_id,
                        input_seq = active_walk.input_seq,
                        direction = ?active_walk.direction,
                        movement_mode = ?active_walk.movement_mode,
                        progress_pixels = active_walk.progress_pixels(),
                        "walk transition advanced"
                    );
                }
            }

            if session.active_walk_transition.is_some() {
                continue;
            }

            while let Some(input) = session.pop_walk_input() {
                let previous_map_id = session.player_state.map_id.clone();
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
                        traversal_state: session.player_state.traversal_state,
                        preferred_bike_type: session.player_state.preferred_bike_type,
                        mach_speed_stage: bike_mach_speed_for_traversal(&session.player_state),
                        acro_substate: bike_acro_substate_for_traversal(&session.player_state),
                        bike_transition: Some(session.player_state.bike_runtime.last_transition),
                        bike_effect_flags: 0,
                    }));
                    continue;
                };

                session.player_state.bike_runtime.last_transition = BikeTransitionType::None;

                if !current_map.allow_cycling
                    && !matches!(session.player_state.traversal_state, TraversalState::OnFoot)
                {
                    session.player_state.traversal_state = TraversalState::OnFoot;
                    session.player_state.bike_runtime = BikeRuntimeState::default();
                    session.player_state.bike_runtime.last_transition =
                        BikeTransitionType::Dismount;
                }

                let resolved_movement_mode = if matches!(
                    session.player_state.traversal_state,
                    TraversalState::MachBike | TraversalState::AcroBike
                ) {
                    input.movement_mode
                } else if matches!(input.movement_mode, MovementMode::Run)
                    && !current_map.allow_running
                {
                    MovementMode::Walk
                } else {
                    input.movement_mode
                };
                let attempted_player_speed = get_player_speed(
                    session.player_state.traversal_state,
                    resolved_movement_mode,
                    session.player_state.bike_runtime.bike_frame_counter,
                );
                let step_speed = player_speed_step_speed(attempted_player_speed);

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

                let (accepted, reason, authoritative_x, authoritative_y) =
                    match validate_walk_with_context(
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
                        TraversalContext {
                            traversal_state: session.player_state.traversal_state,
                            movement_mode: resolved_movement_mode,
                            bike_frame_counter: session
                                .player_state
                                .bike_runtime
                                .bike_frame_counter,
                            acro_substate: bike_acro_substate_for_traversal(&session.player_state),
                        },
                    ) {
                        MoveValidation::Accepted { next_x, next_y } => {
                            let target_map_id = connection
                                .as_ref()
                                .map_or(previous_map_id.clone(), |resolved| {
                                    resolved.target_map_id.clone()
                                });
                            session.active_walk_transition = Some(ActiveWalkTransition::new(
                                input.input_seq,
                                previous_map_id.clone(),
                                session.player_state.tile_x,
                                session.player_state.tile_y,
                                target_map_id,
                                next_x,
                                next_y,
                                input.direction,
                                resolved_movement_mode,
                                step_speed,
                            ));
                            (true, RejectionReason::None, next_x, next_y)
                        }
                        MoveValidation::Rejected(reason) => (
                            false,
                            map_reject_reason(reason),
                            session.player_state.tile_x,
                            session.player_state.tile_y,
                        ),
                    };

                let result = ServerMessage::WalkResult(WalkResult {
                    input_seq: input.input_seq,
                    accepted,
                    authoritative_pos: crate::protocol::Position {
                        x: authoritative_x,
                        y: authoritative_y,
                    },
                    facing: session.player_state.facing,
                    reason,
                    server_frame: tick as u32,
                    traversal_state: session.player_state.traversal_state,
                    preferred_bike_type: session.player_state.preferred_bike_type,
                    mach_speed_stage: bike_mach_speed_for_traversal(&session.player_state),
                    acro_substate: bike_acro_substate_for_traversal(&session.player_state),
                    bike_transition: Some(session.player_state.bike_runtime.last_transition),
                    bike_effect_flags: bike_effect_flags_for_step(
                        &session.player_state,
                        accepted,
                        reason,
                    ),
                });

                let _ = session.send(result);

                if accepted {
                    update_bike_runtime_after_step(&mut session.player_state, input.direction);
                    cracked_floor_per_step_callback(
                        &mut session.player_state,
                        current_map,
                        authoritative_x,
                        authoritative_y,
                        attempted_player_speed,
                    );
                    break;
                } else {
                    reset_bike_runtime_on_reject(&mut session.player_state);
                }
            }
        }
    }

    fn world_snapshot_for_player_state(
        &self,
        player_state: &PlayerState,
        server_frame: u32,
    ) -> anyhow::Result<WorldSnapshot> {
        let session_map_id = player_state.map_id.clone();
        let protocol_map_id = self
            .protocol_map_ids
            .get(&session_map_id)
            .copied()
            .ok_or_else(|| {
                anyhow!(
                    "failed to map session map id {} to protocol u16",
                    session_map_id
                )
            })?;
        let map_chunk = {
            let map = self.maps.get(&session_map_id).ok_or_else(|| {
                anyhow!("failed to load map {} for world snapshot", session_map_id)
            })?;
            serialize_world_snapshot_map_chunk(map)
        };
        let map_chunk_hash = world_snapshot_map_chunk_hash(&map_chunk);

        Ok(WorldSnapshot {
            map_id: protocol_map_id,
            player_pos: crate::protocol::Position {
                x: player_state.tile_x,
                y: player_state.tile_y,
            },
            facing: player_state.facing,
            avatar: player_state.avatar,
            map_chunk_hash,
            map_chunk,
            server_frame,
            traversal_state: player_state.traversal_state,
            preferred_bike_type: player_state.preferred_bike_type,
            mach_speed_stage: bike_mach_speed_for_traversal(player_state),
            acro_substate: bike_acro_substate_for_traversal(player_state),
            bike_transition: Some(player_state.bike_runtime.last_transition),
            bike_effect_flags: bike_effect_flags_for_snapshot(player_state),
        })
    }

    async fn load_or_create_profile(&self, player_id: &str) -> PlayerProfile {
        let mut profiles = self.player_profiles.write().await;
        *profiles
            .entry(player_id.to_string())
            .or_insert_with(|| PlayerProfile {
                avatar: avatar_for_player_id(player_id),
            })
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
            traversal_state: session.player_state.traversal_state,
            preferred_bike_type: session.player_state.preferred_bike_type,
            mach_speed_stage: bike_mach_speed_for_traversal(&session.player_state),
            acro_substate: bike_acro_substate_for_traversal(&session.player_state),
            bike_transition: Some(session.player_state.bike_runtime.last_transition),
            bike_effect_flags: bike_effect_flags_for_step(&session.player_state, false, reason),
        })
    }
}

fn bike_effect_flags_for_snapshot(player_state: &PlayerState) -> u8 {
    bike_effect_flags_from_transition(player_state.bike_runtime.last_transition)
}

fn bike_effect_flags_for_step(
    player_state: &PlayerState,
    accepted: bool,
    reason: RejectionReason,
) -> u8 {
    let mut flags = bike_effect_flags_from_transition(player_state.bike_runtime.last_transition);
    let is_on_bike = matches!(
        player_state.traversal_state,
        TraversalState::MachBike | TraversalState::AcroBike
    );
    if accepted && is_on_bike {
        flags |= BIKE_EFFECT_TIRE_TRACKS;
    }
    if !accepted && is_on_bike && matches!(reason, RejectionReason::Collision) {
        flags |= BIKE_EFFECT_COLLISION_SFX;
    }
    flags
}

fn bike_effect_flags_from_transition(transition: BikeTransitionType) -> u8 {
    let mut flags = 0;
    if matches!(
        transition,
        BikeTransitionType::Hop
            | BikeTransitionType::HopStanding
            | BikeTransitionType::HopMoving
            | BikeTransitionType::SideJump
            | BikeTransitionType::TurnJump
    ) {
        flags |= BIKE_EFFECT_HOP_SFX;
    }
    if matches!(transition, BikeTransitionType::Mount) {
        flags |= BIKE_EFFECT_CYCLING_BGM_MOUNT;
    }
    if matches!(transition, BikeTransitionType::Dismount) {
        flags |= BIKE_EFFECT_CYCLING_BGM_DISMOUNT;
    }
    flags
}

fn bike_mach_speed_for_traversal(player_state: &PlayerState) -> Option<u8> {
    if matches!(player_state.traversal_state, TraversalState::MachBike) {
        Some(player_state.bike_runtime.mach_speed_stage)
    } else {
        None
    }
}

fn bike_acro_substate_for_traversal(player_state: &PlayerState) -> Option<AcroBikeSubstate> {
    if matches!(player_state.traversal_state, TraversalState::AcroBike) {
        Some(player_state.bike_runtime.acro_state)
    } else {
        None
    }
}

fn swap_bike_type(current: TraversalState) -> TraversalState {
    match current {
        TraversalState::AcroBike => TraversalState::MachBike,
        TraversalState::OnFoot | TraversalState::MachBike => TraversalState::AcroBike,
    }
}

const MB_CRACKED_FLOOR: u8 = 0xD2;
const MB_CRACKED_FLOOR_HOLE: u8 = 0x6B;

fn reset_bike_runtime_on_reject(player_state: &mut PlayerState) {
    if matches!(player_state.traversal_state, TraversalState::MachBike) {
        player_state.bike_runtime.bike_frame_counter = player_state
            .bike_runtime
            .bike_frame_counter
            .saturating_sub(1);
        player_state.bike_runtime.mach_speed_stage = player_state.bike_runtime.bike_frame_counter;
        player_state.bike_runtime.speed_tier =
            mach_speed_tier_for_frame_counter(player_state.bike_runtime.bike_frame_counter) as u8;
    }
}

fn update_bike_runtime_after_step(player_state: &mut PlayerState, direction: Direction) {
    match player_state.traversal_state {
        TraversalState::OnFoot => {
            player_state.bike_runtime.bike_frame_counter = 0;
            player_state.bike_runtime.mach_speed_stage = 0;
            player_state.bike_runtime.speed_tier =
                mach_speed_tier_for_frame_counter(player_state.bike_runtime.bike_frame_counter)
                    as u8;
            player_state.bike_runtime.mach_dir_traveling = None;
            player_state.bike_runtime.acro_state = AcroBikeSubstate::None;
            player_state.bike_runtime.acro_runtime = Default::default();
        }
        TraversalState::MachBike => {
            if player_state.bike_runtime.mach_dir_traveling == Some(direction) {
                if player_state.bike_runtime.bike_frame_counter < 2 {
                    player_state.bike_runtime.bike_frame_counter += 1;
                }
            } else if player_state.bike_runtime.bike_frame_counter > 0 {
                player_state.bike_runtime.bike_frame_counter -= 1;
            }
            player_state.bike_runtime.mach_dir_traveling = Some(direction);
            player_state.bike_runtime.mach_speed_stage =
                player_state.bike_runtime.bike_frame_counter;
            player_state.bike_runtime.speed_tier =
                mach_speed_tier_for_frame_counter(player_state.bike_runtime.bike_frame_counter)
                    as u8;
        }
        TraversalState::AcroBike => {
            let action = player_state
                .bike_runtime
                .acro_runtime
                .apply_step(player_state.facing, direction);

            player_state.bike_runtime.acro_state =
                match player_state.bike_runtime.acro_runtime.state {
                    AcroState::Normal
                    | AcroState::Turning
                    | AcroState::SideJump
                    | AcroState::TurnJump => AcroBikeSubstate::None,
                    AcroState::WheelieStanding => AcroBikeSubstate::StandingWheelie,
                    AcroState::BunnyHop => AcroBikeSubstate::BunnyHop,
                    AcroState::WheelieMoving => AcroBikeSubstate::MovingWheelie,
                };
            player_state.bike_runtime.last_transition = match action {
                AcroAnimationAction::None => BikeTransitionType::None,
                AcroAnimationAction::WheelieIdle => BikeTransitionType::WheelieIdle,
                AcroAnimationAction::WheeliePop => BikeTransitionType::WheeliePop,
                AcroAnimationAction::WheelieEnd => BikeTransitionType::WheelieEnd,
                AcroAnimationAction::HopStanding => BikeTransitionType::HopStanding,
                AcroAnimationAction::HopMoving => BikeTransitionType::HopMoving,
                AcroAnimationAction::SideJump => BikeTransitionType::SideJump,
                AcroAnimationAction::TurnJump => BikeTransitionType::TurnJump,
            };
        }
    }
}

fn update_bike_runtime_per_tick(
    player_state: &mut PlayerState,
    held_direction: Option<Direction>,
    held_buttons: u8,
) {
    if !matches!(player_state.traversal_state, TraversalState::AcroBike) {
        return;
    }

    let holding_b = (held_buttons & crate::protocol::HeldButtons::B as u8) != 0;
    let previous_state = player_state.bike_runtime.acro_runtime.state;
    player_state
        .bike_runtime
        .acro_runtime
        .set_held_input(held_direction, holding_b);
    player_state.bike_runtime.acro_runtime.advance_tick();
    let current_state = player_state.bike_runtime.acro_runtime.state;
    player_state.bike_runtime.acro_state = match player_state.bike_runtime.acro_runtime.state {
        AcroState::Normal | AcroState::Turning | AcroState::SideJump | AcroState::TurnJump => {
            AcroBikeSubstate::None
        }
        AcroState::WheelieStanding => AcroBikeSubstate::StandingWheelie,
        AcroState::BunnyHop => AcroBikeSubstate::BunnyHop,
        AcroState::WheelieMoving => AcroBikeSubstate::MovingWheelie,
    };
    player_state.bike_runtime.last_transition = match (previous_state, current_state) {
        (prev, cur) if prev == cur => BikeTransitionType::None,
        (AcroState::BunnyHop, AcroState::Normal)
        | (AcroState::WheelieStanding, AcroState::Normal)
        | (AcroState::WheelieMoving, AcroState::Normal) => BikeTransitionType::WheelieEnd,
        (_, AcroState::BunnyHop) => BikeTransitionType::HopStanding,
        (_, AcroState::WheelieStanding) | (_, AcroState::WheelieMoving) => {
            BikeTransitionType::WheeliePop
        }
        _ => BikeTransitionType::None,
    };
}

fn avatar_for_player_id(player_id: &str) -> PlayerAvatar {
    let mut hash = 0u8;
    for byte in player_id.bytes() {
        hash ^= byte;
    }

    if hash & 1 == 0 {
        PlayerAvatar::Brendan
    } else {
        PlayerAvatar::May
    }
}

fn cracked_floor_per_step_callback(
    player_state: &mut PlayerState,
    map: &MapData,
    x: u16,
    y: u16,
    player_speed: PlayerSpeed,
) {
    for pending in &mut player_state.cracked_floor.pending_floors {
        if pending.delay_steps > 0 {
            pending.delay_steps -= 1;
            if pending.delay_steps == 0 {
                pending.collapsed = true;
            }
        }
    }

    if x == player_state.cracked_floor.prev_x
        && y == player_state.cracked_floor.prev_y
        && player_state.map_id == player_state.cracked_floor.prev_map_id
    {
        return;
    }

    player_state.cracked_floor.prev_map_id = player_state.map_id.clone();
    player_state.cracked_floor.prev_x = x;
    player_state.cracked_floor.prev_y = y;

    let idx = y as usize * map.width as usize + x as usize;
    let behavior = map.behavior.get(idx).copied().unwrap_or_default();
    if behavior == MB_CRACKED_FLOOR_HOLE {
        player_state.cracked_floor.failed_speed_gate = true;
    }

    if behavior != MB_CRACKED_FLOOR {
        return;
    }

    if !matches!(player_speed, PlayerSpeed::Fastest) {
        player_state.cracked_floor.failed_speed_gate = true;
    }

    if let Some(slot) = player_state
        .cracked_floor
        .pending_floors
        .iter_mut()
        .find(|slot| slot.delay_steps == 0 && !slot.collapsed)
    {
        slot.delay_steps = 3;
        slot.x = x;
        slot.y = y;
        slot.map_id = player_state.map_id.clone();
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
        allow_cycling: bool,
        allow_running: bool,
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
            allow_cycling,
            allow_running,
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
    #[serde(default = "default_true")]
    allow_cycling: bool,
    #[serde(default = "default_true")]
    allow_running: bool,
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

fn default_true() -> bool {
    true
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

#[cfg(test)]
mod tests {
    use super::*;

    fn test_player_state() -> PlayerState {
        PlayerState {
            map_id: "MAP_SKY_PILLAR_2F".to_string(),
            tile_x: 0,
            tile_y: 0,
            facing: Direction::Right,
            avatar: PlayerAvatar::Brendan,
            traversal_state: TraversalState::MachBike,
            preferred_bike_type: TraversalState::MachBike,
            bike_runtime: BikeRuntimeState::default(),
            cracked_floor: CrackedFloorRuntimeState::default(),
        }
    }

    #[test]
    fn mach_bike_frame_counter_accelerates_and_slows_on_direction_change() {
        let mut player = test_player_state();
        update_bike_runtime_after_step(&mut player, Direction::Right);
        assert_eq!(player.bike_runtime.bike_frame_counter, 0);

        update_bike_runtime_after_step(&mut player, Direction::Right);
        assert_eq!(player.bike_runtime.bike_frame_counter, 1);

        update_bike_runtime_after_step(&mut player, Direction::Right);
        assert_eq!(player.bike_runtime.bike_frame_counter, 2);

        update_bike_runtime_after_step(&mut player, Direction::Left);
        assert_eq!(player.bike_runtime.bike_frame_counter, 1);
    }

    #[test]
    fn cracked_floor_callback_schedules_delayed_collapse_and_speed_gate() {
        let mut player = test_player_state();
        let map = MapData {
            map_id: "MAP_SKY_PILLAR_2F".to_string(),
            width: 4,
            height: 1,
            metatile_id: vec![0; 4],
            collision: vec![0; 4],
            behavior: vec![MB_CRACKED_FLOOR, 0, 0, 0],
            allow_cycling: true,
            allow_running: true,
            connections: vec![],
        };

        cracked_floor_per_step_callback(&mut player, &map, 0, 0, PlayerSpeed::Fast);
        assert!(player.cracked_floor.failed_speed_gate);
        assert_eq!(player.cracked_floor.pending_floors[0].delay_steps, 3);

        cracked_floor_per_step_callback(&mut player, &map, 1, 0, PlayerSpeed::Normal);
        assert_eq!(player.cracked_floor.pending_floors[0].delay_steps, 2);
        cracked_floor_per_step_callback(&mut player, &map, 2, 0, PlayerSpeed::Normal);
        assert_eq!(player.cracked_floor.pending_floors[0].delay_steps, 1);
        cracked_floor_per_step_callback(&mut player, &map, 3, 0, PlayerSpeed::Normal);
        assert!(player.cracked_floor.pending_floors[0].collapsed);
    }

    #[test]
    fn bike_effect_flags_include_tire_tracks_for_accepted_bike_steps() {
        let player = test_player_state();
        let flags = bike_effect_flags_for_step(&player, true, RejectionReason::None);
        assert_ne!(flags & BIKE_EFFECT_TIRE_TRACKS, 0);
    }

    #[test]
    fn bike_effect_flags_include_collision_sfx_for_rejected_bike_collision() {
        let player = test_player_state();
        let flags = bike_effect_flags_for_step(&player, false, RejectionReason::Collision);
        assert_ne!(flags & BIKE_EFFECT_COLLISION_SFX, 0);
    }

    #[test]
    fn swap_bike_type_toggles_between_mach_and_acro() {
        assert_eq!(
            swap_bike_type(TraversalState::MachBike),
            TraversalState::AcroBike
        );
        assert_eq!(
            swap_bike_type(TraversalState::AcroBike),
            TraversalState::MachBike
        );
        assert_eq!(
            swap_bike_type(TraversalState::OnFoot),
            TraversalState::AcroBike
        );
    }
}

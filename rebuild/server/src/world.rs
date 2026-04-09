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
        facing_delta, get_player_speed, is_biking_disallowed_by_player as movement_bike_gate,
        mach_speed_tier_for_frame_counter, player_speed_step_speed,
        should_force_muddy_slope_slide_back, validate_walk_with_context, CollisionOutcome,
        ConnectedDestination, MoveRejectReason, MoveValidation, MovementMap, PlayerSpeed,
        StepSpeed as MovementStepSpeed, TraversalContext, WALK_SAMPLE_MS,
    },
    protocol::{
        AcroBikeSubstate, BikeRuntimeDelta, BikeTransitionType, DebugTraversalAction,
        DebugTraversalInput, Direction, HeldInputState, MovementMode, PlayerAction,
        PlayerActionInput, PlayerAvatar, RejectionReason, ServerMessage, SessionAccepted,
        StepSpeed, TraversalState, WalkInput, WalkResult, WorldSnapshot,
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
const MB_BUMPY_SLOPE: u8 = 0xD1;

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
        session.enqueue_walk_input(input);
        Ok(())
    }

    pub async fn enqueue_held_input_state(
        &self,
        connection_id: u64,
        input: HeldInputState,
    ) -> anyhow::Result<()> {
        let mut sessions = self.sessions.write().await;
        let session = sessions
            .get_mut(&connection_id)
            .ok_or_else(|| anyhow!("unknown session {connection_id}"))?;

        if !session.joined {
            return Ok(());
        }

        if input.input_seq < session.next_expected_held_input_seq {
            trace!(
                connection_id,
                expected_seq = session.next_expected_held_input_seq,
                received_seq = input.input_seq,
                "dropping stale held input state"
            );
            return Ok(());
        }

        session.next_expected_held_input_seq = input.input_seq.saturating_add(1);
        session.apply_held_input_state(input);
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

        match input.action {
            DebugTraversalAction::ToggleMount => {
                apply_bike_mount_toggle(&mut session.player_state, current_map, false);
            }
            DebugTraversalAction::SwapBikeType => {
                apply_bike_swap(&mut session.player_state, current_map, false);
            }
        }

        session.send(ServerMessage::WorldSnapshot(
            self.world_snapshot_for_player_state(&session.player_state, tick)?,
        ))?;
        Ok(())
    }

    pub async fn handle_player_action_input(
        &self,
        connection_id: u64,
        input: PlayerActionInput,
    ) -> anyhow::Result<()> {
        let tick = self.current_tick().await as u32;
        let mut sessions = self.sessions.write().await;
        let session = sessions
            .get_mut(&connection_id)
            .ok_or_else(|| anyhow!("unknown session {connection_id}"))?;
        let Some(current_map) = self.maps.get(&session.player_state.map_id) else {
            return Ok(());
        };

        match input.action {
            PlayerAction::UseRegisteredBike => {
                apply_bike_mount_toggle(&mut session.player_state, current_map, true);
            }
            PlayerAction::SwapBikeType => {
                apply_bike_swap(&mut session.player_state, current_map, true);
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
            let previous_traversal_state = session.player_state.traversal_state;
            let previous_acro_substate = bike_acro_substate_for_traversal(&session.player_state);
            let previous_bike_transition = session.player_state.bike_runtime.last_transition;
            if !session
                .player_state
                .bike_runtime
                .preserve_transition_until_walk_result
            {
                session.player_state.bike_runtime.last_transition = BikeTransitionType::None;
            }
            let on_bumpy_slope = self.maps.get(&session.player_state.map_id).and_then(|map| {
                let idx = session.player_state.tile_y as usize * map.width as usize
                    + session.player_state.tile_x as usize;
                map.behavior.get(idx).copied()
            }) == Some(MB_BUMPY_SLOPE);
            session
                .player_state
                .bike_runtime
                .acro_runtime
                .set_on_bumpy_slope(on_bumpy_slope);
            update_bike_runtime_per_tick(
                &mut session.player_state,
                session.held_direction,
                session.held_buttons,
            );
            let current_acro_substate = bike_acro_substate_for_traversal(&session.player_state);
            let current_bike_transition = session.player_state.bike_runtime.last_transition;
            let traversal_changed =
                session.player_state.traversal_state != previous_traversal_state;
            let runtime_changed = current_acro_substate != previous_acro_substate
                || current_bike_transition != previous_bike_transition;
            if session.joined && (traversal_changed || runtime_changed) {
                let _ = session.send(ServerMessage::BikeRuntimeDelta(BikeRuntimeDelta {
                    server_frame: tick as u32,
                    traversal_state: session.player_state.traversal_state,
                    authoritative_step_speed: Some(player_step_speed_for_snapshot(
                        &session.player_state,
                    )),
                    mach_speed_stage: bike_mach_speed_for_traversal(&session.player_state),
                    acro_substate: current_acro_substate,
                    bike_transition: Some(current_bike_transition),
                }));
            }

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

                let Some(current_map) = self.maps.get(&session.player_state.map_id) else {
                    session.player_state.facing = input.direction;
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
                        authoritative_step_speed: Some(player_step_speed_for_snapshot(
                            &session.player_state,
                        )),
                        mach_speed_stage: bike_mach_speed_for_traversal(&session.player_state),
                        acro_substate: bike_acro_substate_for_traversal(&session.player_state),
                        bike_transition: Some(session.player_state.bike_runtime.last_transition),
                        bike_effect_flags: 0,
                    }));
                    continue;
                };

                if !session
                    .player_state
                    .bike_runtime
                    .preserve_transition_until_walk_result
                {
                    session.player_state.bike_runtime.last_transition = BikeTransitionType::None;
                }

                if !current_map.allow_cycling
                    && !matches!(session.player_state.traversal_state, TraversalState::OnFoot)
                {
                    set_traversal_state(
                        &mut session.player_state,
                        TraversalState::OnFoot,
                        None,
                        BikeTransitionType::Dismount,
                        true,
                    );
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
                let source_idx = session.player_state.tile_y as usize * current_map.width as usize
                    + session.player_state.tile_x as usize;
                let source_behavior = current_map
                    .behavior
                    .get(source_idx)
                    .copied()
                    .unwrap_or_default();
                let movement_direction = if should_force_muddy_slope_slide_back(
                    source_behavior,
                    input.direction,
                    attempted_player_speed,
                ) {
                    Direction::Down
                } else {
                    input.direction
                };
                session.player_state.facing = movement_direction;

                let (dx, dy) = facing_delta(movement_direction);
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
                        movement_direction,
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

                let (accepted, reason, authoritative_x, authoritative_y, collision_outcome) =
                    match validate_walk_with_context(
                        session.player_state.tile_x,
                        session.player_state.tile_y,
                        movement_direction,
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
                        MoveValidation::Accepted {
                            next_x,
                            next_y,
                            collision,
                        } => {
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
                                movement_direction,
                                resolved_movement_mode,
                                step_speed,
                            ));
                            (true, RejectionReason::None, next_x, next_y, collision)
                        }
                        MoveValidation::Rejected { reason, collision } => (
                            false,
                            map_reject_reason(reason),
                            session.player_state.tile_x,
                            session.player_state.tile_y,
                            collision,
                        ),
                    };

                if accepted {
                    update_bike_runtime_after_step(&mut session.player_state, movement_direction);
                    apply_bike_transition_for_collision_outcome(
                        &mut session.player_state,
                        collision_outcome,
                    );
                    cracked_floor_per_step_callback(
                        &mut session.player_state,
                        current_map,
                        authoritative_x,
                        authoritative_y,
                        attempted_player_speed,
                    );
                } else {
                    reset_bike_runtime_on_reject(
                        &mut session.player_state,
                        reason,
                        source_behavior,
                        collision_outcome,
                    );
                }

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
                    authoritative_step_speed: Some(step_speed_to_protocol(step_speed)),
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
                session
                    .player_state
                    .bike_runtime
                    .preserve_transition_until_walk_result = false;

                if accepted {
                    break;
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
            authoritative_step_speed: Some(player_step_speed_for_snapshot(player_state)),
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
            authoritative_step_speed: Some(player_step_speed_for_snapshot(&session.player_state)),
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

fn player_step_speed_for_snapshot(player_state: &PlayerState) -> StepSpeed {
    let player_speed = get_player_speed(
        player_state.traversal_state,
        MovementMode::Walk,
        player_state.bike_runtime.bike_frame_counter,
    );
    step_speed_to_protocol(player_speed_step_speed(player_speed))
}

fn step_speed_to_protocol(step_speed: MovementStepSpeed) -> StepSpeed {
    match step_speed {
        MovementStepSpeed::Step1 => StepSpeed::Step1,
        MovementStepSpeed::Step2 => StepSpeed::Step2,
        MovementStepSpeed::Step3 => StepSpeed::Step3,
        MovementStepSpeed::Step4 => StepSpeed::Step4,
        MovementStepSpeed::Step8 => StepSpeed::Step8,
    }
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
            | BikeTransitionType::WheelieHoppingStanding
            | BikeTransitionType::WheelieHoppingMoving
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

fn source_tile_behavior(map: &MapData, player_state: &PlayerState) -> Option<u8> {
    map.behavior
        .get(player_state.tile_y as usize * map.width as usize + player_state.tile_x as usize)
        .copied()
}

fn is_biking_disallowed_by_player(
    map: &MapData,
    player_state: &PlayerState,
    source_behavior: Option<u8>,
) -> bool {
    if !map.allow_cycling {
        return true;
    }
    let Some(behavior) = source_behavior else {
        return true;
    };
    movement_bike_gate(player_state.facing, behavior)
}

fn apply_bike_mount_toggle(player_state: &mut PlayerState, current_map: &MapData, strict: bool) {
    if matches!(player_state.traversal_state, TraversalState::OnFoot) {
        let source_behavior = source_tile_behavior(current_map, player_state);
        if strict && is_biking_disallowed_by_player(current_map, player_state, source_behavior) {
            return;
        }
        set_traversal_state(
            player_state,
            player_state.preferred_bike_type,
            source_behavior,
            BikeTransitionType::Mount,
            true,
        );
    } else {
        set_traversal_state(
            player_state,
            TraversalState::OnFoot,
            None,
            BikeTransitionType::Dismount,
            true,
        );
    }
}

fn apply_bike_swap(player_state: &mut PlayerState, current_map: &MapData, strict: bool) {
    player_state.preferred_bike_type = swap_bike_type(player_state.preferred_bike_type);
    if !matches!(
        player_state.traversal_state,
        TraversalState::MachBike | TraversalState::AcroBike
    ) {
        return;
    }

    let source_behavior = source_tile_behavior(current_map, player_state);
    if strict && is_biking_disallowed_by_player(current_map, player_state, source_behavior) {
        return;
    }
    set_traversal_state(
        player_state,
        player_state.preferred_bike_type,
        source_behavior,
        BikeTransitionType::None,
        false,
    );
}

fn swap_bike_type(current: TraversalState) -> TraversalState {
    match current {
        TraversalState::AcroBike => TraversalState::MachBike,
        TraversalState::OnFoot | TraversalState::MachBike => TraversalState::AcroBike,
    }
}

fn set_traversal_state(
    player_state: &mut PlayerState,
    traversal_state: TraversalState,
    source_tile_behavior: Option<u8>,
    transition: BikeTransitionType,
    preserve_until_walk_result: bool,
) {
    player_state.traversal_state = traversal_state;
    player_state.bike_runtime = BikeRuntimeState::default();
    player_state.bike_runtime.last_transition = transition;
    player_state
        .bike_runtime
        .preserve_transition_until_walk_result = preserve_until_walk_result;

    if matches!(traversal_state, TraversalState::AcroBike)
        && source_tile_behavior == Some(MB_BUMPY_SLOPE)
    {
        let action = player_state
            .bike_runtime
            .acro_runtime
            .handle_bumpy_slope_mount_transition(player_state.facing);
        player_state.bike_runtime.acro_state = AcroBikeSubstate::StandingWheelie;
        player_state.bike_runtime.last_transition = match action {
            AcroAnimationAction::WheelieIdle => BikeTransitionType::WheelieIdle,
            _ => BikeTransitionType::None,
        };
    }
}

const MB_CRACKED_FLOOR: u8 = 0xD2;
const MB_CRACKED_FLOOR_HOLE: u8 = 0x6B;

fn reset_bike_runtime_on_reject(
    player_state: &mut PlayerState,
    reason: RejectionReason,
    source_behavior: u8,
    collision: CollisionOutcome,
) {
    if matches!(player_state.traversal_state, TraversalState::MachBike) {
        player_state.bike_runtime.bike_frame_counter = player_state
            .bike_runtime
            .bike_frame_counter
            .saturating_sub(1);
        player_state.bike_runtime.mach_speed_stage = player_state.bike_runtime.bike_frame_counter;
        player_state.bike_runtime.speed_tier =
            mach_speed_tier_for_frame_counter(player_state.bike_runtime.bike_frame_counter) as u8;
        return;
    }

    if matches!(player_state.traversal_state, TraversalState::AcroBike)
        && matches!(reason, RejectionReason::Collision)
        && source_behavior == MB_BUMPY_SLOPE
        && matches!(collision, CollisionOutcome::Impassable)
    {
        player_state
            .bike_runtime
            .acro_runtime
            .set_on_bumpy_slope(true);
        if let Some(action) = player_state
            .bike_runtime
            .acro_runtime
            .handle_wheelie_collision_response()
        {
            player_state.bike_runtime.last_transition = match action {
                AcroAnimationAction::WheelieIdle => BikeTransitionType::WheelieIdle,
                _ => BikeTransitionType::None,
            };
        }
        player_state.bike_runtime.acro_state = match player_state.bike_runtime.acro_runtime.state {
            AcroState::Normal | AcroState::Turning | AcroState::SideJump | AcroState::TurnJump => {
                AcroBikeSubstate::None
            }
            AcroState::WheelieStanding => AcroBikeSubstate::StandingWheelie,
            AcroState::BunnyHop => AcroBikeSubstate::BunnyHop,
            AcroState::WheelieMoving => AcroBikeSubstate::MovingWheelie,
        };
    } else if matches!(player_state.traversal_state, TraversalState::AcroBike)
        && matches!(reason, RejectionReason::Collision)
        && matches!(collision, CollisionOutcome::Impassable)
        && matches!(
            player_state.bike_runtime.acro_runtime.state,
            AcroState::WheelieMoving | AcroState::BunnyHop
        )
    {
        player_state.bike_runtime.acro_runtime.state = AcroState::WheelieStanding;
        player_state.bike_runtime.acro_state = AcroBikeSubstate::StandingWheelie;
        player_state.bike_runtime.last_transition = BikeTransitionType::WheelieIdle;
    }
}

fn apply_bike_transition_for_collision_outcome(
    player_state: &mut PlayerState,
    collision: CollisionOutcome,
) {
    if !matches!(collision, CollisionOutcome::LedgeJump) {
        return;
    }

    if matches!(player_state.traversal_state, TraversalState::MachBike) {
        player_state.bike_runtime.last_transition = BikeTransitionType::Hop;
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
                AcroAnimationAction::FaceDirection => BikeTransitionType::None,
                AcroAnimationAction::TurnDirection => BikeTransitionType::None,
                AcroAnimationAction::Moving => BikeTransitionType::None,
                AcroAnimationAction::NormalToWheelie => BikeTransitionType::NormalToWheelie,
                AcroAnimationAction::WheelieToNormal => BikeTransitionType::WheelieToNormal,
                AcroAnimationAction::WheelieIdle => BikeTransitionType::WheelieIdle,
                AcroAnimationAction::WheelieHoppingStanding => {
                    BikeTransitionType::WheelieHoppingStanding
                }
                AcroAnimationAction::WheelieHoppingMoving => {
                    BikeTransitionType::WheelieHoppingMoving
                }
                AcroAnimationAction::SideJump => BikeTransitionType::SideJump,
                AcroAnimationAction::TurnJump => BikeTransitionType::TurnJump,
                AcroAnimationAction::WheelieMoving => BikeTransitionType::WheelieMoving,
                AcroAnimationAction::WheelieRisingMoving => BikeTransitionType::WheelieRisingMoving,
                AcroAnimationAction::WheelieLoweringMoving => {
                    BikeTransitionType::WheelieLoweringMoving
                }
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
    player_state
        .bike_runtime
        .acro_runtime
        .set_held_input(held_direction, holding_b);
    player_state.bike_runtime.acro_runtime.advance_tick();
    player_state.bike_runtime.acro_state = match player_state.bike_runtime.acro_runtime.state {
        AcroState::Normal | AcroState::Turning | AcroState::SideJump | AcroState::TurnJump => {
            AcroBikeSubstate::None
        }
        AcroState::WheelieStanding => AcroBikeSubstate::StandingWheelie,
        AcroState::BunnyHop => AcroBikeSubstate::BunnyHop,
        AcroState::WheelieMoving => AcroBikeSubstate::MovingWheelie,
    };
    if held_direction.is_none() {
        if let Some(action) = player_state.bike_runtime.acro_runtime.take_pending_action() {
            player_state.bike_runtime.last_transition = match action {
                AcroAnimationAction::None
                | AcroAnimationAction::FaceDirection
                | AcroAnimationAction::TurnDirection
                | AcroAnimationAction::Moving => BikeTransitionType::None,
                AcroAnimationAction::NormalToWheelie => BikeTransitionType::NormalToWheelie,
                AcroAnimationAction::WheelieToNormal => BikeTransitionType::WheelieToNormal,
                AcroAnimationAction::WheelieIdle => BikeTransitionType::WheelieIdle,
                AcroAnimationAction::WheelieHoppingStanding => {
                    BikeTransitionType::WheelieHoppingStanding
                }
                AcroAnimationAction::WheelieHoppingMoving => {
                    BikeTransitionType::WheelieHoppingMoving
                }
                AcroAnimationAction::SideJump => BikeTransitionType::SideJump,
                AcroAnimationAction::TurnJump => BikeTransitionType::TurnJump,
                AcroAnimationAction::WheelieMoving => BikeTransitionType::WheelieMoving,
                AcroAnimationAction::WheelieRisingMoving => BikeTransitionType::WheelieRisingMoving,
                AcroAnimationAction::WheelieLoweringMoving => {
                    BikeTransitionType::WheelieLoweringMoving
                }
            };
        }
    }
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

    let stepped_on_collapsed_floor =
        player_state
            .cracked_floor
            .pending_floors
            .iter()
            .any(|pending| {
                pending.collapsed
                    && pending.map_id == player_state.map_id
                    && pending.x == x
                    && pending.y == y
            });

    let idx = y as usize * map.width as usize + x as usize;
    let behavior = map.behavior.get(idx).copied().unwrap_or_default();
    if behavior == MB_CRACKED_FLOOR_HOLE || stepped_on_collapsed_floor {
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
    use std::path::PathBuf;
    use tokio::sync::mpsc;

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

    fn seed_turning_jump_window(player: &mut PlayerState, direction: Direction) {
        player.traversal_state = TraversalState::AcroBike;
        player.bike_runtime.acro_runtime.state = AcroState::Turning;
        player.bike_runtime.acro_runtime.new_dir_backup = Some(direction);
        player
            .bike_runtime
            .acro_runtime
            .update_history(Some(direction), 0);
        player
            .bike_runtime
            .acro_runtime
            .update_history(Some(direction), 0);
        player
            .bike_runtime
            .acro_runtime
            .update_history(Some(direction), crate::protocol::HeldButtons::B as u8);
    }

    fn bumpy_slope_map() -> MapData {
        MapData {
            map_id: "MAP_BUMPY_TEST".to_string(),
            width: 2,
            height: 2,
            metatile_id: vec![0; 4],
            collision: vec![0, 1, 0, 0],
            behavior: vec![MB_BUMPY_SLOPE, 0, 0, 0],
            allow_cycling: true,
            allow_running: true,
            connections: vec![],
        }
    }

    fn test_asset_paths() -> (String, String) {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..");
        (
            root.join("assets/maps_index.json")
                .to_string_lossy()
                .into_owned(),
            root.join("assets/layouts_index.json")
                .to_string_lossy()
                .into_owned(),
        )
    }

    fn drain_server_messages(
        rx: &mut mpsc::UnboundedReceiver<ServerMessage>,
    ) -> Vec<ServerMessage> {
        let mut drained = Vec::new();
        while let Ok(message) = rx.try_recv() {
            drained.push(message);
        }
        drained
    }

    fn test_world_with_initial_map(initial_map: MapData) -> World {
        let mut maps = HashMap::new();
        let map_id = initial_map.map_id.clone();
        maps.insert(map_id.clone(), initial_map);

        let mut protocol_map_ids = HashMap::new();
        protocol_map_ids.insert(map_id.clone(), 1);

        World {
            tick: AtomicU64::new(0),
            next_connection_id: AtomicU64::new(1),
            initial_map_id: map_id,
            maps,
            protocol_map_ids,
            player_profiles: RwLock::new(HashMap::new()),
            sessions: RwLock::new(HashMap::new()),
        }
    }

    #[test]
    fn tick_then_step_order_preserves_side_jump_transition() {
        let mut player = test_player_state();
        player.facing = Direction::Up;
        seed_turning_jump_window(&mut player, Direction::Right);

        update_bike_runtime_per_tick(
            &mut player,
            Some(Direction::Right),
            crate::protocol::HeldButtons::B as u8,
        );
        update_bike_runtime_after_step(&mut player, Direction::Right);

        assert_eq!(
            player.bike_runtime.last_transition,
            BikeTransitionType::SideJump
        );
        assert_eq!(player.bike_runtime.acro_runtime.state, AcroState::SideJump);
    }

    #[test]
    fn tick_then_step_order_preserves_turn_jump_transition() {
        let mut player = test_player_state();
        player.facing = Direction::Left;
        seed_turning_jump_window(&mut player, Direction::Right);

        update_bike_runtime_per_tick(
            &mut player,
            Some(Direction::Right),
            crate::protocol::HeldButtons::B as u8,
        );
        update_bike_runtime_after_step(&mut player, Direction::Right);

        assert_eq!(
            player.bike_runtime.last_transition,
            BikeTransitionType::TurnJump
        );
        assert_eq!(player.bike_runtime.acro_runtime.state, AcroState::TurnJump);
    }

    #[test]
    fn mounting_acro_on_bumpy_slope_auto_enters_idle_wheelie() {
        let mut player = test_player_state();
        player.traversal_state = TraversalState::OnFoot;
        player.preferred_bike_type = TraversalState::AcroBike;
        let map = bumpy_slope_map();
        let source_behavior = map.behavior[0];

        set_traversal_state(
            &mut player,
            TraversalState::AcroBike,
            Some(source_behavior),
            BikeTransitionType::Mount,
            true,
        );

        assert_eq!(
            player.bike_runtime.acro_state,
            AcroBikeSubstate::StandingWheelie
        );
        assert_eq!(
            player.bike_runtime.last_transition,
            BikeTransitionType::WheelieIdle
        );
        assert_eq!(
            player.bike_runtime.acro_runtime.state,
            AcroState::WheelieStanding
        );
    }

    #[test]
    fn bumpy_slope_release_keeps_wheelie_state() {
        let mut player = test_player_state();
        player.traversal_state = TraversalState::AcroBike;
        player.bike_runtime.acro_runtime.state = AcroState::WheelieMoving;
        player.bike_runtime.acro_state = AcroBikeSubstate::MovingWheelie;

        let map = bumpy_slope_map();
        player
            .bike_runtime
            .acro_runtime
            .set_on_bumpy_slope(map.behavior[0] == MB_BUMPY_SLOPE);

        update_bike_runtime_per_tick(&mut player, None, 0);

        assert_eq!(
            player.bike_runtime.acro_state,
            AcroBikeSubstate::StandingWheelie
        );
        assert_eq!(
            player.bike_runtime.last_transition,
            BikeTransitionType::WheelieIdle
        );
        assert_eq!(
            player.bike_runtime.acro_runtime.state,
            AcroState::WheelieStanding
        );
    }

    #[test]
    fn bumpy_slope_collision_uses_idle_wheelie_response() {
        let mut player = test_player_state();
        player.traversal_state = TraversalState::AcroBike;
        player.bike_runtime.acro_runtime.state = AcroState::WheelieMoving;
        player.bike_runtime.acro_state = AcroBikeSubstate::MovingWheelie;

        let map = bumpy_slope_map();
        reset_bike_runtime_on_reject(
            &mut player,
            RejectionReason::Collision,
            map.behavior[0],
            CollisionOutcome::Impassable,
        );

        assert_eq!(
            player.bike_runtime.acro_state,
            AcroBikeSubstate::StandingWheelie
        );
        assert_eq!(
            player.bike_runtime.last_transition,
            BikeTransitionType::WheelieIdle
        );
        assert_eq!(
            player.bike_runtime.acro_runtime.state,
            AcroState::WheelieStanding
        );
    }

    #[test]
    fn neutral_b_hold_transitions_to_wheelie_then_bunny_hop_without_step_request() {
        let mut player = test_player_state();
        player.traversal_state = TraversalState::AcroBike;
        player.facing = Direction::Right;

        update_bike_runtime_per_tick(&mut player, None, crate::protocol::HeldButtons::B as u8);
        assert_eq!(
            player.bike_runtime.acro_runtime.state,
            AcroState::WheelieStanding
        );
        assert_eq!(
            player.bike_runtime.last_transition,
            BikeTransitionType::NormalToWheelie
        );

        for _ in 0..40 {
            update_bike_runtime_per_tick(&mut player, None, crate::protocol::HeldButtons::B as u8);
        }

        assert_eq!(player.bike_runtime.acro_runtime.state, AcroState::BunnyHop);
        assert_eq!(
            player.bike_runtime.last_transition,
            BikeTransitionType::WheelieHoppingStanding
        );
    }

    #[tokio::test]
    async fn held_b_idle_ticks_emit_runtime_transitions_without_walk_input_acceptance() {
        let (maps_index, layouts_index) = test_asset_paths();
        let world = World::load_from_assets("MAP_LITTLEROOT_TOWN", &maps_index, &layouts_index)
            .expect("world should load");

        let (tx, mut rx) = mpsc::unbounded_channel();
        let session = world
            .create_session(tx)
            .await
            .expect("session should create");
        world
            .join_session(session.connection_id, "idle-acro-runtime")
            .await
            .expect("session should join");
        let _ = drain_server_messages(&mut rx);

        world
            .handle_debug_traversal_input(
                session.connection_id,
                DebugTraversalInput {
                    action: DebugTraversalAction::ToggleMount,
                },
            )
            .await
            .expect("mount should succeed");
        world
            .handle_debug_traversal_input(
                session.connection_id,
                DebugTraversalInput {
                    action: DebugTraversalAction::SwapBikeType,
                },
            )
            .await
            .expect("bike swap should succeed");
        let _ = drain_server_messages(&mut rx);

        let mut seen_transition_sequence = Vec::new();
        for input_seq in 0..45_u32 {
            world
                .enqueue_held_input_state(
                    session.connection_id,
                    HeldInputState {
                        input_seq,
                        held_direction: None,
                        held_buttons: crate::protocol::HeldButtons::B as u8,
                        client_time: input_seq as u64,
                    },
                )
                .await
                .expect("held input should enqueue");
            world.tick().await;

            for message in drain_server_messages(&mut rx) {
                match message {
                    ServerMessage::BikeRuntimeDelta(delta) => {
                        if let Some(transition) = delta.bike_transition {
                            seen_transition_sequence.push(transition);
                        }
                    }
                    ServerMessage::WalkResult(result) => {
                        panic!(
                            "unexpected walk result while no walk input was sent: accepted={}",
                            result.accepted
                        );
                    }
                    _ => {}
                }
            }
        }

        let normal_to_wheelie_index = seen_transition_sequence
            .iter()
            .position(|transition| *transition == BikeTransitionType::NormalToWheelie)
            .expect("expected NormalToWheelie transition in runtime deltas");
        let wheelie_hop_index = seen_transition_sequence
            .iter()
            .position(|transition| *transition == BikeTransitionType::WheelieHoppingStanding)
            .expect("expected WheelieHoppingStanding transition in runtime deltas");

        assert!(
            normal_to_wheelie_index < wheelie_hop_index,
            "NormalToWheelie must occur before WheelieHoppingStanding"
        );
    }

    #[tokio::test]
    async fn moving_wheelie_release_with_b_held_emits_idle_then_hop_without_grounded_transition() {
        let world = test_world_with_initial_map(bumpy_slope_map());
        let (tx, mut rx) = mpsc::unbounded_channel();
        let session = world
            .create_session(tx)
            .await
            .expect("session should create");
        world
            .join_session(session.connection_id, "moving-wheelie-release")
            .await
            .expect("session should join");
        let _ = drain_server_messages(&mut rx);

        {
            let mut sessions = world.sessions.write().await;
            let session_state = sessions
                .get_mut(&session.connection_id)
                .expect("session should exist");
            session_state.player_state.traversal_state = TraversalState::AcroBike;
            session_state.player_state.preferred_bike_type = TraversalState::AcroBike;
            session_state.player_state.facing = Direction::Right;
            session_state.player_state.bike_runtime.acro_runtime.state = AcroState::WheelieMoving;
            session_state.player_state.bike_runtime.acro_state = AcroBikeSubstate::MovingWheelie;
            session_state.player_state.bike_runtime.last_transition = BikeTransitionType::None;
            session_state
                .player_state
                .bike_runtime
                .acro_runtime
                .set_held_input(Some(Direction::Right), true);
        }

        world
            .enqueue_held_input_state(
                session.connection_id,
                HeldInputState {
                    input_seq: 0,
                    held_direction: None,
                    held_buttons: crate::protocol::HeldButtons::B as u8,
                    client_time: 0,
                },
            )
            .await
            .expect("held input should enqueue");
        world
            .enqueue_walk_input(
                session.connection_id,
                WalkInput {
                    direction: Direction::Right,
                    movement_mode: MovementMode::Walk,
                    held_buttons: crate::protocol::HeldButtons::B as u8,
                    input_seq: 0,
                    client_time: 0,
                },
            )
            .await
            .expect("walk input should enqueue");
        world.tick().await;

        let mut seen_transitions = Vec::new();
        let mut walk_result = None;
        for message in drain_server_messages(&mut rx) {
            match message {
                ServerMessage::WalkResult(result) => {
                    if result.input_seq == 0 {
                        walk_result = Some(result);
                        if let Some(transition) = result.bike_transition {
                            seen_transitions.push(transition);
                        }
                    }
                }
                ServerMessage::BikeRuntimeDelta(delta) => {
                    if let Some(transition) = delta.bike_transition {
                        seen_transitions.push(transition);
                    }
                }
                _ => {}
            }
        }

        let walk_result = walk_result.expect("expected walk result for rejected collision");
        assert!(!walk_result.accepted);
        assert_eq!(walk_result.reason, RejectionReason::Collision);
        assert_eq!(
            walk_result.acro_substate,
            Some(AcroBikeSubstate::StandingWheelie)
        );
        assert_eq!(walk_result.bike_transition, Some(BikeTransitionType::None));
        assert!(
            !seen_transitions.contains(&BikeTransitionType::WheelieToNormal),
            "release while holding B must not emit grounded WheelieToNormal transition"
        );

        for input_seq in 1..50_u32 {
            world
                .enqueue_held_input_state(
                    session.connection_id,
                    HeldInputState {
                        input_seq,
                        held_direction: None,
                        held_buttons: crate::protocol::HeldButtons::B as u8,
                        client_time: input_seq as u64,
                    },
                )
                .await
                .expect("held input should enqueue");
            world.tick().await;

            for message in drain_server_messages(&mut rx) {
                if let ServerMessage::BikeRuntimeDelta(delta) = message {
                    if let Some(transition) = delta.bike_transition {
                        seen_transitions.push(transition);
                    }
                }
            }
        }

        assert!(
            seen_transitions.contains(&BikeTransitionType::WheelieHoppingStanding),
            "expected standing hop flow to continue after release"
        );
        assert!(
            !seen_transitions.contains(&BikeTransitionType::WheelieToNormal),
            "no intermediate grounded transition should occur before standing hop flow"
        );
    }

    #[test]
    fn direction_release_while_bike_idle_clears_authoritative_held_direction() {
        let mut player = test_player_state();
        player.traversal_state = TraversalState::AcroBike;
        player.bike_runtime.acro_runtime.state = AcroState::WheelieStanding;

        update_bike_runtime_per_tick(
            &mut player,
            Some(Direction::Right),
            crate::protocol::HeldButtons::B as u8,
        );
        assert_eq!(
            player.bike_runtime.acro_runtime.held_direction,
            Some(Direction::Right)
        );

        update_bike_runtime_per_tick(&mut player, None, crate::protocol::HeldButtons::B as u8);
        assert_eq!(player.bike_runtime.acro_runtime.held_direction, None);
    }

    #[test]
    fn releasing_b_while_in_bunny_hop_clears_hold_and_exits_wheelie_flow() {
        let mut player = test_player_state();
        player.traversal_state = TraversalState::AcroBike;
        player.bike_runtime.acro_runtime.state = AcroState::BunnyHop;
        player.bike_runtime.acro_state = AcroBikeSubstate::BunnyHop;

        update_bike_runtime_per_tick(&mut player, None, crate::protocol::HeldButtons::B as u8);
        assert!(player.bike_runtime.acro_runtime.holding_b);

        update_bike_runtime_per_tick(&mut player, None, 0);
        assert!(!player.bike_runtime.acro_runtime.holding_b);
        assert_eq!(player.bike_runtime.acro_runtime.state, AcroState::Normal);
        assert_eq!(
            player.bike_runtime.last_transition,
            BikeTransitionType::WheelieToNormal
        );
    }

    #[test]
    fn idle_ticks_do_not_keep_stale_held_direction_or_buttons() {
        let mut player = test_player_state();
        player.traversal_state = TraversalState::AcroBike;

        update_bike_runtime_per_tick(
            &mut player,
            Some(Direction::Left),
            crate::protocol::HeldButtons::B as u8,
        );
        assert_eq!(
            player.bike_runtime.acro_runtime.held_direction,
            Some(Direction::Left)
        );
        assert!(player.bike_runtime.acro_runtime.holding_b);

        update_bike_runtime_per_tick(&mut player, None, 0);
        update_bike_runtime_per_tick(&mut player, None, 0);
        update_bike_runtime_per_tick(&mut player, None, 0);

        assert_eq!(player.bike_runtime.acro_runtime.held_direction, None);
        assert!(!player.bike_runtime.acro_runtime.holding_b);
    }

    #[test]
    fn blocked_wheelie_collision_uses_idle_response_off_bumpy_slope() {
        let mut player = test_player_state();
        player.traversal_state = TraversalState::AcroBike;
        player.bike_runtime.acro_runtime.state = AcroState::WheelieMoving;
        player.bike_runtime.acro_state = AcroBikeSubstate::MovingWheelie;

        reset_bike_runtime_on_reject(
            &mut player,
            RejectionReason::Collision,
            0,
            CollisionOutcome::Impassable,
        );

        assert_eq!(
            player.bike_runtime.acro_state,
            AcroBikeSubstate::StandingWheelie
        );
        assert_eq!(
            player.bike_runtime.last_transition,
            BikeTransitionType::WheelieIdle
        );
        assert_eq!(
            player.bike_runtime.acro_runtime.state,
            AcroState::WheelieStanding
        );
    }

    #[test]
    fn mach_bike_ledge_collision_sets_hop_transition() {
        let mut player = test_player_state();
        player.traversal_state = TraversalState::MachBike;
        player.bike_runtime.last_transition = BikeTransitionType::None;

        apply_bike_transition_for_collision_outcome(&mut player, CollisionOutcome::LedgeJump);

        assert_eq!(player.bike_runtime.last_transition, BikeTransitionType::Hop);
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
    fn cracked_floor_callback_preserves_fastest_path_without_speed_gate_failure() {
        let mut player = test_player_state();
        let map = MapData {
            map_id: "MAP_SKY_PILLAR_2F".to_string(),
            width: 4,
            height: 1,
            metatile_id: vec![0; 4],
            collision: vec![0; 4],
            behavior: vec![
                MB_CRACKED_FLOOR,
                MB_CRACKED_FLOOR,
                MB_CRACKED_FLOOR,
                MB_CRACKED_FLOOR,
            ],
            allow_cycling: true,
            allow_running: true,
            connections: vec![],
        };

        cracked_floor_per_step_callback(&mut player, &map, 0, 0, PlayerSpeed::Fastest);
        cracked_floor_per_step_callback(&mut player, &map, 1, 0, PlayerSpeed::Fastest);
        cracked_floor_per_step_callback(&mut player, &map, 2, 0, PlayerSpeed::Fastest);
        cracked_floor_per_step_callback(&mut player, &map, 3, 0, PlayerSpeed::Fastest);

        assert!(!player.cracked_floor.failed_speed_gate);
        assert!(player.cracked_floor.pending_floors[0].collapsed);
        assert_eq!(player.cracked_floor.pending_floors[1].delay_steps, 1);
    }

    #[test]
    fn cracked_floor_callback_treats_collapsed_runtime_tiles_as_holes() {
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
        cracked_floor_per_step_callback(&mut player, &map, 1, 0, PlayerSpeed::Normal);
        cracked_floor_per_step_callback(&mut player, &map, 2, 0, PlayerSpeed::Normal);
        cracked_floor_per_step_callback(&mut player, &map, 3, 0, PlayerSpeed::Normal);
        assert!(player.cracked_floor.pending_floors[0].collapsed);

        player.cracked_floor.failed_speed_gate = false;
        cracked_floor_per_step_callback(&mut player, &map, 0, 0, PlayerSpeed::Fastest);
        assert!(player.cracked_floor.failed_speed_gate);
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

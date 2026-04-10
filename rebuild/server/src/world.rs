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
        DebugTraversalInput, Direction, HeldInputState, HopLandingParticleClass, MovementMode,
        PlayerAction, PlayerActionInput, PlayerAvatar, RejectionReason, ServerMessage,
        SessionAccepted, StepSpeed, TraversalState, WalkInput, WalkResult, WorldSnapshot,
    },
    session::{
        ActiveWalkTransition, BikeRuntimeState, CrackedFloorRuntimeState, PlayerState, Session,
        SessionInit, WalkIntentTimingValidation, MAX_PENDING_WALK_INPUTS,
    },
};

const BIKE_EFFECT_TIRE_TRACKS: u8 = 1 << 0;
const BIKE_EFFECT_HOP_SFX: u8 = 1 << 1;
const BIKE_EFFECT_COLLISION_SFX: u8 = 1 << 2;
const BIKE_EFFECT_CYCLING_BGM_MOUNT: u8 = 1 << 3;
const BIKE_EFFECT_CYCLING_BGM_DISMOUNT: u8 = 1 << 4;
const MB_BUMPY_SLOPE: u8 = 0xD1;
const MB_TALL_GRASS: u8 = 0x02;
const MB_LONG_GRASS: u8 = 0x03;
const MB_POND_WATER: u8 = 0x10;
const MB_INTERIOR_DEEP_WATER: u8 = 0x11;
const MB_DEEP_WATER: u8 = 0x12;
const MB_WATERFALL: u8 = 0x13;
const MB_SOOTOPOLIS_DEEP_WATER: u8 = 0x14;
const MB_OCEAN_WATER: u8 = 0x15;
const MB_PUDDLE: u8 = 0x16;
const MB_SHALLOW_WATER: u8 = 0x17;
const MB_UNUSED_SOOTOPOLIS_DEEP_WATER: u8 = 0x18;
const MB_NO_SURFACING: u8 = 0x19;
const MB_UNUSED_SOOTOPOLIS_DEEP_WATER_2: u8 = 0x1A;
const MB_SEAWEED_NO_SURFACING: u8 = 0x2A;

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
    pub elevation: Vec<u8>,
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
            let effective_held_direction = session.effective_held_direction();
            let lock_acro_input_during_hop = session.active_walk_transition.is_some()
                && matches!(
                    session.player_state.bike_runtime.acro_runtime.state,
                    AcroState::BunnyHop
                );
            if lock_acro_input_during_hop {
                let holding_b = (session.held_buttons & crate::protocol::HeldButtons::B as u8) != 0;
                session
                    .player_state
                    .bike_runtime
                    .acro_runtime
                    .set_held_input(effective_held_direction, holding_b);
                session
                    .player_state
                    .bike_runtime
                    .acro_runtime
                    .advance_locked_movement_tick();
                session.player_state.bike_runtime.acro_state = AcroBikeSubstate::BunnyHop;
            } else {
                update_bike_runtime_per_tick(
                    &mut session.player_state,
                    effective_held_direction,
                    session.held_buttons,
                );
            }
            session.update_authoritative_tick(tick);
            if session.active_walk_transition.is_none()
                && matches!(
                    session.player_state.bike_runtime.acro_state,
                    AcroBikeSubstate::BunnyHop
                )
                && session
                    .player_state
                    .bike_runtime
                    .acro_runtime
                    .hop_landed_this_tick()
            {
                session.open_bunny_hop_movement_boundary();
            }
            let current_acro_substate = bike_acro_substate_for_traversal(&session.player_state);
            let current_bike_transition = session.player_state.bike_runtime.last_transition;
            let (hop_landing_map_id, hop_landing_x, hop_landing_y) =
                if let Some(active_walk) = session.active_walk_transition.as_ref() {
                    (
                        active_walk.target_map_id.as_str(),
                        active_walk.target_x,
                        active_walk.target_y,
                    )
                } else {
                    (
                        session.player_state.map_id.as_str(),
                        session.player_state.tile_x,
                        session.player_state.tile_y,
                    )
                };
            let (hop_landing_particle_class, hop_landing_tile) =
                hop_landing_signal_for_authoritative_tile(
                    self.maps.get(hop_landing_map_id),
                    hop_landing_x,
                    hop_landing_y,
                    session
                        .player_state
                        .bike_runtime
                        .acro_runtime
                        .hop_landed_this_tick(),
                );
            let traversal_changed =
                session.player_state.traversal_state != previous_traversal_state;
            let runtime_changed = current_acro_substate != previous_acro_substate
                || current_bike_transition != previous_bike_transition;
            let emitted_landing_particle = hop_landing_particle_class.is_some();
            if session.joined && (traversal_changed || runtime_changed || emitted_landing_particle)
            {
                let _ = session.send(ServerMessage::BikeRuntimeDelta(BikeRuntimeDelta {
                    server_frame: tick as u32,
                    traversal_state: session.player_state.traversal_state,
                    player_elevation: player_elevation_for_state(
                        self.maps.get(&session.player_state.map_id),
                        &session.player_state,
                    ),
                    facing: session.player_state.facing,
                    authoritative_step_speed: Some(player_step_speed_for_snapshot(
                        &session.player_state,
                    )),
                    mach_speed_stage: bike_mach_speed_for_traversal(&session.player_state),
                    acro_substate: current_acro_substate,
                    bike_transition: Some(current_bike_transition),
                    bunny_hop_cycle_tick: bike_bunny_hop_cycle_tick_for_traversal(
                        &session.player_state,
                    ),
                    hop_landing_particle_class,
                    hop_landing_tile_x: hop_landing_tile.map(|tile| tile.0),
                    hop_landing_tile_y: hop_landing_tile.map(|tile| tile.1),
                }));
            }

            if session.active_walk_transition.is_some()
                && matches!(session.player_state.traversal_state, TraversalState::OnFoot)
            {
                session.capture_step_end_direction_intent();
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
                    if matches!(
                        session.player_state.bike_runtime.acro_state,
                        AcroBikeSubstate::BunnyHop
                    ) {
                        session.open_bunny_hop_movement_boundary();
                    }
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

            let _boundary_intent = session.consume_step_end_direction_intent();
            while let Some(input) = session.pop_walk_input() {
                let previous_map_id = session.player_state.map_id.clone();
                let timing_validation = session.validate_and_commit_walk_intent_timing(&input);
                if timing_validation != WalkIntentTimingValidation::Accepted {
                    let reason = match timing_validation {
                        WalkIntentTimingValidation::Accepted => RejectionReason::None,
                        WalkIntentTimingValidation::HeldDirectionMismatch => {
                            RejectionReason::InvalidDirection
                        }
                        WalkIntentTimingValidation::CadenceMiss => {
                            RejectionReason::ForcedMovementDisabled
                        }
                    };
                    let _ = session.send(ServerMessage::WalkResult(WalkResult {
                        input_seq: input.input_seq,
                        accepted: false,
                        authoritative_pos: crate::protocol::Position {
                            x: session.player_state.tile_x,
                            y: session.player_state.tile_y,
                        },
                        facing: session.player_state.facing,
                        reason,
                        server_frame: tick as u32,
                        traversal_state: session.player_state.traversal_state,
                        preferred_bike_type: session.player_state.preferred_bike_type,
                        player_elevation: player_elevation_for_state(
                            self.maps.get(&session.player_state.map_id),
                            &session.player_state,
                        ),
                        authoritative_step_speed: Some(player_step_speed_for_snapshot(
                            &session.player_state,
                        )),
                        mach_speed_stage: bike_mach_speed_for_traversal(&session.player_state),
                        acro_substate: bike_acro_substate_for_traversal(&session.player_state),
                        bike_transition: Some(session.player_state.bike_runtime.last_transition),
                        bike_effect_flags: 0,
                        bunny_hop_cycle_tick: bike_bunny_hop_cycle_tick_for_traversal(
                            &session.player_state,
                        ),
                        hop_landing_particle_class: None,
                        hop_landing_tile_x: None,
                        hop_landing_tile_y: None,
                    }));
                    continue;
                }
                let is_bunny_hop = matches!(
                    session.player_state.bike_runtime.acro_state,
                    AcroBikeSubstate::BunnyHop
                );
                if is_bunny_hop && !session.consume_bunny_hop_movement_boundary() {
                    session.requeue_walk_input_front(input);
                    break;
                }
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
                        player_elevation: player_elevation_for_state(
                            self.maps.get(&session.player_state.map_id),
                            &session.player_state,
                        ),
                        authoritative_step_speed: Some(player_step_speed_for_snapshot(
                            &session.player_state,
                        )),
                        mach_speed_stage: bike_mach_speed_for_traversal(&session.player_state),
                        acro_substate: bike_acro_substate_for_traversal(&session.player_state),
                        bike_transition: Some(session.player_state.bike_runtime.last_transition),
                        bike_effect_flags: 0,
                        bunny_hop_cycle_tick: bike_bunny_hop_cycle_tick_for_traversal(
                            &session.player_state,
                        ),
                        hop_landing_particle_class: None,
                        hop_landing_tile_x: None,
                        hop_landing_tile_y: None,
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
                    bike_acro_substate_for_traversal(&session.player_state),
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

                let (hop_landing_map_id, hop_landing_x, hop_landing_y) = if accepted {
                    if let Some(active_walk) = session.active_walk_transition.as_ref() {
                        (
                            active_walk.target_map_id.as_str(),
                            authoritative_x,
                            authoritative_y,
                        )
                    } else {
                        (
                            session.player_state.map_id.as_str(),
                            authoritative_x,
                            authoritative_y,
                        )
                    }
                } else {
                    (
                        session.player_state.map_id.as_str(),
                        session.player_state.tile_x,
                        session.player_state.tile_y,
                    )
                };
                let (hop_landing_particle_class, hop_landing_tile) =
                    hop_landing_signal_for_authoritative_tile(
                        self.maps.get(hop_landing_map_id),
                        hop_landing_x,
                        hop_landing_y,
                        session
                            .player_state
                            .bike_runtime
                            .acro_runtime
                            .hop_landed_this_tick(),
                    );
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
                    player_elevation: player_elevation_for_state(
                        self.maps.get(&session.player_state.map_id),
                        &session.player_state,
                    ),
                    authoritative_step_speed: Some(step_speed_to_protocol(step_speed)),
                    mach_speed_stage: bike_mach_speed_for_traversal(&session.player_state),
                    acro_substate: bike_acro_substate_for_traversal(&session.player_state),
                    bike_transition: Some(session.player_state.bike_runtime.last_transition),
                    bike_effect_flags: bike_effect_flags_for_step(
                        &session.player_state,
                        accepted,
                        reason,
                    ),
                    bunny_hop_cycle_tick: bike_bunny_hop_cycle_tick_for_traversal(
                        &session.player_state,
                    ),
                    hop_landing_particle_class,
                    hop_landing_tile_x: hop_landing_tile.map(|tile| tile.0),
                    hop_landing_tile_y: hop_landing_tile.map(|tile| tile.1),
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
            player_elevation: player_elevation_for_state(
                self.maps.get(&session_map_id),
                player_state,
            ),
            authoritative_step_speed: Some(player_step_speed_for_snapshot(player_state)),
            mach_speed_stage: bike_mach_speed_for_traversal(player_state),
            acro_substate: bike_acro_substate_for_traversal(player_state),
            bike_transition: Some(player_state.bike_runtime.last_transition),
            bunny_hop_cycle_tick: bike_bunny_hop_cycle_tick_for_traversal(player_state),
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
            player_elevation: player_elevation_for_state(
                self.maps.get(&session.player_state.map_id),
                &session.player_state,
            ),
            authoritative_step_speed: Some(player_step_speed_for_snapshot(&session.player_state)),
            mach_speed_stage: bike_mach_speed_for_traversal(&session.player_state),
            acro_substate: bike_acro_substate_for_traversal(&session.player_state),
            bike_transition: Some(session.player_state.bike_runtime.last_transition),
            bike_effect_flags: bike_effect_flags_for_step(&session.player_state, false, reason),
            bunny_hop_cycle_tick: bike_bunny_hop_cycle_tick_for_traversal(&session.player_state),
            hop_landing_particle_class: None,
            hop_landing_tile_x: None,
            hop_landing_tile_y: None,
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
        bike_acro_substate_for_traversal(player_state),
    );
    step_speed_to_protocol(player_speed_step_speed(player_speed))
}

fn bike_bunny_hop_cycle_tick_for_traversal(player_state: &PlayerState) -> Option<u8> {
    if !matches!(player_state.traversal_state, TraversalState::AcroBike) {
        return None;
    }
    if !matches!(
        bike_acro_substate_for_traversal(player_state),
        Some(AcroBikeSubstate::BunnyHop)
    ) {
        return None;
    }
    Some(
        player_state
            .bike_runtime
            .acro_runtime
            .bunny_hop_cycle_tick(),
    )
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

fn hop_landing_signal_for_authoritative_tile(
    map: Option<&MapData>,
    tile_x: u16,
    tile_y: u16,
    hop_landed_this_tick: bool,
) -> (Option<HopLandingParticleClass>, Option<(u16, u16)>) {
    if !hop_landed_this_tick {
        return (None, None);
    }
    let behavior = map.and_then(|current_map| tile_behavior(current_map, tile_x, tile_y));
    (
        Some(hop_landing_particle_class_for_behavior(
            behavior.unwrap_or_default(),
        )),
        Some((tile_x, tile_y)),
    )
}

fn hop_landing_particle_class_for_behavior(behavior: u8) -> HopLandingParticleClass {
    if behavior == MB_TALL_GRASS {
        return HopLandingParticleClass::TallGrassJump;
    }
    if matches!(behavior, MB_LONG_GRASS) {
        return HopLandingParticleClass::LongGrassJump;
    }
    if matches!(behavior, MB_PUDDLE | MB_SHALLOW_WATER) {
        return HopLandingParticleClass::ShallowWaterSplash;
    }
    if is_surfable_deep_water_behavior(behavior) {
        return HopLandingParticleClass::DeepWaterSplash;
    }
    HopLandingParticleClass::NormalGroundDust
}

fn is_surfable_deep_water_behavior(behavior: u8) -> bool {
    matches!(
        behavior,
        MB_POND_WATER
            | MB_INTERIOR_DEEP_WATER
            | MB_DEEP_WATER
            | MB_WATERFALL
            | MB_SOOTOPOLIS_DEEP_WATER
            | MB_OCEAN_WATER
            | MB_UNUSED_SOOTOPOLIS_DEEP_WATER
            | MB_NO_SURFACING
            | MB_UNUSED_SOOTOPOLIS_DEEP_WATER_2
            | MB_SEAWEED_NO_SURFACING
    )
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
    tile_behavior(map, player_state.tile_x, player_state.tile_y)
}

fn player_elevation_for_state(map: Option<&MapData>, player_state: &PlayerState) -> u8 {
    map.and_then(|current_map| {
        tile_elevation(current_map, player_state.tile_x, player_state.tile_y)
    })
    .unwrap_or(0)
}

fn tile_behavior(map: &MapData, tile_x: u16, tile_y: u16) -> Option<u8> {
    map.behavior
        .get(tile_y as usize * map.width as usize + tile_x as usize)
        .copied()
}

fn tile_elevation(map: &MapData, tile_x: u16, tile_y: u16) -> Option<u8> {
    map.elevation
        .get(tile_y as usize * map.width as usize + tile_x as usize)
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
    if let Some(action) = player_state.bike_runtime.acro_runtime.pending_action() {
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
            AcroAnimationAction::WheelieHoppingMoving => BikeTransitionType::WheelieHoppingMoving,
            AcroAnimationAction::SideJump => BikeTransitionType::SideJump,
            AcroAnimationAction::TurnJump => BikeTransitionType::TurnJump,
            AcroAnimationAction::WheelieMoving => BikeTransitionType::WheelieMoving,
            AcroAnimationAction::WheelieRisingMoving => BikeTransitionType::WheelieRisingMoving,
            AcroAnimationAction::WheelieLoweringMoving => BikeTransitionType::WheelieLoweringMoving,
        };
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
        let mut elevation = Vec::with_capacity(tile_count);
        let mut behavior = Vec::with_capacity(tile_count);
        let mut metatile_id = Vec::with_capacity(tile_count);
        for tile in decoded.tiles {
            metatile_id.push(tile.metatile_id);
            collision.push(tile.collision);
            elevation.push(tile.elevation);
            behavior.push(tile.behavior_id);
        }

        Ok(Self {
            map_id: map_id.into(),
            width: decoded.width,
            height: decoded.height,
            metatile_id,
            collision,
            elevation,
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
    elevation: u8,
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
            elevation: vec![0, 1, 0, 0],
            behavior: vec![MB_BUMPY_SLOPE, 0, 0, 0],
            allow_cycling: true,
            allow_running: true,
            connections: vec![],
        }
    }

    fn landing_coordinate_regression_map() -> MapData {
        let width = 64;
        let mut behavior = vec![0; width];
        behavior[1] = MB_TALL_GRASS;
        behavior[2] = MB_PUDDLE;
        MapData {
            map_id: "MAP_LANDING_COORD_REGRESSION".to_string(),
            width: width as u16,
            height: 1,
            metatile_id: vec![0; width],
            collision: vec![0; width],
            elevation: vec![0; width],
            behavior,
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
    fn tick_then_step_order_currently_emits_side_jump_for_opposite_turn_window() {
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
            BikeTransitionType::SideJump
        );
        assert_eq!(player.bike_runtime.acro_runtime.state, AcroState::SideJump);
    }

    #[test]
    fn directional_bunny_hop_landing_pulses_once_per_tick_when_tick_then_step_both_run() {
        let mut player = test_player_state();
        player.traversal_state = TraversalState::AcroBike;
        player.preferred_bike_type = TraversalState::AcroBike;
        player.facing = Direction::Right;
        player.bike_runtime.acro_runtime.state = AcroState::BunnyHop;
        player.bike_runtime.acro_state = AcroBikeSubstate::BunnyHop;

        let mut landing_ticks = Vec::new();
        for tick in 0..48_u32 {
            update_bike_runtime_per_tick(
                &mut player,
                Some(Direction::Right),
                crate::protocol::HeldButtons::B as u8,
            );
            update_bike_runtime_after_step(&mut player, Direction::Right);

            if player.bike_runtime.acro_runtime.hop_landed_this_tick() {
                landing_ticks.push(tick);
            }
        }

        assert_eq!(landing_ticks, vec![15, 31, 47]);
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

    #[test]
    fn held_direction_tick_updates_acro_moving_transitions() {
        let mut player = test_player_state();
        player.traversal_state = TraversalState::AcroBike;
        player.facing = Direction::Right;

        player.bike_runtime.acro_runtime.state = AcroState::BunnyHop;
        player.bike_runtime.acro_runtime.movement_direction = Direction::Right;
        update_bike_runtime_per_tick(
            &mut player,
            Some(Direction::Right),
            crate::protocol::HeldButtons::B as u8,
        );
        assert_eq!(
            player.bike_runtime.last_transition,
            BikeTransitionType::WheelieHoppingMoving
        );

        player.bike_runtime.acro_runtime.state = AcroState::WheelieStanding;
        player.bike_runtime.acro_runtime.movement_direction = Direction::Right;
        update_bike_runtime_per_tick(
            &mut player,
            Some(Direction::Right),
            crate::protocol::HeldButtons::B as u8,
        );
        assert_eq!(
            player.bike_runtime.last_transition,
            BikeTransitionType::WheelieMoving
        );

        player.bike_runtime.acro_runtime.state = AcroState::Normal;
        player.bike_runtime.acro_runtime.movement_direction = Direction::Right;
        update_bike_runtime_per_tick(
            &mut player,
            Some(Direction::Right),
            crate::protocol::HeldButtons::B as u8,
        );
        assert_eq!(
            player.bike_runtime.last_transition,
            BikeTransitionType::WheelieRisingMoving
        );

        player.bike_runtime.acro_runtime.state = AcroState::WheelieMoving;
        player.bike_runtime.acro_runtime.movement_direction = Direction::Right;
        update_bike_runtime_per_tick(&mut player, Some(Direction::Right), 0);
        assert_eq!(
            player.bike_runtime.last_transition,
            BikeTransitionType::WheelieLoweringMoving
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
                        held_dpad: 0,
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
                    held_dpad: 0,
                    held_buttons: crate::protocol::HeldButtons::B as u8,
                    client_time: 0,
                },
            )
            .await
            .expect("held input should enqueue");
        for seq in 0..15_u32 {
            world
                .enqueue_held_input_state(
                    session.connection_id,
                    HeldInputState {
                        input_seq: seq + 1,
                        held_dpad: crate::protocol::HeldDpad::Right as u8,
                        held_buttons: crate::protocol::HeldButtons::B as u8,
                        client_time: (seq + 1) as u64,
                    },
                )
                .await
                .expect("held input should enqueue");
            world.tick().await;
            let _ = drain_server_messages(&mut rx);
        }
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
        for _ in 0..20 {
            world.tick().await;
        }

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
        assert_eq!(
            walk_result.bike_transition,
            Some(BikeTransitionType::WheelieIdle)
        );
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
                        held_dpad: 0,
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

    #[tokio::test]
    async fn accepted_directional_bunny_hop_uses_step1_authoritative_speed() {
        let world = test_world_with_initial_map(MapData {
            map_id: "MAP_BUNNY_HOP_SPEED_TEST".to_string(),
            width: 2,
            height: 1,
            metatile_id: vec![0; 2],
            collision: vec![0; 2],
            elevation: vec![0; 2],
            behavior: vec![0; 2],
            allow_cycling: true,
            allow_running: true,
            connections: vec![],
        });
        let (tx, mut rx) = mpsc::unbounded_channel();
        let session = world
            .create_session(tx)
            .await
            .expect("session should create");
        world
            .join_session(session.connection_id, "bunny-hop-speed")
            .await
            .expect("session should join");
        let _ = drain_server_messages(&mut rx);

        {
            let mut sessions = world.sessions.write().await;
            let session_state = sessions
                .get_mut(&session.connection_id)
                .expect("session should exist");
            session_state.player_state.map_id = "MAP_BUNNY_HOP_SPEED_TEST".to_string();
            session_state.player_state.tile_x = 0;
            session_state.player_state.tile_y = 0;
            session_state.player_state.traversal_state = TraversalState::AcroBike;
            session_state.player_state.preferred_bike_type = TraversalState::AcroBike;
            session_state.player_state.facing = Direction::Right;
            session_state.player_state.bike_runtime.acro_runtime.state = AcroState::BunnyHop;
            session_state.player_state.bike_runtime.acro_state = AcroBikeSubstate::BunnyHop;
        }

        world
            .enqueue_held_input_state(
                session.connection_id,
                HeldInputState {
                    input_seq: 0,
                    held_dpad: crate::protocol::HeldDpad::Right as u8,
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

        let walk_result = drain_server_messages(&mut rx)
            .into_iter()
            .find_map(|message| match message {
                ServerMessage::WalkResult(result) if result.input_seq == 0 => Some(result),
                _ => None,
            })
            .expect("expected accepted directional bunny-hop walk result");

        assert!(walk_result.accepted);
        assert_eq!(walk_result.authoritative_pos.x, 1);
        assert_eq!(walk_result.authoritative_pos.y, 0);
        assert_eq!(walk_result.authoritative_step_speed, Some(StepSpeed::Step1));
    }

    #[tokio::test]
    async fn bunny_hop_queues_first_directional_walk_before_held_direction_update() {
        let world = test_world_with_initial_map(MapData {
            map_id: "MAP_BUNNY_HOP_ORDERING".to_string(),
            width: 2,
            height: 1,
            metatile_id: vec![0; 2],
            collision: vec![0, 1],
            elevation: vec![0, 1],
            behavior: vec![0; 2],
            allow_cycling: true,
            allow_running: true,
            connections: vec![],
        });
        let (tx, mut rx) = mpsc::unbounded_channel();
        let session = world
            .create_session(tx)
            .await
            .expect("session should create");
        world
            .join_session(session.connection_id, "bunny-hop-ordering")
            .await
            .expect("session should join");
        let _ = drain_server_messages(&mut rx);

        {
            let mut sessions = world.sessions.write().await;
            let session_state = sessions
                .get_mut(&session.connection_id)
                .expect("session should exist");
            session_state.player_state.map_id = "MAP_BUNNY_HOP_ORDERING".to_string();
            session_state.player_state.tile_x = 0;
            session_state.player_state.tile_y = 0;
            session_state.player_state.traversal_state = TraversalState::AcroBike;
            session_state.player_state.preferred_bike_type = TraversalState::AcroBike;
            session_state.player_state.facing = Direction::Right;
            session_state.player_state.bike_runtime.acro_runtime.state = AcroState::BunnyHop;
            session_state.player_state.bike_runtime.acro_state = AcroBikeSubstate::BunnyHop;
        }

        world
            .enqueue_held_input_state(
                session.connection_id,
                HeldInputState {
                    input_seq: 0,
                    held_dpad: 0,
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
        for _ in 0..20 {
            world.tick().await;
        }

        let walk_result = drain_server_messages(&mut rx)
            .into_iter()
            .find_map(|message| match message {
                ServerMessage::WalkResult(result) if result.input_seq == 0 => Some(result),
                _ => None,
            })
            .expect("expected walk result");
        assert!(!walk_result.accepted);
        assert_eq!(walk_result.reason, RejectionReason::Collision);
    }

    #[tokio::test]
    async fn bunny_hop_off_cadence_directional_inputs_are_not_rejected() {
        let world = test_world_with_initial_map(MapData {
            map_id: "MAP_BUNNY_HOP_CADENCE_REASON".to_string(),
            width: 8,
            height: 1,
            metatile_id: vec![0; 8],
            collision: vec![0; 8],
            elevation: vec![0; 8],
            behavior: vec![0; 8],
            allow_cycling: true,
            allow_running: true,
            connections: vec![],
        });
        let (tx, mut rx) = mpsc::unbounded_channel();
        let session = world
            .create_session(tx)
            .await
            .expect("session should create");
        world
            .join_session(session.connection_id, "bunny-hop-cadence-reason")
            .await
            .expect("session should join");
        let _ = drain_server_messages(&mut rx);

        {
            let mut sessions = world.sessions.write().await;
            let session_state = sessions
                .get_mut(&session.connection_id)
                .expect("session should exist");
            session_state.player_state.map_id = "MAP_BUNNY_HOP_CADENCE_REASON".to_string();
            session_state.player_state.traversal_state = TraversalState::AcroBike;
            session_state.player_state.preferred_bike_type = TraversalState::AcroBike;
            session_state.player_state.facing = Direction::Right;
            session_state.player_state.bike_runtime.acro_runtime.state = AcroState::BunnyHop;
            session_state.player_state.bike_runtime.acro_state = AcroBikeSubstate::BunnyHop;
        }

        for seq in 0..24_u32 {
            world
                .enqueue_held_input_state(
                    session.connection_id,
                    HeldInputState {
                        input_seq: seq,
                        held_dpad: crate::protocol::HeldDpad::Right as u8,
                        held_buttons: crate::protocol::HeldButtons::B as u8,
                        client_time: seq as u64,
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
                        input_seq: seq,
                        client_time: seq as u64,
                    },
                )
                .await
                .expect("walk input should enqueue");
            world.tick().await;
        }

        let walk_results: Vec<WalkResult> = drain_server_messages(&mut rx)
            .into_iter()
            .filter_map(|message| match message {
                ServerMessage::WalkResult(result) => Some(result),
                _ => None,
            })
            .collect();

        assert!(
            walk_results
                .iter()
                .all(|result| result.reason != RejectionReason::ForcedMovementDisabled),
            "off-cadence bunny-hop directional samples should be queued instead of rejected"
        );
        assert!(
            walk_results
                .iter()
                .filter(|result| !result.accepted)
                .all(|result| result.reason != RejectionReason::InvalidDirection),
            "cadence misses during bunny hop must not be surfaced as INVALID_DIRECTION"
        );
    }

    #[tokio::test]
    async fn bunny_hop_repeated_directional_attempts_crossing_cadence_boundaries_eventually_accept()
    {
        let world = test_world_with_initial_map(MapData {
            map_id: "MAP_BUNNY_HOP_CONTINUOUS_INPUT".to_string(),
            width: 64,
            height: 1,
            metatile_id: vec![0; 64],
            collision: vec![0; 64],
            elevation: vec![0; 64],
            behavior: vec![0; 64],
            allow_cycling: true,
            allow_running: true,
            connections: vec![],
        });
        let (tx, mut rx) = mpsc::unbounded_channel();
        let session = world
            .create_session(tx)
            .await
            .expect("session should create");
        world
            .join_session(session.connection_id, "bunny-hop-continuous-input")
            .await
            .expect("session should join");
        let _ = drain_server_messages(&mut rx);

        {
            let mut sessions = world.sessions.write().await;
            let session_state = sessions
                .get_mut(&session.connection_id)
                .expect("session should exist");
            session_state.player_state.map_id = "MAP_BUNNY_HOP_CONTINUOUS_INPUT".to_string();
            session_state.player_state.traversal_state = TraversalState::AcroBike;
            session_state.player_state.preferred_bike_type = TraversalState::AcroBike;
            session_state.player_state.facing = Direction::Right;
            session_state.player_state.bike_runtime.acro_runtime.state = AcroState::BunnyHop;
            session_state.player_state.bike_runtime.acro_state = AcroBikeSubstate::BunnyHop;
        }

        for seq in 0..40_u32 {
            world
                .enqueue_held_input_state(
                    session.connection_id,
                    HeldInputState {
                        input_seq: seq,
                        held_dpad: crate::protocol::HeldDpad::Right as u8,
                        held_buttons: crate::protocol::HeldButtons::B as u8,
                        client_time: seq as u64,
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
                        input_seq: seq,
                        client_time: seq as u64,
                    },
                )
                .await
                .expect("walk input should enqueue");
            world.tick().await;
        }

        let walk_results: Vec<WalkResult> = drain_server_messages(&mut rx)
            .into_iter()
            .filter_map(|message| match message {
                ServerMessage::WalkResult(result) => Some(result),
                _ => None,
            })
            .collect();

        assert!(
            walk_results.iter().any(|result| result.accepted),
            "expected at least one accepted directional attempt while continuously holding B"
        );
        assert!(
            walk_results
                .iter()
                .all(|result| result.reason != RejectionReason::ForcedMovementDisabled),
            "off-cadence directional attempts should no longer surface forced-movement cadence misses"
        );
    }

    #[tokio::test]
    async fn bunny_hop_continuous_directional_input_has_no_periodic_idle_gaps_across_long_runs() {
        let world = test_world_with_initial_map(MapData {
            map_id: "MAP_BUNNY_HOP_LONG_RUN".to_string(),
            width: 128,
            height: 1,
            metatile_id: vec![0; 128],
            collision: vec![0; 128],
            elevation: vec![0; 128],
            behavior: vec![0; 128],
            allow_cycling: true,
            allow_running: true,
            connections: vec![],
        });
        let (tx, mut rx) = mpsc::unbounded_channel();
        let session = world
            .create_session(tx)
            .await
            .expect("session should create");
        world
            .join_session(session.connection_id, "bunny-hop-long-run")
            .await
            .expect("session should join");
        let _ = drain_server_messages(&mut rx);

        {
            let mut sessions = world.sessions.write().await;
            let session_state = sessions
                .get_mut(&session.connection_id)
                .expect("session should exist");
            session_state.player_state.map_id = "MAP_BUNNY_HOP_LONG_RUN".to_string();
            session_state.player_state.traversal_state = TraversalState::AcroBike;
            session_state.player_state.preferred_bike_type = TraversalState::AcroBike;
            session_state.player_state.facing = Direction::Right;
            session_state.player_state.bike_runtime.acro_runtime.state = AcroState::BunnyHop;
            session_state.player_state.bike_runtime.acro_state = AcroBikeSubstate::BunnyHop;
        }

        let target_hops = 24_u32;
        let mut next_seq = 0_u32;
        let mut accepted_frames = Vec::new();

        for _ in 0..1_200 {
            let can_enqueue = {
                let sessions = world.sessions.read().await;
                let session_state = sessions
                    .get(&session.connection_id)
                    .expect("session should exist");
                session_state.walk_inputs_len() == 0
            };

            if can_enqueue && next_seq < target_hops {
                world
                    .enqueue_held_input_state(
                        session.connection_id,
                        HeldInputState {
                            input_seq: next_seq,
                            held_dpad: crate::protocol::HeldDpad::Right as u8,
                            held_buttons: crate::protocol::HeldButtons::B as u8,
                            client_time: next_seq as u64,
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
                            input_seq: next_seq,
                            client_time: next_seq as u64,
                        },
                    )
                    .await
                    .expect("walk input should enqueue");
                next_seq = next_seq.saturating_add(1);
            }

            world.tick().await;
            for message in drain_server_messages(&mut rx) {
                if let ServerMessage::WalkResult(result) = message {
                    if result.accepted {
                        accepted_frames.push(result.server_frame);
                    }
                }
            }
            if accepted_frames.len() >= target_hops as usize {
                break;
            }
        }

        assert_eq!(
            accepted_frames.len(),
            target_hops as usize,
            "expected long-run bunny-hop sequence to accept each queued directional hop"
        );

        let deltas: Vec<u32> = accepted_frames
            .windows(2)
            .map(|window| window[1].saturating_sub(window[0]))
            .collect();
        assert!(
            !deltas.is_empty(),
            "expected at least one accepted hop interval"
        );
        if deltas.len() > 1 {
            let steady_state = &deltas[1..];
            let min_gap = *steady_state.iter().min().expect("steady-state min gap");
            let max_gap = *steady_state.iter().max().expect("steady-state max gap");
            assert_eq!(
                min_gap, max_gap,
                "continuous bunny-hop should not show periodic idle gaps between accepted hops"
            );
        }
    }

    #[tokio::test]
    async fn hop_landing_particles_emit_across_repeated_bunny_hop_cycles_with_continuous_b_hold() {
        let (maps_index, layouts_index) = test_asset_paths();
        let world = World::load_from_assets("MAP_LITTLEROOT_TOWN", &maps_index, &layouts_index)
            .expect("world should load");

        let (tx, mut rx) = mpsc::unbounded_channel();
        let session = world
            .create_session(tx)
            .await
            .expect("session should create");
        world
            .join_session(session.connection_id, "repeated-hop-landing-particles")
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

        let mut landing_deltas = Vec::new();
        for input_seq in 0..140_u32 {
            world
                .enqueue_held_input_state(
                    session.connection_id,
                    HeldInputState {
                        input_seq,
                        held_dpad: 0,
                        held_buttons: crate::protocol::HeldButtons::B as u8,
                        client_time: input_seq as u64,
                    },
                )
                .await
                .expect("held input should enqueue");
            world.tick().await;

            for message in drain_server_messages(&mut rx) {
                if let ServerMessage::BikeRuntimeDelta(delta) = message {
                    if delta.hop_landing_particle_class.is_some() {
                        landing_deltas.push(delta);
                    }
                }
            }
        }

        assert!(
            landing_deltas.len() >= 2,
            "expected repeated bunny-hop landing particle deltas while B is held continuously"
        );

        let has_repeated_runtime_state = landing_deltas.windows(2).any(|pair| {
            pair[0].acro_substate == pair[1].acro_substate
                && pair[0].bike_transition == pair[1].bike_transition
        });
        assert!(
            has_repeated_runtime_state,
            "expected at least one pair of consecutive landing particle deltas with unchanged runtime state"
        );
    }

    async fn first_stationary_landing_delta_for_facing(facing: Direction) -> BikeRuntimeDelta {
        let world = test_world_with_initial_map(landing_coordinate_regression_map());
        let (tx, mut rx) = mpsc::unbounded_channel();
        let session = world
            .create_session(tx)
            .await
            .expect("session should create");
        world
            .join_session(session.connection_id, "stationary-runtime-delta-facing")
            .await
            .expect("session should join");
        let _ = drain_server_messages(&mut rx);

        {
            let mut sessions = world.sessions.write().await;
            let session_state = sessions
                .get_mut(&session.connection_id)
                .expect("session should exist");
            session_state.player_state.map_id = "MAP_LANDING_COORD_REGRESSION".to_string();
            session_state.player_state.tile_x = 0;
            session_state.player_state.tile_y = 0;
            session_state.player_state.traversal_state = TraversalState::AcroBike;
            session_state.player_state.preferred_bike_type = TraversalState::AcroBike;
            session_state.player_state.facing = facing;
            session_state.player_state.bike_runtime.acro_runtime.state = AcroState::BunnyHop;
            session_state.player_state.bike_runtime.acro_state = AcroBikeSubstate::BunnyHop;
        }

        for input_seq in 0..64_u32 {
            world
                .enqueue_held_input_state(
                    session.connection_id,
                    HeldInputState {
                        input_seq,
                        held_dpad: 0,
                        held_buttons: crate::protocol::HeldButtons::B as u8,
                        client_time: input_seq as u64,
                    },
                )
                .await
                .expect("held input should enqueue");
            world.tick().await;
            if let Some(delta) = drain_server_messages(&mut rx)
                .into_iter()
                .find_map(|message| match message {
                    ServerMessage::BikeRuntimeDelta(delta)
                        if delta.hop_landing_particle_class.is_some() =>
                    {
                        Some(delta)
                    }
                    _ => None,
                })
            {
                return delta;
            }
        }

        panic!("expected landing pulse from stationary acro bunny-hop");
    }

    #[tokio::test]
    async fn stationary_bunny_hop_runtime_delta_reports_left_facing_authoritatively() {
        let landing_delta = first_stationary_landing_delta_for_facing(Direction::Left).await;
        assert_eq!(landing_delta.facing, Direction::Left);
    }

    #[tokio::test]
    async fn stationary_bunny_hop_runtime_delta_reports_right_facing_authoritatively() {
        let landing_delta = first_stationary_landing_delta_for_facing(Direction::Right).await;
        assert_eq!(landing_delta.facing, Direction::Right);
    }

    #[tokio::test]
    async fn accepted_directional_bunny_hop_walk_result_emits_landing_coordinates_from_tile_b() {
        let world = test_world_with_initial_map(landing_coordinate_regression_map());
        let (tx, mut rx) = mpsc::unbounded_channel();
        let session = world
            .create_session(tx)
            .await
            .expect("session should create");
        world
            .join_session(session.connection_id, "walk-result-landing-coordinates")
            .await
            .expect("session should join");
        let _ = drain_server_messages(&mut rx);

        {
            let mut sessions = world.sessions.write().await;
            let session_state = sessions
                .get_mut(&session.connection_id)
                .expect("session should exist");
            session_state.player_state.map_id = "MAP_LANDING_COORD_REGRESSION".to_string();
            session_state.player_state.tile_x = 0;
            session_state.player_state.tile_y = 0;
            session_state.player_state.traversal_state = TraversalState::AcroBike;
            session_state.player_state.preferred_bike_type = TraversalState::AcroBike;
            session_state.player_state.facing = Direction::Right;
            session_state.player_state.bike_runtime.acro_runtime.state = AcroState::BunnyHop;
            session_state.player_state.bike_runtime.acro_state = AcroBikeSubstate::BunnyHop;
        }

        let mut held_seq = 0_u32;
        let mut observed_landing_pulse = false;
        for _ in 0..48 {
            world
                .enqueue_held_input_state(
                    session.connection_id,
                    HeldInputState {
                        input_seq: held_seq,
                        held_dpad: crate::protocol::HeldDpad::Right as u8,
                        held_buttons: crate::protocol::HeldButtons::B as u8,
                        client_time: held_seq as u64,
                    },
                )
                .await
                .expect("held input should enqueue");
            held_seq = held_seq.saturating_add(1);
            world.tick().await;
            observed_landing_pulse = drain_server_messages(&mut rx).into_iter().any(|message| {
                matches!(
                    message,
                    ServerMessage::BikeRuntimeDelta(BikeRuntimeDelta {
                        hop_landing_particle_class: Some(_),
                        ..
                    })
                )
            });
            if observed_landing_pulse {
                break;
            }
        }
        assert!(
            observed_landing_pulse,
            "expected baseline bunny-hop landing pulse before alignment"
        );

        for _ in 0..15 {
            world
                .enqueue_held_input_state(
                    session.connection_id,
                    HeldInputState {
                        input_seq: held_seq,
                        held_dpad: crate::protocol::HeldDpad::Right as u8,
                        held_buttons: crate::protocol::HeldButtons::B as u8,
                        client_time: held_seq as u64,
                    },
                )
                .await
                .expect("held input should enqueue");
            held_seq = held_seq.saturating_add(1);
            world.tick().await;
            let _ = drain_server_messages(&mut rx);
        }

        world
            .enqueue_held_input_state(
                session.connection_id,
                HeldInputState {
                    input_seq: held_seq,
                    held_dpad: crate::protocol::HeldDpad::Right as u8,
                    held_buttons: crate::protocol::HeldButtons::B as u8,
                    client_time: held_seq as u64,
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

        let landed_walk_result = drain_server_messages(&mut rx)
            .into_iter()
            .find_map(|message| match message {
                ServerMessage::WalkResult(result)
                    if result.accepted && result.hop_landing_particle_class.is_some() =>
                {
                    Some(result)
                }
                _ => None,
            });

        let landed_walk_result =
            landed_walk_result.expect("expected accepted walk result with hop landing emission");
        assert_eq!(
            landed_walk_result.hop_landing_tile_x,
            Some(landed_walk_result.authoritative_pos.x),
        );
        assert_eq!(
            landed_walk_result.hop_landing_tile_y,
            Some(landed_walk_result.authoritative_pos.y),
        );
        assert_eq!(
            landed_walk_result.hop_landing_particle_class,
            Some(HopLandingParticleClass::TallGrassJump),
            "particle class must be computed from the same landing tile emitted in coordinates",
        );
        assert_eq!(
            landed_walk_result.hop_landing_tile_x,
            Some(1),
            "accepted movement from tile A=(0,0) to tile B=(1,0) must emit tile B coordinates",
        );
        assert_eq!(landed_walk_result.hop_landing_tile_y, Some(0));
    }

    #[tokio::test]
    async fn bunny_hop_runtime_delta_does_not_emit_mid_cycle_landing_while_transition_is_active() {
        let world = test_world_with_initial_map(landing_coordinate_regression_map());
        let (tx, mut rx) = mpsc::unbounded_channel();
        let session = world
            .create_session(tx)
            .await
            .expect("session should create");
        world
            .join_session(
                session.connection_id,
                "runtime-delta-active-transition-landing",
            )
            .await
            .expect("session should join");
        let _ = drain_server_messages(&mut rx);

        {
            let mut sessions = world.sessions.write().await;
            let session_state = sessions
                .get_mut(&session.connection_id)
                .expect("session should exist");
            session_state.player_state.map_id = "MAP_LANDING_COORD_REGRESSION".to_string();
            session_state.player_state.tile_x = 0;
            session_state.player_state.tile_y = 0;
            session_state.player_state.traversal_state = TraversalState::AcroBike;
            session_state.player_state.preferred_bike_type = TraversalState::AcroBike;
            session_state.player_state.facing = Direction::Right;
            session_state.player_state.bike_runtime.acro_runtime.state = AcroState::BunnyHop;
            session_state.player_state.bike_runtime.acro_state = AcroBikeSubstate::BunnyHop;
        }

        let mut held_seq = 0_u32;

        // Find a landing tick to align the next accepted walk to one tick before
        // the subsequent landing pulse.
        let mut observed_landing_pulse = false;
        for _ in 0..48 {
            world
                .enqueue_held_input_state(
                    session.connection_id,
                    HeldInputState {
                        input_seq: held_seq,
                        held_dpad: crate::protocol::HeldDpad::Right as u8,
                        held_buttons: crate::protocol::HeldButtons::B as u8,
                        client_time: held_seq as u64,
                    },
                )
                .await
                .expect("held input should enqueue");
            held_seq = held_seq.saturating_add(1);
            world.tick().await;
            observed_landing_pulse = drain_server_messages(&mut rx).into_iter().any(|message| {
                matches!(
                    message,
                    ServerMessage::BikeRuntimeDelta(BikeRuntimeDelta {
                        hop_landing_particle_class: Some(_),
                        ..
                    })
                )
            });
            if observed_landing_pulse {
                break;
            }
        }
        assert!(
            observed_landing_pulse,
            "expected at least one baseline landing pulse while idling in bunny-hop state"
        );

        for _ in 0..15 {
            world
                .enqueue_held_input_state(
                    session.connection_id,
                    HeldInputState {
                        input_seq: held_seq,
                        held_dpad: crate::protocol::HeldDpad::Right as u8,
                        held_buttons: crate::protocol::HeldButtons::B as u8,
                        client_time: held_seq as u64,
                    },
                )
                .await
                .expect("held input should enqueue");
            held_seq = held_seq.saturating_add(1);
            world.tick().await;
            let _ = drain_server_messages(&mut rx);
        }

        world
            .enqueue_held_input_state(
                session.connection_id,
                HeldInputState {
                    input_seq: held_seq,
                    held_dpad: crate::protocol::HeldDpad::Right as u8,
                    held_buttons: crate::protocol::HeldButtons::B as u8,
                    client_time: held_seq as u64,
                },
            )
            .await
            .expect("held input should enqueue");
        held_seq = held_seq.saturating_add(1);
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
        let _ = drain_server_messages(&mut rx);

        {
            let sessions = world.sessions.read().await;
            let session_state = sessions
                .get(&session.connection_id)
                .expect("session should exist");
            assert!(
                session_state.active_walk_transition.is_some(),
                "accepted directional walk should create active walk transition before completion"
            );
        }

        world
            .enqueue_held_input_state(
                session.connection_id,
                HeldInputState {
                    input_seq: held_seq,
                    held_dpad: crate::protocol::HeldDpad::Right as u8,
                    held_buttons: crate::protocol::HeldButtons::B as u8,
                    client_time: held_seq as u64,
                },
            )
            .await
            .expect("held input should enqueue");
        world.tick().await;

        let runtime_landing_delta =
            drain_server_messages(&mut rx)
                .into_iter()
                .find_map(|message| match message {
                    ServerMessage::BikeRuntimeDelta(delta)
                        if delta.hop_landing_particle_class.is_some() =>
                    {
                        Some(delta)
                    }
                    _ => None,
                });
        assert!(
            runtime_landing_delta.is_none(),
            "cadence-gated directional bunny-hop should not emit a mid-cycle landing pulse while transition is active"
        );
    }

    #[test]
    fn hop_landing_particle_coordinates_match_between_runtime_delta_and_walk_result_paths() {
        let map = MapData {
            map_id: "MAP_LANDING_COORD_PARITY".to_string(),
            width: 1,
            height: 1,
            metatile_id: vec![0],
            collision: vec![0],
            elevation: vec![0],
            behavior: vec![MB_TALL_GRASS],
            allow_cycling: true,
            allow_running: true,
            connections: vec![],
        };

        let runtime_delta_signal =
            hop_landing_signal_for_authoritative_tile(Some(&map), 0, 0, true);
        let walk_result_signal = hop_landing_signal_for_authoritative_tile(Some(&map), 0, 0, true);

        assert_eq!(runtime_delta_signal, walk_result_signal);
        assert_eq!(
            runtime_delta_signal,
            (Some(HopLandingParticleClass::TallGrassJump), Some((0, 0)))
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
    fn releasing_b_while_in_bunny_hop_latches_until_landing_then_exits_wheelie_flow() {
        let mut player = test_player_state();
        player.traversal_state = TraversalState::AcroBike;
        player.bike_runtime.acro_runtime.state = AcroState::BunnyHop;
        player.bike_runtime.acro_state = AcroBikeSubstate::BunnyHop;

        update_bike_runtime_per_tick(&mut player, None, crate::protocol::HeldButtons::B as u8);
        assert!(player.bike_runtime.acro_runtime.holding_b);

        update_bike_runtime_per_tick(&mut player, None, 0);
        assert!(!player.bike_runtime.acro_runtime.holding_b);
        assert_eq!(player.bike_runtime.acro_runtime.state, AcroState::BunnyHop);
        assert_ne!(
            player.bike_runtime.last_transition,
            BikeTransitionType::WheelieToNormal
        );

        for _ in 0..16 {
            update_bike_runtime_per_tick(&mut player, None, 0);
            if player.bike_runtime.acro_runtime.state == AcroState::Normal {
                break;
            }
        }

        assert_eq!(player.bike_runtime.acro_runtime.state, AcroState::Normal);
        assert_eq!(
            player.bike_runtime.last_transition,
            BikeTransitionType::WheelieToNormal
        );
    }

    #[tokio::test]
    async fn bunny_hop_release_setdown_tick_accepts_directional_walk_without_pause() {
        let world = test_world_with_initial_map(landing_coordinate_regression_map());
        let (tx, mut rx) = mpsc::unbounded_channel();
        let session = world
            .create_session(tx)
            .await
            .expect("session should create");
        world
            .join_session(session.connection_id, "release-setdown-lock")
            .await
            .expect("session should join");
        let _ = drain_server_messages(&mut rx);

        {
            let mut sessions = world.sessions.write().await;
            let session_state = sessions
                .get_mut(&session.connection_id)
                .expect("session should exist");
            session_state.player_state.map_id = "MAP_LANDING_COORD_REGRESSION".to_string();
            session_state.player_state.tile_x = 0;
            session_state.player_state.tile_y = 0;
            session_state.player_state.facing = Direction::Right;
            session_state.player_state.traversal_state = TraversalState::AcroBike;
            session_state.player_state.preferred_bike_type = TraversalState::AcroBike;
            session_state.player_state.bike_runtime.acro_runtime.state = AcroState::BunnyHop;
            session_state.player_state.bike_runtime.acro_state = AcroBikeSubstate::BunnyHop;
            session_state.active_walk_transition = Some(ActiveWalkTransition::new(
                777,
                "MAP_LANDING_COORD_REGRESSION".to_string(),
                0,
                0,
                "MAP_LANDING_COORD_REGRESSION".to_string(),
                1,
                0,
                Direction::Right,
                MovementMode::Walk,
                MovementStepSpeed::Step2,
            ));
        }

        world
            .enqueue_held_input_state(
                session.connection_id,
                HeldInputState {
                    input_seq: 0,
                    held_dpad: crate::protocol::HeldDpad::None as u8,
                    held_buttons: crate::protocol::HeldButtons::B as u8,
                    client_time: 0,
                },
            )
            .await
            .expect("held input should enqueue");
        world.tick().await;
        let _ = drain_server_messages(&mut rx);

        let mut held_seq = 1_u32;
        let mut walk_seq = 0_u32;
        let mut saw_resume_tick = false;
        let mut saw_mid_hop_setdown = false;

        for _ in 0..32 {
            let progress_before_tick = {
                let sessions = world.sessions.read().await;
                sessions
                    .get(&session.connection_id)
                    .and_then(|session_state| {
                        session_state
                            .active_walk_transition
                            .as_ref()
                            .map(|transition| transition.progress_pixels())
                    })
            };
            world
                .enqueue_held_input_state(
                    session.connection_id,
                    HeldInputState {
                        input_seq: held_seq,
                        held_dpad: crate::protocol::HeldDpad::Right as u8,
                        held_buttons: 0,
                        client_time: held_seq as u64,
                    },
                )
                .await
                .expect("held input should enqueue");
            held_seq = held_seq.saturating_add(1);
            world
                .enqueue_walk_input(
                    session.connection_id,
                    WalkInput {
                        direction: Direction::Right,
                        movement_mode: MovementMode::Walk,
                        held_buttons: 0,
                        input_seq: walk_seq,
                        client_time: walk_seq as u64,
                    },
                )
                .await
                .expect("walk input should enqueue");
            walk_seq = walk_seq.saturating_add(1);
            world.tick().await;

            let tick_messages = drain_server_messages(&mut rx);
            let emitted_setdown = tick_messages.iter().any(|message| {
                matches!(
                    message,
                    ServerMessage::BikeRuntimeDelta(BikeRuntimeDelta {
                        bike_transition: Some(BikeTransitionType::WheelieToNormal),
                        ..
                    })
                )
            });
            let accepted_this_tick = tick_messages.iter().any(|message| {
                matches!(
                    message,
                    ServerMessage::WalkResult(WalkResult { accepted: true, .. })
                )
            });

            if emitted_setdown {
                let sessions = world.sessions.read().await;
                let transition_progress_after_tick =
                    sessions
                        .get(&session.connection_id)
                        .and_then(|session_state| {
                            session_state
                                .active_walk_transition
                                .as_ref()
                                .map(|transition| transition.progress_pixels())
                        });
                if transition_progress_after_tick.is_some() && progress_before_tick.is_some() {
                    saw_mid_hop_setdown = true;
                }
                continue;
            }

            if accepted_this_tick {
                saw_resume_tick = true;
                break;
            }
        }

        assert!(
            !saw_mid_hop_setdown,
            "WheelieToNormal should be deferred until hop interpolation is complete"
        );
        assert!(
            saw_resume_tick,
            "expected directional movement acceptance to resume without synthetic lock requeue"
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
    fn hop_landing_particles_emit_from_explicit_landing_signal() {
        let map = MapData {
            map_id: "MAP_TEST".to_string(),
            width: 1,
            height: 1,
            metatile_id: vec![0],
            collision: vec![0],
            elevation: vec![0],
            behavior: vec![0],
            allow_cycling: true,
            allow_running: true,
            connections: vec![],
        };

        let airborne = hop_landing_signal_for_authoritative_tile(Some(&map), 0, 0, false);
        assert_eq!(airborne, (None, None));

        let landing = hop_landing_signal_for_authoritative_tile(Some(&map), 0, 0, true);
        assert_eq!(
            landing,
            (
                Some(HopLandingParticleClass::NormalGroundDust),
                Some((0, 0))
            )
        );

        let grounded = hop_landing_signal_for_authoritative_tile(Some(&map), 0, 0, false);
        assert_eq!(grounded, (None, None));
    }

    #[test]
    fn hop_landing_particle_coordinates_are_stable_for_classification_tile() {
        let map = MapData {
            map_id: "MAP_TEST".to_string(),
            width: 3,
            height: 1,
            metatile_id: vec![0; 3],
            collision: vec![0; 3],
            elevation: vec![0; 3],
            behavior: vec![0, MB_TALL_GRASS, MB_PUDDLE],
            allow_cycling: true,
            allow_running: true,
            connections: vec![],
        };

        let tall_grass_landing = hop_landing_signal_for_authoritative_tile(Some(&map), 1, 0, true);
        assert_eq!(
            tall_grass_landing,
            (Some(HopLandingParticleClass::TallGrassJump), Some((1, 0)))
        );

        let puddle_landing = hop_landing_signal_for_authoritative_tile(Some(&map), 2, 0, true);
        assert_eq!(
            puddle_landing,
            (
                Some(HopLandingParticleClass::ShallowWaterSplash),
                Some((2, 0))
            )
        );
    }

    #[test]
    fn stationary_vs_directional_hop_landing_coordinates_use_the_same_authoritative_tile_for_classification(
    ) {
        let map = landing_coordinate_regression_map();

        let stationary_landing = hop_landing_signal_for_authoritative_tile(Some(&map), 0, 0, true);
        let directional_landing = hop_landing_signal_for_authoritative_tile(Some(&map), 1, 0, true);

        assert_eq!(
            stationary_landing,
            (
                Some(HopLandingParticleClass::NormalGroundDust),
                Some((0, 0))
            )
        );
        assert_eq!(
            directional_landing,
            (Some(HopLandingParticleClass::TallGrassJump), Some((1, 0)))
        );
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
            elevation: vec![0; 4],
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
            elevation: vec![0; 4],
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
            elevation: vec![0; 4],
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

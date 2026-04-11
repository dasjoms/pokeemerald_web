use std::collections::VecDeque;

use tokio::sync::mpsc;

use crate::{
    acro::AcroRuntime,
    movement::{step_progress_pixels, StepSpeed, WALK_SAMPLE_MS},
    protocol::{
        AcroBikeSubstate, BikeTransitionType, Direction, HeldInputState, MovementMode,
        PlayerAvatar, ServerMessage, TraversalState, WalkInput,
    },
};

pub const MAX_PENDING_WALK_INPUTS: usize = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WalkIntentTimingValidation {
    Accepted,
    HeldDirectionMismatch,
    CadenceMiss,
}

#[derive(Debug, Clone)]
pub struct PlayerState {
    pub map_id: String,
    pub tile_x: u16,
    pub tile_y: u16,
    pub facing: Direction,
    pub avatar: PlayerAvatar,
    pub traversal_state: TraversalState,
    pub preferred_bike_type: TraversalState,
    pub bike_runtime: BikeRuntimeState,
    pub cracked_floor: CrackedFloorRuntimeState,
}

#[derive(Debug, Clone)]
pub struct BikeRuntimeState {
    pub mach_speed_stage: u8,
    pub bike_frame_counter: u8,
    pub speed_tier: u8,
    pub mach_dir_traveling: Option<Direction>,
    pub acro_state: AcroBikeSubstate,
    pub last_transition: BikeTransitionType,
    pub preserve_transition_until_walk_result: bool,
    pub action_in_progress: bool,
    pub queued_transition: Option<BikeTransitionType>,
    pub queued_acro_state: Option<AcroBikeSubstate>,
    pub acro_runtime: AcroRuntime,
}

#[derive(Debug, Clone)]
pub struct CrackedFloorRuntimeState {
    pub prev_map_id: String,
    pub prev_x: u16,
    pub prev_y: u16,
    pub pending_floors: [PendingCrackedFloor; 2],
    pub failed_speed_gate: bool,
}

#[derive(Debug, Clone)]
pub struct PendingCrackedFloor {
    pub map_id: String,
    pub x: u16,
    pub y: u16,
    pub delay_steps: u8,
    pub collapsed: bool,
}

impl Default for CrackedFloorRuntimeState {
    fn default() -> Self {
        Self {
            prev_map_id: String::new(),
            prev_x: 0,
            prev_y: 0,
            pending_floors: [
                PendingCrackedFloor::default(),
                PendingCrackedFloor::default(),
            ],
            failed_speed_gate: false,
        }
    }
}

impl Default for PendingCrackedFloor {
    fn default() -> Self {
        Self {
            map_id: String::new(),
            x: 0,
            y: 0,
            delay_steps: 0,
            collapsed: false,
        }
    }
}

impl Default for BikeRuntimeState {
    fn default() -> Self {
        Self {
            mach_speed_stage: 0,
            bike_frame_counter: 0,
            speed_tier: 1,
            mach_dir_traveling: None,
            acro_state: AcroBikeSubstate::None,
            last_transition: BikeTransitionType::None,
            preserve_transition_until_walk_result: false,
            action_in_progress: false,
            queued_transition: None,
            queued_acro_state: None,
            acro_runtime: AcroRuntime::default(),
        }
    }
}

#[derive(Debug, Clone)]
pub struct ActiveWalkTransition {
    pub input_seq: u32,
    pub start_map_id: String,
    pub start_x: u16,
    pub start_y: u16,
    pub target_map_id: String,
    pub target_x: u16,
    pub target_y: u16,
    pub direction: Direction,
    pub movement_mode: MovementMode,
    pub speed: StepSpeed,
    sample_accumulator_ms: f32,
    elapsed_samples: u16,
}

impl ActiveWalkTransition {
    pub fn new(
        input_seq: u32,
        start_map_id: String,
        start_x: u16,
        start_y: u16,
        target_map_id: String,
        target_x: u16,
        target_y: u16,
        direction: Direction,
        movement_mode: MovementMode,
        speed: StepSpeed,
    ) -> Self {
        Self {
            input_seq,
            start_map_id,
            start_x,
            start_y,
            target_map_id,
            target_x,
            target_y,
            direction,
            movement_mode,
            speed,
            sample_accumulator_ms: 0.0,
            elapsed_samples: 0,
        }
    }

    pub fn advance(&mut self, tick_delta_ms: f32) {
        self.sample_accumulator_ms += tick_delta_ms.max(0.0);
        while self.sample_accumulator_ms >= WALK_SAMPLE_MS {
            self.sample_accumulator_ms -= WALK_SAMPLE_MS;
            self.elapsed_samples = self.elapsed_samples.saturating_add(1);
        }
    }

    pub fn progress_pixels(&self) -> u16 {
        step_progress_pixels(self.elapsed_samples, self.speed)
    }

    pub fn is_complete(&self) -> bool {
        self.elapsed_samples >= self.speed.samples_per_tile()
    }
}

#[derive(Debug)]
pub struct Session {
    pub connection_id: u64,
    pub player_id: String,
    pub player_state: PlayerState,
    pub joined: bool,
    pub next_expected_input_seq: u32,
    pub next_expected_held_input_seq: u32,
    pub active_walk_transition: Option<ActiveWalkTransition>,
    pub avatar_action_lock: Option<AvatarActionLock>,
    pub held_dpad: u8,
    resolved_held_direction: Option<Direction>,
    pub held_buttons: u8,
    authoritative_tick: u64,
    bunny_hop_cadence_open_on_tick: Option<u64>,
    bunny_hop_cadence_initialized: bool,
    pending_bunny_hop_direction: Option<Direction>,
    step_end_direction_intent: Option<Direction>,
    walk_inputs: VecDeque<WalkInput>,
    outbound: mpsc::UnboundedSender<ServerMessage>,
}

impl Session {
    pub fn new(
        connection_id: u64,
        player_id: String,
        player_state: PlayerState,
        outbound: mpsc::UnboundedSender<ServerMessage>,
    ) -> Self {
        Self {
            connection_id,
            player_id,
            player_state,
            joined: false,
            next_expected_input_seq: 0,
            next_expected_held_input_seq: 0,
            active_walk_transition: None,
            avatar_action_lock: None,
            held_dpad: 0,
            resolved_held_direction: None,
            held_buttons: 0,
            authoritative_tick: 0,
            bunny_hop_cadence_open_on_tick: None,
            bunny_hop_cadence_initialized: false,
            pending_bunny_hop_direction: None,
            step_end_direction_intent: None,
            walk_inputs: VecDeque::new(),
            outbound,
        }
    }

    pub fn update_authoritative_tick(&mut self, tick: u64) {
        self.authoritative_tick = tick;
        if matches!(
            self.player_state.bike_runtime.acro_state,
            AcroBikeSubstate::BunnyHop
        ) {
            if self
                .player_state
                .bike_runtime
                .acro_runtime
                .hop_landed_this_tick()
            {
                self.bunny_hop_cadence_open_on_tick = Some(tick);
                self.bunny_hop_cadence_initialized = true;
            }
        } else {
            self.bunny_hop_cadence_open_on_tick = None;
            self.bunny_hop_cadence_initialized = false;
            self.pending_bunny_hop_direction = None;
        }
    }

    pub fn enqueue_walk_input(&mut self, input: WalkInput) {
        self.walk_inputs.push_back(input);
    }

    pub fn apply_held_input_state(&mut self, input: HeldInputState) {
        self.held_dpad = crate::protocol::sanitize_held_dpad_mask(input.held_dpad);
        self.resolved_held_direction =
            crate::protocol::resolve_direction_from_held_dpad(self.held_dpad);
        self.set_held_buttons(input.held_buttons);
    }

    pub fn press_buttons(&mut self, buttons: u8) {
        self.held_buttons |= buttons;
    }

    pub fn release_buttons(&mut self, buttons: u8) {
        self.held_buttons &= !buttons;
    }

    pub fn effective_held_direction(&self) -> Option<Direction> {
        self.resolved_held_direction
    }

    pub fn set_held_buttons(&mut self, new_buttons: u8) {
        let pressed = new_buttons & !self.held_buttons;
        let released = self.held_buttons & !new_buttons;
        if pressed != 0 {
            self.press_buttons(pressed);
        }
        if released != 0 {
            self.release_buttons(released);
        }
    }

    pub fn capture_step_end_direction_intent(&mut self) {
        self.step_end_direction_intent = self.effective_held_direction();
    }

    pub fn consume_step_end_direction_intent(&mut self) -> Option<Direction> {
        self.step_end_direction_intent.take()
    }

    pub fn validate_and_commit_walk_intent_timing(
        &mut self,
        input: &WalkInput,
    ) -> WalkIntentTimingValidation {
        let is_bunny_hop = matches!(
            self.player_state.bike_runtime.acro_state,
            AcroBikeSubstate::BunnyHop
        );
        if !is_bunny_hop && self.effective_held_direction() != Some(input.direction) {
            return WalkIntentTimingValidation::HeldDirectionMismatch;
        }

        if !is_bunny_hop {
            return WalkIntentTimingValidation::Accepted;
        }

        if let Some(held_direction) = self.effective_held_direction() {
            if held_direction != input.direction {
                return WalkIntentTimingValidation::HeldDirectionMismatch;
            }
        }

        if self.is_bunny_hop_cadence_open_this_tick() {
            self.bunny_hop_cadence_open_on_tick = None;
            self.bunny_hop_cadence_initialized = true;
            self.pending_bunny_hop_direction = None;
            return WalkIntentTimingValidation::Accepted;
        }

        if !self.bunny_hop_cadence_initialized {
            self.bunny_hop_cadence_initialized = true;
            self.pending_bunny_hop_direction = None;
            return WalkIntentTimingValidation::Accepted;
        }
        self.pending_bunny_hop_direction = Some(input.direction);
        WalkIntentTimingValidation::Accepted
    }

    pub fn is_bunny_hop_cadence_open_this_tick(&self) -> bool {
        self.bunny_hop_cadence_open_on_tick == Some(self.authoritative_tick)
    }

    pub fn has_pending_bunny_hop_direction(&self) -> bool {
        self.pending_bunny_hop_direction.is_some()
    }

    pub fn bunny_hop_cadence_initialized(&self) -> bool {
        self.bunny_hop_cadence_initialized
    }

    pub fn requeue_walk_input_front(&mut self, input: WalkInput) {
        self.walk_inputs.push_front(input);
    }

    pub fn walk_inputs_len(&self) -> usize {
        self.walk_inputs.len()
    }

    pub fn drop_oldest_walk_input(&mut self) -> Option<WalkInput> {
        self.walk_inputs.pop_front()
    }

    pub fn pop_walk_input(&mut self) -> Option<WalkInput> {
        self.walk_inputs.pop_front()
    }

    pub fn avatar_action_lock_active(&self) -> bool {
        self.avatar_action_lock
            .as_ref()
            .is_some_and(|lock| lock.remaining_ticks > 0)
    }

    pub fn begin_avatar_action_lock(&mut self, lock_type: AvatarActionLockType, ticks: u8) {
        if ticks == 0 {
            self.avatar_action_lock = None;
            return;
        }
        self.avatar_action_lock = Some(AvatarActionLock {
            lock_type,
            remaining_ticks: ticks,
        });
    }

    pub fn advance_avatar_action_lock_tick(&mut self) {
        let Some(lock) = self.avatar_action_lock.as_mut() else {
            return;
        };
        if lock.remaining_ticks > 0 {
            lock.remaining_ticks -= 1;
        }
        if lock.remaining_ticks == 0 {
            self.avatar_action_lock = None;
        }
    }

    pub fn send(
        &self,
        message: ServerMessage,
    ) -> Result<(), mpsc::error::SendError<ServerMessage>> {
        self.outbound.send(message)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AvatarActionLockType {
    BikeTransition(BikeTransitionType),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AvatarActionLock {
    pub lock_type: AvatarActionLockType,
    pub remaining_ticks: u8,
}

#[derive(Debug)]
pub struct SessionInit {
    pub connection_id: u64,
    pub player_id: String,
    pub player_state: PlayerState,
    outbound: mpsc::UnboundedSender<ServerMessage>,
}

impl SessionInit {
    pub fn send(
        &self,
        message: ServerMessage,
    ) -> Result<(), mpsc::error::SendError<ServerMessage>> {
        self.outbound.send(message)
    }
}

impl From<&Session> for SessionInit {
    fn from(value: &Session) -> Self {
        Self {
            connection_id: value.connection_id,
            player_id: value.player_id.clone(),
            player_state: value.player_state.clone(),
            outbound: value.outbound.clone(),
        }
    }
}

#[cfg(test)]
mod tests {
    use tokio::sync::mpsc;

    use super::*;

    fn test_session() -> Session {
        let (tx, _rx) = mpsc::unbounded_channel();
        Session::new(
            1,
            "player-1".to_string(),
            PlayerState {
                map_id: "MAP_LITTLEROOT_TOWN".to_string(),
                tile_x: 1,
                tile_y: 1,
                facing: Direction::Down,
                avatar: PlayerAvatar::Brendan,
                traversal_state: TraversalState::OnFoot,
                preferred_bike_type: TraversalState::MachBike,
                bike_runtime: BikeRuntimeState::default(),
                cracked_floor: CrackedFloorRuntimeState::default(),
            },
            tx,
        )
    }

    fn walk_input(direction: Direction, client_time: u64) -> WalkInput {
        WalkInput {
            direction,
            movement_mode: MovementMode::Walk,
            held_buttons: 0,
            input_seq: 0,
            client_time,
        }
    }

    #[test]
    fn walk_intent_timing_bunny_hop_accepts_only_on_cadence_boundaries() {
        let mut session = test_session();
        session.player_state.traversal_state = TraversalState::AcroBike;
        session.player_state.bike_runtime.acro_state = AcroBikeSubstate::BunnyHop;
        session.player_state.bike_runtime.acro_runtime.state = crate::acro::AcroState::BunnyHop;
        session.apply_held_input_state(HeldInputState {
            held_dpad: crate::protocol::HeldDpad::Right as u8,
            held_buttons: 0,
            input_seq: 0,
            client_time: 1_000,
        });

        for tick in 1..=16 {
            session
                .player_state
                .bike_runtime
                .acro_runtime
                .set_held_input(Some(Direction::Right), true);
            session
                .player_state
                .bike_runtime
                .acro_runtime
                .advance_tick();
            session.update_authoritative_tick(tick);
        }
        assert_eq!(
            session.validate_and_commit_walk_intent_timing(&walk_input(Direction::Right, 1_010)),
            WalkIntentTimingValidation::Accepted
        );

        session
            .player_state
            .bike_runtime
            .acro_runtime
            .set_held_input(Some(Direction::Right), true);
        session
            .player_state
            .bike_runtime
            .acro_runtime
            .advance_tick();
        session.update_authoritative_tick(17);
        assert_eq!(
            session.validate_and_commit_walk_intent_timing(&walk_input(Direction::Right, 1_050)),
            WalkIntentTimingValidation::Accepted
        );
        assert!(session.has_pending_bunny_hop_direction());

        for tick in 18..=32 {
            session
                .player_state
                .bike_runtime
                .acro_runtime
                .set_held_input(Some(Direction::Right), true);
            session
                .player_state
                .bike_runtime
                .acro_runtime
                .advance_tick();
            session.update_authoritative_tick(tick);
        }
        assert_eq!(
            session.validate_and_commit_walk_intent_timing(&walk_input(Direction::Right, 1_080)),
            WalkIntentTimingValidation::Accepted
        );
    }

    #[test]
    fn walk_intent_timing_requires_matching_held_direction() {
        let mut session = test_session();
        session.apply_held_input_state(HeldInputState {
            held_dpad: crate::protocol::HeldDpad::Up as u8,
            held_buttons: 0,
            input_seq: 0,
            client_time: 5_000,
        });

        assert_eq!(
            session.validate_and_commit_walk_intent_timing(&walk_input(Direction::Left, 5_200)),
            WalkIntentTimingValidation::HeldDirectionMismatch
        );

        session.apply_held_input_state(HeldInputState {
            held_dpad: 0,
            held_buttons: 0,
            input_seq: 1,
            client_time: 5_250,
        });
        assert_eq!(
            session.validate_and_commit_walk_intent_timing(&walk_input(Direction::Up, 5_400)),
            WalkIntentTimingValidation::HeldDirectionMismatch
        );
    }

    #[test]
    fn walk_intent_timing_bunny_hop_accepts_before_held_direction_arrives() {
        let mut session = test_session();
        session.player_state.traversal_state = TraversalState::AcroBike;
        session.player_state.bike_runtime.acro_state = AcroBikeSubstate::BunnyHop;
        session.player_state.bike_runtime.acro_runtime.state = crate::acro::AcroState::BunnyHop;

        assert_eq!(
            session.validate_and_commit_walk_intent_timing(&walk_input(Direction::Right, 0)),
            WalkIntentTimingValidation::Accepted
        );
    }

    #[test]
    fn walk_intent_timing_bunny_hop_rejects_when_held_direction_mismatches() {
        let mut session = test_session();
        session.player_state.traversal_state = TraversalState::AcroBike;
        session.player_state.bike_runtime.acro_state = AcroBikeSubstate::BunnyHop;
        session.player_state.bike_runtime.acro_runtime.state = crate::acro::AcroState::BunnyHop;
        session.apply_held_input_state(HeldInputState {
            held_dpad: crate::protocol::HeldDpad::Down as u8,
            held_buttons: crate::protocol::HeldButtons::B as u8,
            input_seq: 0,
            client_time: 0,
        });

        assert_eq!(
            session.validate_and_commit_walk_intent_timing(&walk_input(Direction::Right, 1)),
            WalkIntentTimingValidation::HeldDirectionMismatch
        );
    }

    #[test]
    fn effective_held_direction_cancels_conflicting_opposites() {
        let mut session = test_session();

        session.apply_held_input_state(HeldInputState {
            held_dpad: (crate::protocol::HeldDpad::Up as u8)
                | (crate::protocol::HeldDpad::Right as u8),
            held_buttons: 0,
            input_seq: 0,
            client_time: 0,
        });
        assert_eq!(session.effective_held_direction(), Some(Direction::Up));

        session.apply_held_input_state(HeldInputState {
            held_dpad: (crate::protocol::HeldDpad::Left as u8)
                | (crate::protocol::HeldDpad::Right as u8),
            held_buttons: 0,
            input_seq: 1,
            client_time: 0,
        });
        assert_eq!(session.effective_held_direction(), None);

        session.apply_held_input_state(HeldInputState {
            held_dpad: (crate::protocol::HeldDpad::Up as u8)
                | (crate::protocol::HeldDpad::Down as u8),
            held_buttons: 0,
            input_seq: 2,
            client_time: 0,
        });
        assert_eq!(session.effective_held_direction(), None);

        session.apply_held_input_state(HeldInputState {
            held_dpad: (crate::protocol::HeldDpad::Down as u8)
                | (crate::protocol::HeldDpad::Left as u8),
            held_buttons: 0,
            input_seq: 3,
            client_time: 0,
        });
        assert_eq!(session.effective_held_direction(), Some(Direction::Down));
    }

    #[test]
    fn effective_held_direction_falls_back_after_release() {
        let mut session = test_session();

        session.apply_held_input_state(HeldInputState {
            held_dpad: (crate::protocol::HeldDpad::Up as u8)
                | (crate::protocol::HeldDpad::Down as u8)
                | (crate::protocol::HeldDpad::Left as u8),
            held_buttons: 0,
            input_seq: 0,
            client_time: 0,
        });
        assert_eq!(session.effective_held_direction(), Some(Direction::Left));

        session.apply_held_input_state(HeldInputState {
            held_dpad: (crate::protocol::HeldDpad::Down as u8)
                | (crate::protocol::HeldDpad::Left as u8),
            held_buttons: 0,
            input_seq: 1,
            client_time: 0,
        });
        assert_eq!(session.effective_held_direction(), Some(Direction::Down));

        session.apply_held_input_state(HeldInputState {
            held_dpad: crate::protocol::HeldDpad::Left as u8,
            held_buttons: 0,
            input_seq: 2,
            client_time: 0,
        });
        assert_eq!(session.effective_held_direction(), Some(Direction::Left));

        session.apply_held_input_state(HeldInputState {
            held_dpad: 0,
            held_buttons: 0,
            input_seq: 3,
            client_time: 0,
        });
        assert_eq!(session.effective_held_direction(), None);
    }
}

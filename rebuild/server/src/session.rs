use std::collections::VecDeque;

use tokio::sync::mpsc;

use crate::{
    movement::{movement_mode_step_speed, step_progress_pixels, StepSpeed, WALK_SAMPLE_MS},
    protocol::{Direction, MovementMode, PlayerAvatar, ServerMessage, WalkInput},
};

pub const MAX_PENDING_WALK_INPUTS: usize = 2;

#[derive(Debug, Clone)]
pub struct PlayerState {
    pub map_id: String,
    pub tile_x: u16,
    pub tile_y: u16,
    pub facing: Direction,
    pub avatar: PlayerAvatar,
    pub is_on_bike: bool,
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
    ) -> Self {
        let speed = movement_mode_step_speed(movement_mode);
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
    pub active_walk_transition: Option<ActiveWalkTransition>,
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
            active_walk_transition: None,
            walk_inputs: VecDeque::new(),
            outbound,
        }
    }

    pub fn enqueue_walk_input(&mut self, input: WalkInput) {
        self.walk_inputs.push_back(input);
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

    pub fn send(
        &self,
        message: ServerMessage,
    ) -> Result<(), mpsc::error::SendError<ServerMessage>> {
        self.outbound.send(message)
    }
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

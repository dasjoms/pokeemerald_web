use std::collections::VecDeque;

use tokio::sync::mpsc;

use crate::protocol::{Direction, ServerMessage, WalkInput};

#[derive(Debug, Clone)]
pub struct PlayerState {
    pub tile_x: u16,
    pub tile_y: u16,
    pub facing: Direction,
}

#[derive(Debug)]
pub struct Session {
    pub connection_id: u64,
    pub player_id: String,
    pub player_state: PlayerState,
    pub joined: bool,
    pub next_expected_input_seq: u32,
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
            walk_inputs: VecDeque::new(),
            outbound,
        }
    }

    pub fn enqueue_walk_input(&mut self, input: WalkInput) {
        self.walk_inputs.push_back(input);
    }

    pub fn take_ready_walk_inputs(&mut self) -> VecDeque<WalkInput> {
        std::mem::take(&mut self.walk_inputs)
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

use crate::protocol::Direction;

const INPUT_HISTORY_LEN: usize = 8;
const TIMER_END: u8 = 0;
const ACRO_JUMP_TIMER_LIST: [u8; 2] = [4, TIMER_END];
const JUMP_INTENT_TTL_TICKS: u8 = 2;
const BUNNY_HOP_CYCLE_TICKS: u8 = 16;

const ABSS_A: u8 = 1 << 0;
const ABSS_B: u8 = 1 << 1;
const ABSS_SELECT: u8 = 1 << 2;
const ABSS_START: u8 = 1 << 3;
const ABSS_MASK: u8 = ABSS_A | ABSS_B | ABSS_SELECT | ABSS_START;

#[repr(u8)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AcroState {
    Normal = 0,
    Turning = 1,
    WheelieStanding = 2,
    BunnyHop = 3,
    WheelieMoving = 4,
    SideJump = 5,
    TurnJump = 6,
}

#[repr(u8)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RunningState {
    NotMoving = 0,
    TurnDirection = 1,
    Moving = 2,
}

#[repr(u8)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AcroAnimationAction {
    None = 0,
    FaceDirection = 1,
    TurnDirection = 2,
    Moving = 3,
    NormalToWheelie = 4,
    WheelieToNormal = 5,
    WheelieIdle = 6,
    WheelieHoppingStanding = 7,
    WheelieHoppingMoving = 8,
    SideJump = 9,
    TurnJump = 10,
    WheelieMoving = 11,
    WheelieRisingMoving = 12,
    WheelieLoweringMoving = 13,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct BikeHistoryInputInfo {
    dir_history_match: u32,
    ab_start_select_history_match: u32,
    dir_history_mask: u32,
    ab_start_select_history_mask: u32,
    dir_timer_history_list: &'static [u8],
    ab_start_select_timer_history_list: &'static [u8],
    direction: Direction,
}

const ACRO_TRICKS_LIST: [BikeHistoryInputInfo; 4] = [
    BikeHistoryInputInfo {
        dir_history_match: 2,
        ab_start_select_history_match: ABSS_B as u32,
        dir_history_mask: 0xF,
        ab_start_select_history_mask: 0xF,
        dir_timer_history_list: &ACRO_JUMP_TIMER_LIST,
        ab_start_select_timer_history_list: &ACRO_JUMP_TIMER_LIST,
        direction: Direction::Down,
    },
    BikeHistoryInputInfo {
        dir_history_match: 1,
        ab_start_select_history_match: ABSS_B as u32,
        dir_history_mask: 0xF,
        ab_start_select_history_mask: 0xF,
        dir_timer_history_list: &ACRO_JUMP_TIMER_LIST,
        ab_start_select_timer_history_list: &ACRO_JUMP_TIMER_LIST,
        direction: Direction::Up,
    },
    BikeHistoryInputInfo {
        dir_history_match: 3,
        ab_start_select_history_match: ABSS_B as u32,
        dir_history_mask: 0xF,
        ab_start_select_history_mask: 0xF,
        dir_timer_history_list: &ACRO_JUMP_TIMER_LIST,
        ab_start_select_timer_history_list: &ACRO_JUMP_TIMER_LIST,
        direction: Direction::Right,
    },
    BikeHistoryInputInfo {
        dir_history_match: 4,
        ab_start_select_history_match: ABSS_B as u32,
        dir_history_mask: 0xF,
        ab_start_select_history_mask: 0xF,
        dir_timer_history_list: &ACRO_JUMP_TIMER_LIST,
        ab_start_select_timer_history_list: &ACRO_JUMP_TIMER_LIST,
        direction: Direction::Left,
    },
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AcroRuntime {
    pub state: AcroState,
    pub running_state: RunningState,
    pub direction_history: u32,
    pub ab_start_select_history: u32,
    pub dir_timer_history: [u8; INPUT_HISTORY_LEN],
    pub ab_start_select_timer_history: [u8; INPUT_HISTORY_LEN],
    pub bike_frame_counter: u8,
    pub held_direction: Option<Direction>,
    pub holding_b: bool,
    pub new_dir_backup: Option<Direction>,
    pub movement_direction: Direction,
    pub on_bumpy_slope: bool,
    bunny_hop_cycle_tick: u8,
    hop_landed_this_tick: bool,
    pending_action: Option<AcroAnimationAction>,
    pending_jump_intent: Option<PendingJumpIntent>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct PendingJumpIntent {
    direction: Direction,
    expires_in_ticks: u8,
}

impl Default for AcroRuntime {
    fn default() -> Self {
        Self {
            state: AcroState::Normal,
            running_state: RunningState::NotMoving,
            direction_history: 0,
            ab_start_select_history: 0,
            dir_timer_history: [0; INPUT_HISTORY_LEN],
            ab_start_select_timer_history: [0; INPUT_HISTORY_LEN],
            bike_frame_counter: 0,
            held_direction: None,
            holding_b: false,
            new_dir_backup: None,
            movement_direction: Direction::Down,
            on_bumpy_slope: false,
            bunny_hop_cycle_tick: 0,
            hop_landed_this_tick: false,
            pending_action: None,
            pending_jump_intent: None,
        }
    }
}

impl AcroRuntime {
    pub fn handle_bumpy_slope_mount_transition(
        &mut self,
        facing_direction: Direction,
    ) -> AcroAnimationAction {
        self.on_bumpy_slope = true;
        self.state = AcroState::WheelieStanding;
        self.running_state = RunningState::NotMoving;
        self.bike_frame_counter = 0;
        self.movement_direction = facing_direction;
        self.pending_action = None;
        AcroAnimationAction::WheelieIdle
    }

    pub fn set_held_input(&mut self, held_direction: Option<Direction>, holding_b: bool) {
        self.held_direction = held_direction;
        self.holding_b = holding_b;
    }

    pub fn set_on_bumpy_slope(&mut self, on_bumpy_slope: bool) {
        self.on_bumpy_slope = on_bumpy_slope;
    }

    pub fn advance_tick(&mut self) {
        self.hop_landed_this_tick = false;
        self.age_pending_jump_intent();
        self.update_history(self.held_direction, if self.holding_b { ABSS_B } else { 0 });
        self.refresh_pending_jump_intent();
        // Tick the bunny-hop phase before input handling so state transitions can
        // deterministically observe whether this evaluation is at a landing boundary.
        self.advance_bunny_hop_phase();
        self.pending_action = Some(self.handle_input(self.held_direction, self.movement_direction));
    }

    pub fn take_pending_action(&mut self) -> Option<AcroAnimationAction> {
        self.pending_action.take()
    }

    pub fn pending_action(&self) -> Option<AcroAnimationAction> {
        self.pending_action
    }

    pub fn update_history(&mut self, held_direction: Option<Direction>, held_ab_start_select: u8) {
        let direction = encode_direction_nibble(held_direction);
        if direction == (self.direction_history as u8 & 0xF) {
            if self.dir_timer_history[0] < u8::MAX {
                self.dir_timer_history[0] = self.dir_timer_history[0].saturating_add(1);
            }
        } else {
            update_dir_timer_history(
                direction,
                &mut self.direction_history,
                &mut self.dir_timer_history,
            );
        }

        let abss = held_ab_start_select & ABSS_MASK;
        if abss == (self.ab_start_select_history as u8 & 0xF) {
            if self.ab_start_select_timer_history[0] < u8::MAX {
                self.ab_start_select_timer_history[0] =
                    self.ab_start_select_timer_history[0].saturating_add(1);
            }
        } else {
            update_button_timer_history(
                abss,
                &mut self.ab_start_select_history,
                &mut self.ab_start_select_timer_history,
            );
        }
    }

    pub fn get_jump_direction(&self) -> Option<Direction> {
        for history in ACRO_TRICKS_LIST {
            let dir_history = self.direction_history & history.dir_history_mask;
            let abss_history = self.ab_start_select_history & history.ab_start_select_history_mask;
            if dir_history == history.dir_history_match
                && abss_history == history.ab_start_select_history_match
                && has_input_not_taken_longer_than_list(
                    &self.dir_timer_history,
                    &self.ab_start_select_timer_history,
                    history.dir_timer_history_list,
                    history.ab_start_select_timer_history_list,
                )
            {
                return Some(history.direction);
            }
        }

        None
    }

    pub fn apply_step(
        &mut self,
        facing_direction: Direction,
        requested_direction: Direction,
    ) -> AcroAnimationAction {
        if self.held_direction == Some(requested_direction) {
            if let Some(action) = self.pending_action.take() {
                self.movement_direction = requested_direction;
                return action;
            }
        }

        self.hop_landed_this_tick = false;
        // Keep phase progression and input evaluation ordering consistent with
        // advance_tick so bunny-hop landing gating behaves identically.
        self.advance_bunny_hop_phase();
        let action = self.handle_input(Some(requested_direction), facing_direction);
        self.movement_direction = requested_direction;
        action
    }

    pub fn hop_landed_this_tick(&self) -> bool {
        self.hop_landed_this_tick
    }

    pub fn bunny_hop_cycle_tick(&self) -> u8 {
        self.bunny_hop_cycle_tick
    }

    pub fn handle_wheelie_collision_response(&mut self) -> Option<AcroAnimationAction> {
        if !self.on_bumpy_slope {
            return None;
        }

        if matches!(self.state, AcroState::WheelieMoving) {
            self.state = AcroState::WheelieStanding;
            self.running_state = RunningState::NotMoving;
            self.bike_frame_counter = 0;
            return Some(AcroAnimationAction::WheelieIdle);
        }

        None
    }

    fn handle_input(
        &mut self,
        requested_direction: Option<Direction>,
        facing_direction: Direction,
    ) -> AcroAnimationAction {
        match self.state {
            AcroState::Normal => self.handle_input_normal(requested_direction, facing_direction),
            AcroState::Turning => self.handle_input_turning(facing_direction),
            AcroState::WheelieStanding => {
                self.handle_input_wheelie_standing(requested_direction, facing_direction)
            }
            AcroState::BunnyHop => {
                self.handle_input_bunny_hop(requested_direction, facing_direction)
            }
            AcroState::WheelieMoving => {
                self.handle_input_wheelie_moving(requested_direction, facing_direction)
            }
            AcroState::SideJump => {
                self.handle_input_sideways_jump(requested_direction, facing_direction)
            }
            AcroState::TurnJump => {
                self.handle_input_turn_jump(requested_direction, facing_direction)
            }
        }
    }

    fn handle_input_normal(
        &mut self,
        requested_direction: Option<Direction>,
        facing_direction: Direction,
    ) -> AcroAnimationAction {
        self.bike_frame_counter = 0;

        let Some(new_direction) = requested_direction else {
            if self.holding_b {
                self.running_state = RunningState::NotMoving;
                self.state = AcroState::WheelieStanding;
                self.bike_frame_counter = 0;
                return AcroAnimationAction::NormalToWheelie;
            }
            self.running_state = RunningState::NotMoving;
            return AcroAnimationAction::FaceDirection;
        };

        if new_direction == facing_direction && self.holding_b {
            self.state = AcroState::WheelieMoving;
            self.running_state = RunningState::Moving;
            return AcroAnimationAction::WheelieRisingMoving;
        }

        if new_direction != facing_direction && self.running_state != RunningState::Moving {
            self.state = AcroState::Turning;
            self.new_dir_backup = Some(new_direction);
            self.running_state = RunningState::NotMoving;
            return self.handle_input_turning(facing_direction);
        }

        self.running_state = RunningState::Moving;
        AcroAnimationAction::Moving
    }

    fn handle_input_turning(&mut self, facing_direction: Direction) -> AcroAnimationAction {
        let new_direction = self.new_dir_backup.unwrap_or(facing_direction);
        self.bike_frame_counter = self.bike_frame_counter.saturating_add(1);

        if self.bike_frame_counter > 6 {
            self.running_state = RunningState::TurnDirection;
            self.state = AcroState::Normal;
            self.bike_frame_counter = 0;
            self.movement_direction = new_direction;
            return AcroAnimationAction::TurnDirection;
        }

        if self.consume_jump_intent_for(new_direction)
            || Some(new_direction) == self.get_jump_direction()
        {
            self.pending_jump_intent = None;
            if new_direction == opposite_direction(facing_direction) {
                self.state = AcroState::TurnJump;
                return AcroAnimationAction::TurnJump;
            }
            self.running_state = RunningState::Moving;
            self.state = AcroState::SideJump;
            return AcroAnimationAction::SideJump;
        }

        AcroAnimationAction::FaceDirection
    }

    fn age_pending_jump_intent(&mut self) {
        let Some(mut intent) = self.pending_jump_intent else {
            return;
        };

        if intent.expires_in_ticks <= 1 {
            self.pending_jump_intent = None;
            return;
        }

        intent.expires_in_ticks -= 1;
        self.pending_jump_intent = Some(intent);
    }

    fn refresh_pending_jump_intent(&mut self) {
        if let Some(direction) = self.get_jump_direction() {
            self.pending_jump_intent = Some(PendingJumpIntent {
                direction,
                expires_in_ticks: JUMP_INTENT_TTL_TICKS,
            });
        }
    }

    fn consume_jump_intent_for(&mut self, direction: Direction) -> bool {
        matches!(
            self.pending_jump_intent,
            Some(PendingJumpIntent {
                direction: candidate,
                ..
            }) if candidate == direction
        )
        .then(|| self.pending_jump_intent.take())
        .is_some()
    }

    fn handle_input_wheelie_standing(
        &mut self,
        requested_direction: Option<Direction>,
        facing_direction: Direction,
    ) -> AcroAnimationAction {
        self.running_state = RunningState::NotMoving;

        if self.holding_b {
            self.bike_frame_counter = self.bike_frame_counter.saturating_add(1);
        } else {
            self.bike_frame_counter = 0;
            if !self.on_bumpy_slope {
                self.state = AcroState::Normal;
                return AcroAnimationAction::WheelieToNormal;
            }
        }

        if self.bike_frame_counter >= 40 {
            self.state = AcroState::BunnyHop;
            return AcroAnimationAction::WheelieHoppingStanding;
        }

        if requested_direction == Some(facing_direction) {
            self.running_state = RunningState::Moving;
            self.state = AcroState::WheelieMoving;
            return AcroAnimationAction::WheelieMoving;
        }

        if requested_direction.is_none() {
            return AcroAnimationAction::WheelieIdle;
        }

        self.running_state = RunningState::TurnDirection;
        AcroAnimationAction::WheelieIdle
    }

    fn handle_input_bunny_hop(
        &mut self,
        requested_direction: Option<Direction>,
        facing_direction: Direction,
    ) -> AcroAnimationAction {
        if !self.holding_b {
            self.bike_frame_counter = 0;
            self.running_state = RunningState::NotMoving;
            if self.on_bumpy_slope {
                self.state = AcroState::WheelieStanding;
                return self.handle_input_wheelie_standing(requested_direction, facing_direction);
            }

            self.state = AcroState::Normal;
            return AcroAnimationAction::WheelieToNormal;
        }

        self.bunny_hop_action_for_input(requested_direction, facing_direction)
    }

    fn bunny_hop_action_for_input(
        &mut self,
        requested_direction: Option<Direction>,
        facing_direction: Direction,
    ) -> AcroAnimationAction {
        let Some(new_direction) = requested_direction else {
            self.running_state = RunningState::NotMoving;
            return AcroAnimationAction::WheelieHoppingStanding;
        };

        if new_direction != facing_direction && self.running_state != RunningState::Moving {
            self.running_state = RunningState::TurnDirection;
            return AcroAnimationAction::WheelieHoppingStanding;
        }

        self.running_state = RunningState::Moving;
        AcroAnimationAction::WheelieHoppingMoving
    }

    fn handle_input_wheelie_moving(
        &mut self,
        requested_direction: Option<Direction>,
        facing_direction: Direction,
    ) -> AcroAnimationAction {
        if !self.holding_b {
            if self.on_bumpy_slope {
                self.state = AcroState::WheelieStanding;
                return self.handle_input_wheelie_standing(requested_direction, facing_direction);
            }

            self.state = AcroState::Normal;
            if requested_direction.is_none() {
                self.running_state = RunningState::NotMoving;
                return AcroAnimationAction::WheelieToNormal;
            }
            if requested_direction != Some(facing_direction)
                && self.running_state != RunningState::Moving
            {
                self.running_state = RunningState::NotMoving;
                return AcroAnimationAction::WheelieToNormal;
            }
            self.running_state = RunningState::Moving;
            return AcroAnimationAction::WheelieLoweringMoving;
        }

        let Some(new_direction) = requested_direction else {
            self.state = AcroState::WheelieStanding;
            self.running_state = RunningState::NotMoving;
            self.bike_frame_counter = 0;
            return AcroAnimationAction::WheelieIdle;
        };

        if new_direction != facing_direction && self.running_state != RunningState::Moving {
            self.running_state = RunningState::NotMoving;
            return AcroAnimationAction::WheelieIdle;
        }

        self.running_state = RunningState::Moving;
        AcroAnimationAction::WheelieMoving
    }

    fn handle_input_sideways_jump(
        &mut self,
        requested_direction: Option<Direction>,
        facing_direction: Direction,
    ) -> AcroAnimationAction {
        self.state = AcroState::Normal;
        self.handle_input(requested_direction, facing_direction)
    }

    fn handle_input_turn_jump(
        &mut self,
        requested_direction: Option<Direction>,
        facing_direction: Direction,
    ) -> AcroAnimationAction {
        self.state = AcroState::Normal;
        self.handle_input(requested_direction, facing_direction)
    }

    fn advance_bunny_hop_phase(&mut self) {
        if !matches!(self.state, AcroState::BunnyHop) {
            self.bunny_hop_cycle_tick = 0;
            return;
        }

        self.bunny_hop_cycle_tick = self.bunny_hop_cycle_tick.saturating_add(1);
        if self.bunny_hop_cycle_tick >= BUNNY_HOP_CYCLE_TICKS {
            self.bunny_hop_cycle_tick = 0;
            self.hop_landed_this_tick = true;
        }
    }
}

pub fn holding_b_mask() -> u8 {
    ABSS_B
}

fn has_input_not_taken_longer_than_list(
    dir_timers: &[u8; INPUT_HISTORY_LEN],
    abss_timers: &[u8; INPUT_HISTORY_LEN],
    dir_timer_list: &[u8],
    abss_timer_list: &[u8],
) -> bool {
    for (index, limit) in dir_timer_list.iter().copied().enumerate() {
        if limit == TIMER_END {
            break;
        }

        if dir_timers[index] > limit {
            return false;
        }
    }

    for (index, limit) in abss_timer_list.iter().copied().enumerate() {
        if limit == TIMER_END {
            break;
        }

        if abss_timers[index] > limit {
            return false;
        }
    }

    true
}

fn update_dir_timer_history(
    direction: u8,
    direction_history: &mut u32,
    timers: &mut [u8; INPUT_HISTORY_LEN],
) {
    *direction_history = (*direction_history << 4) | u32::from(direction & 0xF);
    shift_timers(timers);
}

fn update_button_timer_history(input: u8, history: &mut u32, timers: &mut [u8; INPUT_HISTORY_LEN]) {
    *history = (*history << 4) | u32::from(input & 0xF);
    shift_timers(timers);
}

fn shift_timers(timers: &mut [u8; INPUT_HISTORY_LEN]) {
    for i in (1..timers.len()).rev() {
        timers[i] = timers[i - 1];
    }
    timers[0] = 1;
}

fn encode_direction_nibble(direction: Option<Direction>) -> u8 {
    match direction {
        Some(Direction::Down) => 2,
        Some(Direction::Up) => 1,
        Some(Direction::Left) => 4,
        Some(Direction::Right) => 3,
        None => 0,
    }
}

fn opposite_direction(direction: Direction) -> Direction {
    match direction {
        Direction::Up => Direction::Down,
        Direction::Down => Direction::Up,
        Direction::Left => Direction::Right,
        Direction::Right => Direction::Left,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seed_jump_window(runtime: &mut AcroRuntime, direction: Direction, direction_frames: usize) {
        runtime.update_history(Some(direction), 0);
        for _ in 0..direction_frames {
            runtime.update_history(Some(direction), 0);
        }
        runtime.update_history(Some(direction), holding_b_mask());
        runtime.state = AcroState::Turning;
        runtime.new_dir_backup = Some(direction);
        runtime.set_held_input(Some(direction), true);
    }

    #[test]
    fn jump_direction_detects_when_exactly_within_4_frame_window() {
        let mut runtime = AcroRuntime::default();
        runtime.update_history(Some(Direction::Right), 0);
        for _ in 0..2 {
            runtime.update_history(Some(Direction::Right), 0);
        }
        runtime.update_history(Some(Direction::Right), holding_b_mask());
        assert_eq!(runtime.get_jump_direction(), Some(Direction::Right));
    }

    #[test]
    fn jump_direction_rejects_when_exceeding_4_frame_window() {
        let mut runtime = AcroRuntime::default();
        runtime.update_history(Some(Direction::Left), 0);
        for _ in 0..4 {
            runtime.update_history(Some(Direction::Left), 0);
        }
        runtime.update_history(Some(Direction::Left), holding_b_mask());
        assert_eq!(runtime.get_jump_direction(), None);
    }

    #[test]
    fn normal_handler_enters_wheelie_and_faces_when_idle() {
        let mut runtime = AcroRuntime::default();
        runtime.set_held_input(None, true);
        runtime.advance_tick();
        assert_eq!(runtime.state, AcroState::WheelieStanding);
        assert_eq!(runtime.bike_frame_counter, 0);
        assert_eq!(
            runtime.take_pending_action(),
            Some(AcroAnimationAction::NormalToWheelie)
        );

        runtime.set_held_input(None, false);
        runtime.state = AcroState::Normal;
        runtime.advance_tick();
        assert_eq!(
            runtime.take_pending_action(),
            Some(AcroAnimationAction::FaceDirection)
        );
    }

    #[test]
    fn standing_wheelie_requires_40_full_ticks_before_bunny_hop() {
        let mut runtime = AcroRuntime::default();
        runtime.set_held_input(None, true);
        runtime.advance_tick();
        assert_eq!(runtime.state, AcroState::WheelieStanding);
        assert_eq!(runtime.bike_frame_counter, 0);
        assert_eq!(
            runtime.take_pending_action(),
            Some(AcroAnimationAction::NormalToWheelie)
        );

        for _ in 0..39 {
            runtime.set_held_input(None, true);
            runtime.advance_tick();
            assert_eq!(runtime.state, AcroState::WheelieStanding);
            assert_eq!(
                runtime.take_pending_action(),
                Some(AcroAnimationAction::WheelieIdle)
            );
        }

        assert_eq!(runtime.bike_frame_counter, 39);
        runtime.set_held_input(None, true);
        runtime.advance_tick();
        assert_eq!(runtime.state, AcroState::BunnyHop);
        assert_eq!(runtime.bike_frame_counter, 40);
        assert_eq!(
            runtime.take_pending_action(),
            Some(AcroAnimationAction::WheelieHoppingStanding)
        );
    }

    #[test]
    fn turning_handler_waits_6_frames_then_turns() {
        let mut runtime = AcroRuntime {
            state: AcroState::Turning,
            new_dir_backup: Some(Direction::Left),
            ..Default::default()
        };

        for _ in 0..6 {
            assert_eq!(
                runtime.apply_step(Direction::Up, Direction::Left),
                AcroAnimationAction::FaceDirection
            );
            assert_eq!(runtime.state, AcroState::Turning);
        }

        assert_eq!(
            runtime.apply_step(Direction::Up, Direction::Left),
            AcroAnimationAction::TurnDirection
        );
        assert_eq!(runtime.state, AcroState::Normal);
        assert_eq!(runtime.running_state, RunningState::TurnDirection);
    }

    #[test]
    fn turning_handler_branches_to_side_and_turn_jump() {
        let mut side_jump_runtime = AcroRuntime::default();
        seed_jump_window(&mut side_jump_runtime, Direction::Right, 2);
        assert_eq!(
            side_jump_runtime.apply_step(Direction::Up, Direction::Right),
            AcroAnimationAction::SideJump
        );

        let mut turn_jump_runtime = AcroRuntime::default();
        seed_jump_window(&mut turn_jump_runtime, Direction::Right, 2);
        assert_eq!(
            turn_jump_runtime.apply_step(Direction::Left, Direction::Right),
            AcroAnimationAction::TurnJump
        );
    }

    #[test]
    fn advance_tick_in_turning_updates_pending_action_and_keeps_jump_window() {
        let mut runtime = AcroRuntime {
            state: AcroState::Turning,
            new_dir_backup: Some(Direction::Right),
            ..Default::default()
        };
        runtime.update_history(Some(Direction::Right), 0);
        runtime.update_history(Some(Direction::Right), 0);
        runtime.update_history(Some(Direction::Right), holding_b_mask());
        runtime.set_held_input(Some(Direction::Right), true);

        runtime.advance_tick();

        assert_eq!(runtime.state, AcroState::SideJump);
        assert_eq!(
            runtime.take_pending_action(),
            Some(AcroAnimationAction::SideJump)
        );
        assert_eq!(
            runtime.apply_step(Direction::Up, Direction::Right),
            AcroAnimationAction::Moving
        );
    }

    #[test]
    fn turning_ticks_progress_to_turn_direction_without_walk_step_input() {
        let mut runtime = AcroRuntime::default();

        runtime.set_held_input(Some(Direction::Left), false);
        assert_eq!(
            runtime.apply_step(Direction::Up, Direction::Left),
            AcroAnimationAction::FaceDirection
        );
        assert_eq!(runtime.state, AcroState::Turning);

        runtime.set_held_input(None, false);
        for _ in 0..5 {
            runtime.advance_tick();
            assert_eq!(runtime.state, AcroState::Turning);
            assert_eq!(
                runtime.take_pending_action(),
                Some(AcroAnimationAction::FaceDirection)
            );
        }

        runtime.advance_tick();
        assert_eq!(runtime.state, AcroState::Normal);
        assert_eq!(runtime.running_state, RunningState::TurnDirection);
        assert_eq!(
            runtime.take_pending_action(),
            Some(AcroAnimationAction::TurnDirection)
        );
    }

    #[test]
    fn stationary_b_hold_starts_bunny_hop_after_turning_resolves() {
        let mut runtime = AcroRuntime::default();

        runtime.set_held_input(Some(Direction::Left), false);
        assert_eq!(
            runtime.apply_step(Direction::Up, Direction::Left),
            AcroAnimationAction::FaceDirection
        );
        assert_eq!(runtime.state, AcroState::Turning);

        runtime.set_held_input(None, false);
        for _ in 0..6 {
            runtime.advance_tick();
            runtime.take_pending_action();
        }

        assert_eq!(runtime.state, AcroState::Normal);
        assert_eq!(runtime.running_state, RunningState::TurnDirection);

        runtime.set_held_input(None, true);
        runtime.advance_tick();
        assert_eq!(runtime.state, AcroState::WheelieStanding);
        assert_eq!(
            runtime.take_pending_action(),
            Some(AcroAnimationAction::NormalToWheelie)
        );

        for _ in 0..39 {
            runtime.set_held_input(None, true);
            runtime.advance_tick();
            assert_eq!(runtime.state, AcroState::WheelieStanding);
            assert_eq!(
                runtime.take_pending_action(),
                Some(AcroAnimationAction::WheelieIdle)
            );
        }

        runtime.set_held_input(None, true);
        runtime.advance_tick();
        assert_eq!(runtime.state, AcroState::BunnyHop);
        assert_eq!(
            runtime.take_pending_action(),
            Some(AcroAnimationAction::WheelieHoppingStanding)
        );
    }

    #[test]
    fn turning_runtime_side_jump_triggers_within_4_tick_held_window() {
        let mut runtime = AcroRuntime {
            state: AcroState::Turning,
            new_dir_backup: Some(Direction::Right),
            ..Default::default()
        };

        runtime.set_held_input(Some(Direction::Right), false);
        runtime.advance_tick();
        runtime.set_held_input(Some(Direction::Right), true);
        runtime.advance_tick();

        assert_eq!(
            runtime.apply_step(Direction::Up, Direction::Right),
            AcroAnimationAction::SideJump
        );
        assert_eq!(runtime.state, AcroState::SideJump);
    }

    #[test]
    fn turning_runtime_turn_jump_triggers_within_4_tick_held_window() {
        let mut runtime = AcroRuntime {
            state: AcroState::Turning,
            new_dir_backup: Some(Direction::Right),
            movement_direction: Direction::Left,
            ..Default::default()
        };

        runtime.set_held_input(Some(Direction::Right), false);
        runtime.advance_tick();
        runtime.set_held_input(Some(Direction::Right), true);
        runtime.advance_tick();

        assert_eq!(runtime.state, AcroState::TurnJump);
        assert_eq!(
            runtime.take_pending_action(),
            Some(AcroAnimationAction::TurnJump)
        );
        assert_eq!(
            runtime.apply_step(Direction::Left, Direction::Right),
            AcroAnimationAction::TurnJump
        );
        assert_eq!(runtime.state, AcroState::TurnJump);
    }

    #[test]
    fn wheelie_standing_handler_covers_idle_move_hop_and_release() {
        let mut runtime = AcroRuntime {
            state: AcroState::WheelieStanding,
            ..Default::default()
        };

        runtime.set_held_input(None, true);
        assert_eq!(
            runtime.apply_step(Direction::Right, Direction::Left),
            AcroAnimationAction::WheelieIdle
        );

        assert_eq!(
            runtime.apply_step(Direction::Right, Direction::Right),
            AcroAnimationAction::WheelieMoving
        );

        runtime.state = AcroState::WheelieStanding;
        runtime.bike_frame_counter = 39;
        runtime.set_held_input(None, true);
        runtime.advance_tick();
        assert_eq!(runtime.state, AcroState::BunnyHop);
        assert_eq!(
            runtime.take_pending_action(),
            Some(AcroAnimationAction::WheelieHoppingStanding)
        );

        runtime.state = AcroState::WheelieStanding;
        runtime.set_held_input(None, false);
        runtime.advance_tick();
        assert_eq!(runtime.state, AcroState::Normal);
        assert_eq!(
            runtime.take_pending_action(),
            Some(AcroAnimationAction::WheelieToNormal)
        );
    }

    #[test]
    fn bunny_hop_handler_covers_all_branches() {
        let mut runtime = AcroRuntime {
            state: AcroState::BunnyHop,
            ..Default::default()
        };

        runtime.set_held_input(None, true);
        runtime.advance_tick();
        assert_eq!(
            runtime.take_pending_action(),
            Some(AcroAnimationAction::WheelieHoppingStanding)
        );

        runtime.set_held_input(Some(Direction::Down), true);
        assert_eq!(
            runtime.apply_step(Direction::Down, Direction::Down),
            AcroAnimationAction::WheelieHoppingMoving
        );

        runtime.running_state = RunningState::NotMoving;
        assert_eq!(
            runtime.apply_step(Direction::Down, Direction::Left),
            AcroAnimationAction::WheelieHoppingStanding
        );

        runtime.set_held_input(None, false);
        runtime.advance_tick();
        assert_eq!(runtime.state, AcroState::Normal);
        assert_eq!(
            runtime.take_pending_action(),
            Some(AcroAnimationAction::WheelieToNormal)
        );
    }

    #[test]
    fn directional_bunny_hop_release_exits_immediately_without_waiting_for_landing() {
        let mut runtime = AcroRuntime {
            state: AcroState::BunnyHop,
            bunny_hop_cycle_tick: BUNNY_HOP_CYCLE_TICKS - 2,
            running_state: RunningState::Moving,
            ..Default::default()
        };

        runtime.set_held_input(Some(Direction::Right), false);
        runtime.advance_tick();
        assert_eq!(runtime.state, AcroState::Normal);
        assert_eq!(runtime.running_state, RunningState::NotMoving);
        assert_eq!(runtime.bike_frame_counter, 0);
        assert_eq!(
            runtime.take_pending_action(),
            Some(AcroAnimationAction::WheelieToNormal)
        );
    }

    #[test]
    fn wheelie_moving_handler_covers_idle_move_and_lowering() {
        let mut runtime = AcroRuntime {
            state: AcroState::WheelieMoving,
            running_state: RunningState::Moving,
            ..Default::default()
        };

        runtime.set_held_input(None, true);
        runtime.advance_tick();
        assert_eq!(runtime.state, AcroState::WheelieStanding);
        assert_eq!(runtime.bike_frame_counter, 0);
        assert_eq!(
            runtime.take_pending_action(),
            Some(AcroAnimationAction::WheelieIdle)
        );

        runtime.state = AcroState::WheelieMoving;
        runtime.set_held_input(Some(Direction::Up), true);
        assert_eq!(
            runtime.apply_step(Direction::Up, Direction::Up),
            AcroAnimationAction::WheelieMoving
        );

        runtime.state = AcroState::WheelieMoving;
        runtime.set_held_input(Some(Direction::Up), false);
        assert_eq!(
            runtime.apply_step(Direction::Up, Direction::Up),
            AcroAnimationAction::WheelieLoweringMoving
        );

        runtime.state = AcroState::WheelieMoving;
        runtime.running_state = RunningState::NotMoving;
        runtime.set_held_input(None, false);
        runtime.advance_tick();
        assert_eq!(
            runtime.take_pending_action(),
            Some(AcroAnimationAction::WheelieToNormal)
        );
    }

    #[test]
    fn releasing_b_on_bumpy_slope_preserves_wheelie_flow() {
        let mut runtime = AcroRuntime {
            state: AcroState::WheelieMoving,
            on_bumpy_slope: true,
            ..Default::default()
        };

        runtime.set_held_input(None, false);
        runtime.advance_tick();
        assert_eq!(runtime.state, AcroState::WheelieStanding);
        assert_eq!(
            runtime.take_pending_action(),
            Some(AcroAnimationAction::WheelieIdle)
        );
    }

    #[test]
    fn bumpy_slope_mount_transition_forces_idle_wheelie() {
        let mut runtime = AcroRuntime::default();
        let action = runtime.handle_bumpy_slope_mount_transition(Direction::Left);
        assert_eq!(action, AcroAnimationAction::WheelieIdle);
        assert_eq!(runtime.state, AcroState::WheelieStanding);
        assert_eq!(runtime.running_state, RunningState::NotMoving);
        assert_eq!(runtime.movement_direction, Direction::Left);
    }

    #[test]
    fn wheelie_collision_on_bumpy_slope_uses_idle_response() {
        let mut runtime = AcroRuntime {
            state: AcroState::WheelieMoving,
            on_bumpy_slope: true,
            ..Default::default()
        };

        assert_eq!(
            runtime.handle_wheelie_collision_response(),
            Some(AcroAnimationAction::WheelieIdle)
        );
        assert_eq!(runtime.state, AcroState::WheelieStanding);
    }

    #[test]
    fn side_and_turn_jump_handlers_reenter_dispatch() {
        let mut side = AcroRuntime {
            state: AcroState::SideJump,
            ..Default::default()
        };
        side.set_held_input(Some(Direction::Right), true);
        assert_eq!(
            side.apply_step(Direction::Right, Direction::Right),
            AcroAnimationAction::WheelieRisingMoving
        );

        let mut turn = AcroRuntime {
            state: AcroState::TurnJump,
            ..Default::default()
        };
        turn.set_held_input(None, false);
        turn.advance_tick();
        assert_eq!(turn.state, AcroState::Normal);
        assert_eq!(
            turn.take_pending_action(),
            Some(AcroAnimationAction::FaceDirection)
        );
    }

    #[test]
    fn bunny_hop_phase_emits_landing_pulse_each_cycle_while_state_persists() {
        let mut runtime = AcroRuntime {
            state: AcroState::BunnyHop,
            ..Default::default()
        };
        runtime.set_held_input(None, true);

        let mut landing_ticks = 0;
        for _ in 0..16 {
            runtime.advance_tick();
            if runtime.hop_landed_this_tick() {
                landing_ticks += 1;
            }
            runtime.take_pending_action();
        }

        assert_eq!(landing_ticks, 1);
        assert_eq!(runtime.state, AcroState::BunnyHop);
    }

    #[test]
    fn directional_bunny_hop_shares_same_landing_pulse_path() {
        let mut runtime = AcroRuntime {
            state: AcroState::BunnyHop,
            ..Default::default()
        };
        runtime.set_held_input(Some(Direction::Right), true);

        let mut landing_ticks = 0;
        for _ in 0..16 {
            let _ = runtime.apply_step(Direction::Right, Direction::Right);
            if runtime.hop_landed_this_tick() {
                landing_ticks += 1;
            }
        }

        assert_eq!(landing_ticks, 1);
        assert_eq!(runtime.state, AcroState::BunnyHop);
    }

    #[test]
    fn bunny_hop_landing_pulse_is_deterministic_under_continuous_b_hold() {
        let mut runtime = AcroRuntime {
            state: AcroState::BunnyHop,
            ..Default::default()
        };
        runtime.set_held_input(None, true);

        let mut landing_ticks = Vec::new();
        for tick in 0..48 {
            runtime.advance_tick();
            if runtime.hop_landed_this_tick() {
                landing_ticks.push(tick);
            }
            runtime.take_pending_action();
        }

        assert_eq!(landing_ticks, vec![15, 31, 47]);
    }
}

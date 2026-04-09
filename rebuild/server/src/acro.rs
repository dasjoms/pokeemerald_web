use crate::protocol::Direction;

const INPUT_HISTORY_LEN: usize = 8;
const TIMER_END: u8 = 0;
const ACRO_JUMP_TIMER_LIST: [u8; 2] = [4, TIMER_END];

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
pub enum AcroAnimationAction {
    None = 0,
    WheelieIdle = 1,
    WheeliePop = 2,
    WheelieEnd = 3,
    HopStanding = 4,
    HopMoving = 5,
    SideJump = 6,
    TurnJump = 7,
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
    pub direction_history: u32,
    pub ab_start_select_history: u32,
    pub dir_timer_history: [u8; INPUT_HISTORY_LEN],
    pub ab_start_select_timer_history: [u8; INPUT_HISTORY_LEN],
    pub bike_frame_counter: u8,
    pub last_input_direction: Option<Direction>,
}

impl Default for AcroRuntime {
    fn default() -> Self {
        Self {
            state: AcroState::Normal,
            direction_history: 0,
            ab_start_select_history: 0,
            dir_timer_history: [0; INPUT_HISTORY_LEN],
            ab_start_select_timer_history: [0; INPUT_HISTORY_LEN],
            bike_frame_counter: 0,
            last_input_direction: None,
        }
    }
}

impl AcroRuntime {
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
        holding_b: bool,
    ) -> AcroAnimationAction {
        self.update_history(
            Some(requested_direction),
            if holding_b { ABSS_B } else { 0 },
        );

        let jump_direction = self.get_jump_direction();
        let changed_direction = self.last_input_direction != Some(requested_direction);
        self.last_input_direction = Some(requested_direction);

        if changed_direction {
            self.state = AcroState::Turning;
            self.bike_frame_counter = 0;
        }

        match self.state {
            AcroState::Turning if jump_direction == Some(requested_direction) => {
                self.state = if requested_direction == opposite_direction(facing_direction) {
                    AcroState::TurnJump
                } else {
                    AcroState::SideJump
                };
            }
            AcroState::SideJump | AcroState::TurnJump => {
                self.state = AcroState::Normal;
            }
            _ => {}
        }

        if holding_b {
            self.bike_frame_counter = self.bike_frame_counter.saturating_add(1);
            if self.bike_frame_counter >= 40 {
                self.state = AcroState::BunnyHop;
                return if changed_direction {
                    AcroAnimationAction::HopMoving
                } else {
                    AcroAnimationAction::HopStanding
                };
            }

            return match self.state {
                AcroState::SideJump => AcroAnimationAction::SideJump,
                AcroState::TurnJump => AcroAnimationAction::TurnJump,
                AcroState::WheelieMoving => AcroAnimationAction::WheelieIdle,
                _ => {
                    self.state = AcroState::WheelieMoving;
                    AcroAnimationAction::WheeliePop
                }
            };
        }

        self.bike_frame_counter = 0;
        let was_wheelie = matches!(
            self.state,
            AcroState::WheelieStanding | AcroState::BunnyHop | AcroState::WheelieMoving
        );
        self.state = AcroState::Normal;

        if was_wheelie {
            AcroAnimationAction::WheelieEnd
        } else {
            AcroAnimationAction::None
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
    fn jump_direction_supports_exact_boundary_for_button_timer() {
        let mut runtime = AcroRuntime::default();

        runtime.update_history(Some(Direction::Up), holding_b_mask());
        for _ in 0..3 {
            runtime.update_history(Some(Direction::Up), holding_b_mask());
        }

        assert_eq!(runtime.get_jump_direction(), Some(Direction::Up));

        runtime.update_history(Some(Direction::Up), holding_b_mask());
        assert_eq!(runtime.get_jump_direction(), None);
    }
}

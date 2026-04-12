use crate::{
    camera_wheel::{CameraWheelState, StripRedrawSample},
    map_runtime::{RuntimeMapGrid, MAPGRID_COLLISION_MASK, MAP_OFFSET},
};

pub const WALK_TICKS_PER_TILE: u8 = 16;
pub const FIXED_SIMULATION_TICK_HZ: u16 = 60;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MovementMode {
    NormalWalk,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RunningState {
    NotMoving,
    TurnDirection,
    Moving,
}
impl RunningState {
    pub fn as_spec_str(self) -> &'static str {
        match self {
            Self::NotMoving => "NOT_MOVING",
            Self::TurnDirection => "TURN_DIRECTION",
            Self::Moving => "MOVING",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TileTransitionState {
    TNotMoving,
    TTileTransition,
    TTileCenter,
}
impl TileTransitionState {
    pub fn as_spec_str(self) -> &'static str {
        match self {
            Self::TNotMoving => "T_NOT_MOVING",
            Self::TTileTransition => "T_TILE_TRANSITION",
            Self::TTileCenter => "T_TILE_CENTER",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Direction {
    North,
    South,
    West,
    East,
}

impl Direction {
    pub fn as_spec_str(self) -> &'static str {
        match self {
            Self::North => "NORTH",
            Self::South => "SOUTH",
            Self::West => "WEST",
            Self::East => "EAST",
        }
    }

    fn tile_delta(self) -> (i32, i32) {
        match self {
            Self::North => (0, -1),
            Self::South => (0, 1),
            Self::West => (-1, 0),
            Self::East => (1, 0),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MovementState {
    pub mode: MovementMode,
    pub running_state: RunningState,
    pub tile_transition_state: TileTransitionState,
    pub facing_direction: Direction,
    pub movement_direction: Direction,
    pub step_timer: u8,
    pub pixel_offset_x: i32,
    pub pixel_offset_y: i32,
    pub camera_pos_x: i32,
    pub camera_pos_y: i32,
    pub x_tile_offset: i32,
    pub y_tile_offset: i32,
    pub horizontal_pan: i32,
    pub vertical_pan: i32,
    pub player_runtime_x: i32,
    pub player_runtime_y: i32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TickOutput {
    pub crossed_metatile: bool,
    pub strip_redraws: Vec<StripRedrawSample>,
}

impl MovementState {
    pub fn new(player_runtime_x: i32, player_runtime_y: i32, facing_direction: Direction) -> Self {
        // camera_pos tracks top-left map-space camera equivalent.
        let camera_pos_x = player_runtime_x - MAP_OFFSET as i32;
        let camera_pos_y = player_runtime_y - MAP_OFFSET as i32;
        Self {
            mode: MovementMode::NormalWalk,
            running_state: RunningState::NotMoving,
            tile_transition_state: TileTransitionState::TNotMoving,
            facing_direction,
            movement_direction: facing_direction,
            step_timer: 0,
            pixel_offset_x: 0,
            pixel_offset_y: 0,
            camera_pos_x,
            camera_pos_y,
            x_tile_offset: 0,
            y_tile_offset: 0,
            horizontal_pan: 0,
            vertical_pan: 32,
            player_runtime_x,
            player_runtime_y,
        }
    }

    pub fn try_start_walk(&mut self, direction: Direction, runtime: &RuntimeMapGrid) -> bool {
        self.facing_direction = direction;
        if self.running_state == RunningState::Moving {
            return false;
        }

        let (dx, dy) = direction.tile_delta();
        let destination_x = self.player_runtime_x + dx;
        let destination_y = self.player_runtime_y + dy;
        let destination_packed =
            runtime.get_packed_with_border_fallback(destination_x, destination_y);
        let blocked = destination_packed & MAPGRID_COLLISION_MASK != 0;
        if blocked {
            self.running_state = RunningState::TurnDirection;
            self.tile_transition_state = TileTransitionState::TNotMoving;
            return false;
        }

        self.running_state = RunningState::Moving;
        self.tile_transition_state = TileTransitionState::TTileTransition;
        self.movement_direction = direction;
        self.step_timer = 0;
        true
    }

    pub fn tick(&mut self) -> TickOutput {
        if self.running_state != RunningState::Moving {
            return TickOutput {
                crossed_metatile: false,
                strip_redraws: Vec::new(),
            };
        }

        let (dx, dy) = self.movement_direction.tile_delta();
        self.pixel_offset_x += dx;
        self.pixel_offset_y += dy;
        self.step_timer += 1;

        if self.step_timer == WALK_TICKS_PER_TILE / 2 {
            self.tile_transition_state = TileTransitionState::TTileCenter;
        }

        if self.step_timer < WALK_TICKS_PER_TILE {
            return TickOutput {
                crossed_metatile: false,
                strip_redraws: Vec::new(),
            };
        }

        self.player_runtime_x += dx;
        self.player_runtime_y += dy;

        let mut wheel = CameraWheelState {
            camera_pos_x: self.camera_pos_x,
            camera_pos_y: self.camera_pos_y,
            x_tile_offset: self.x_tile_offset,
            y_tile_offset: self.y_tile_offset,
        };
        let strips = wheel.apply_metatile_step(dx, dy);
        self.camera_pos_x = wheel.camera_pos_x;
        self.camera_pos_y = wheel.camera_pos_y;
        self.x_tile_offset = wheel.x_tile_offset;
        self.y_tile_offset = wheel.y_tile_offset;

        self.step_timer = 0;
        self.pixel_offset_x = 0;
        self.pixel_offset_y = 0;
        self.running_state = RunningState::NotMoving;
        self.tile_transition_state = TileTransitionState::TNotMoving;

        TickOutput {
            crossed_metatile: true,
            strip_redraws: strips,
        }
    }

    pub fn camera_runtime_anchor(&self) -> (i32, i32) {
        (
            self.camera_pos_x + MAP_OFFSET as i32,
            self.camera_pos_y + MAP_OFFSET as i32,
        )
    }
}

#[cfg(test)]
mod tests {
    use super::{Direction, MovementState, RunningState, TileTransitionState};
    use crate::map_runtime::RuntimeMapGrid;

    #[test]
    fn initializes_with_emerald_startup_scroll_and_offsets() {
        let state = MovementState::new(17, 8, Direction::South);
        assert_eq!(state.camera_pos_x, 10);
        assert_eq!(state.camera_pos_y, 1);
        assert_eq!(state.x_tile_offset, 0);
        assert_eq!(state.y_tile_offset, 0);
        assert_eq!(state.pixel_offset_x, 0);
        assert_eq!(state.pixel_offset_y, 0);
        assert_eq!(state.horizontal_pan, 0);
        assert_eq!(state.vertical_pan, 32);
    }

    #[test]
    fn blocked_walk_keeps_actor_non_moving_and_turns_only() {
        let mut state = MovementState::new(8, 8, Direction::South);
        let runtime = RuntimeMapGrid {
            width: 20,
            height: 20,
            tiles: vec![0x0C00; 20 * 20],
            border_tiles: [0; 4],
            source_map_ids: vec!["MAP".to_owned()],
            tile_source_indices: vec![0; 20 * 20],
        };

        let started = state.try_start_walk(Direction::East, &runtime);
        assert!(!started);
        assert_eq!(state.running_state, RunningState::TurnDirection);
        assert_eq!(state.tile_transition_state, TileTransitionState::TNotMoving);
        assert_eq!(state.player_runtime_x, 8);
        assert_eq!(state.player_runtime_y, 8);
    }

    #[test]
    fn replay_is_deterministic_for_1_2_and_10_tiles_in_each_direction() {
        let runtime = RuntimeMapGrid {
            width: 96,
            height: 96,
            tiles: vec![0; 96 * 96],
            border_tiles: [0; 4],
            source_map_ids: vec!["MAP".to_owned()],
            tile_source_indices: vec![0; 96 * 96],
        };

        for direction in [
            Direction::North,
            Direction::South,
            Direction::West,
            Direction::East,
        ] {
            for tile_count in [1_i32, 2, 10] {
                let first = replay_walk(&runtime, direction, tile_count);
                let second = replay_walk(&runtime, direction, tile_count);

                assert_eq!(
                    first, second,
                    "trace mismatch for {direction:?} {tile_count}"
                );
                assert_eq!(first.final_step_timer, 0);
                assert_eq!(first.final_offsets, (0, 0));
                assert_eq!(first.strip_lengths.len(), tile_count as usize);
                assert!(first.strip_lengths.iter().all(|len| *len == 16));
            }
        }
    }

    fn replay_walk(runtime: &RuntimeMapGrid, direction: Direction, tiles: i32) -> ReplayResult {
        let mut state = MovementState::new(24, 24, Direction::South);
        let mut strip_lengths = Vec::new();

        for _ in 0..tiles {
            assert!(state.try_start_walk(direction, runtime));
            for _ in 0..16 {
                let output = state.tick();
                if output.crossed_metatile {
                    strip_lengths.push(output.strip_redraws.len());
                }
            }
        }

        ReplayResult {
            final_runtime: (state.player_runtime_x, state.player_runtime_y),
            final_step_timer: state.step_timer,
            final_offsets: (state.pixel_offset_x, state.pixel_offset_y),
            final_wheel: (
                state.camera_pos_x,
                state.camera_pos_y,
                state.x_tile_offset,
                state.y_tile_offset,
            ),
            strip_lengths,
        }
    }

    #[derive(Debug, Clone, PartialEq, Eq)]
    struct ReplayResult {
        final_runtime: (i32, i32),
        final_step_timer: u8,
        final_offsets: (i32, i32),
        final_wheel: (i32, i32, i32, i32),
        strip_lengths: Vec<usize>,
    }
}

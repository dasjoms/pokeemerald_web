use crate::protocol::{Direction, MovementMode};

const MB_INVALID: u8 = u8::MAX;
const MB_WALK_EAST: u8 = 0x40;
const MB_WALK_WEST: u8 = 0x41;
const MB_WALK_NORTH: u8 = 0x42;
const MB_WALK_SOUTH: u8 = 0x43;
const MB_SLIDE_EAST: u8 = 0x44;
const MB_SLIDE_WEST: u8 = 0x45;
const MB_SLIDE_NORTH: u8 = 0x46;
const MB_SLIDE_SOUTH: u8 = 0x47;
const MB_TRICK_HOUSE_PUZZLE_8_FLOOR: u8 = 0x48;
const MB_EASTWARD_CURRENT: u8 = 0x50;
const MB_WESTWARD_CURRENT: u8 = 0x51;
const MB_NORTHWARD_CURRENT: u8 = 0x52;
const MB_SOUTHWARD_CURRENT: u8 = 0x53;
const MB_WATERFALL: u8 = 0x13;
const MB_ICE: u8 = 0x20;
const MB_SECRET_BASE_JUMP_MAT: u8 = 0xBB;
const MB_SECRET_BASE_SPIN_MAT: u8 = 0xBC;
pub const MB_MUDDY_SLOPE: u8 = 0xD0;
const MB_CRACKED_FLOOR: u8 = 0xD2;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MoveValidation {
    Accepted { next_x: u16, next_y: u16 },
    Rejected(MoveRejectReason),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MoveRejectReason {
    Collision,
    OutOfBounds,
    ForcedMovementDisabled,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ForcedMovementClass {
    Walk,
    Slide,
    Current,
    Ice,
    Waterfall,
    MuddySlope,
    TrickHouseSlippery,
    SecretBaseJumpMat,
    SecretBaseSpinMat,
    CrackedFloor,
}

#[derive(Debug, Clone, Copy)]
struct TileQuery {
    x: i32,
    y: i32,
    in_bounds: bool,
    collision_bits: u8,
    behavior_id: u8,
}

#[derive(Debug, Clone, Copy)]
pub struct TileProbe {
    pub behavior_id: u8,
}

#[derive(Debug, Clone, Copy)]
pub struct MovementMap<'a> {
    pub width: u16,
    pub height: u16,
    pub collision: &'a [u8],
    pub behavior: &'a [u8],
}

#[derive(Debug, Clone, Copy)]
pub struct ConnectedDestination {
    pub x: u16,
    pub y: u16,
    pub collision_bits: u8,
    pub behavior_id: u8,
}

pub fn validate_walk(
    x: u16,
    y: u16,
    facing: Direction,
    map: MovementMap<'_>,
    connected_destination: Option<ConnectedDestination>,
) -> MoveValidation {
    let source = tile_query(x as i32, y as i32, &map);
    let (dx, dy) = facing_delta(facing);
    let destination = tile_query(source.x + dx, source.y + dy, &map);
    let destination = if destination.in_bounds {
        destination
    } else if let Some(connected) = connected_destination {
        TileQuery {
            x: connected.x as i32,
            y: connected.y as i32,
            in_bounds: true,
            collision_bits: connected.collision_bits,
            behavior_id: connected.behavior_id,
        }
    } else {
        trace_walk_attempt(
            facing,
            source,
            destination,
            "rejected: out_of_bounds_without_map_connection",
        );
        return MoveValidation::Rejected(MoveRejectReason::OutOfBounds);
    };

    if destination.collision_bits != 0 {
        trace_walk_attempt(
            facing,
            source,
            destination,
            "rejected: static_collision_bit_set",
        );
        return MoveValidation::Rejected(MoveRejectReason::Collision);
    }

    if let Some(forced_class) = forced_movement_class(source.behavior_id)
        .or_else(|| forced_movement_class(destination.behavior_id))
    {
        trace_walk_attempt(
            facing,
            source,
            destination,
            forced_movement_reject_reason(forced_class),
        );
        return MoveValidation::Rejected(MoveRejectReason::ForcedMovementDisabled);
    }

    trace_walk_attempt(facing, source, destination, "accepted: standard_walk");

    MoveValidation::Accepted {
        next_x: destination.x as u16,
        next_y: destination.y as u16,
    }
}

pub fn tile_probe(map: MovementMap<'_>, x: u16, y: u16) -> TileProbe {
    let query = tile_query(x as i32, y as i32, &map);
    TileProbe {
        behavior_id: query.behavior_id,
    }
}

pub fn facing_delta(facing: Direction) -> (i32, i32) {
    match facing {
        Direction::Up => (0, -1),
        Direction::Down => (0, 1),
        Direction::Left => (-1, 0),
        Direction::Right => (1, 0),
    }
}

pub const WALK_TILE_PIXELS: u16 = 16;
pub const WALK_SAMPLE_MS: f32 = 1000.0 / 60.0;
pub const WALK_NORMAL_STEP_PIXELS_PER_SAMPLE: u8 = 1;
pub const WALK_STEP_SPEED: StepSpeed = StepSpeed::Step1;
pub const RUN_STEP_SPEED: StepSpeed = StepSpeed::Step2;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StepSpeed {
    Step1,
    Step2,
    Step3,
    Step4,
    Step8,
}

pub const fn movement_mode_step_speed(mode: MovementMode) -> StepSpeed {
    match mode {
        MovementMode::Walk => WALK_STEP_SPEED,
        MovementMode::Run => RUN_STEP_SPEED,
        MovementMode::MachBike => StepSpeed::Step3,
        MovementMode::AcroCruise => RUN_STEP_SPEED,
        MovementMode::AcroWheeliePrep => WALK_STEP_SPEED,
        MovementMode::AcroWheelieMove => RUN_STEP_SPEED,
        MovementMode::BunnyHop => WALK_STEP_SPEED,
    }
}

pub const fn movement_mode_samples_per_tile(mode: MovementMode) -> u16 {
    movement_mode_step_speed(mode).samples_per_tile()
}

impl StepSpeed {
    pub const fn pixels_per_sample(self) -> u8 {
        match self {
            StepSpeed::Step1 => 1,
            StepSpeed::Step2 => 2,
            StepSpeed::Step3 => 3,
            StepSpeed::Step4 => 4,
            StepSpeed::Step8 => 8,
        }
    }

    pub const fn samples_per_tile(self) -> u16 {
        match self {
            StepSpeed::Step1 => 16,
            StepSpeed::Step2 => 8,
            StepSpeed::Step3 => 6,
            StepSpeed::Step4 => 4,
            StepSpeed::Step8 => 2,
        }
    }
}

pub fn normal_walk_samples_per_tile() -> u16 {
    StepSpeed::Step1.samples_per_tile()
}

pub fn step_progress_pixels(elapsed_samples: u16, speed: StepSpeed) -> u16 {
    let raw = elapsed_samples.saturating_mul(speed.pixels_per_sample() as u16);
    raw.min(WALK_TILE_PIXELS)
}

fn tile_query(x: i32, y: i32, map: &MovementMap<'_>) -> TileQuery {
    let in_bounds = x >= 0 && y >= 0 && x < map.width as i32 && y < map.height as i32;
    if !in_bounds {
        return TileQuery {
            x,
            y,
            in_bounds,
            collision_bits: 1,
            behavior_id: MB_INVALID,
        };
    }

    let index = y as usize * map.width as usize + x as usize;
    TileQuery {
        x,
        y,
        in_bounds,
        collision_bits: map.collision.get(index).copied().unwrap_or(1),
        behavior_id: map.behavior.get(index).copied().unwrap_or(MB_INVALID),
    }
}

fn forced_movement_class(behavior_id: u8) -> Option<ForcedMovementClass> {
    match behavior_id {
        MB_WALK_EAST | MB_WALK_WEST | MB_WALK_NORTH | MB_WALK_SOUTH => {
            Some(ForcedMovementClass::Walk)
        }
        MB_SLIDE_EAST | MB_SLIDE_WEST | MB_SLIDE_NORTH | MB_SLIDE_SOUTH => {
            Some(ForcedMovementClass::Slide)
        }
        MB_EASTWARD_CURRENT | MB_WESTWARD_CURRENT | MB_NORTHWARD_CURRENT | MB_SOUTHWARD_CURRENT => {
            Some(ForcedMovementClass::Current)
        }
        MB_ICE => Some(ForcedMovementClass::Ice),
        MB_WATERFALL => Some(ForcedMovementClass::Waterfall),
        MB_MUDDY_SLOPE => Some(ForcedMovementClass::MuddySlope),
        MB_TRICK_HOUSE_PUZZLE_8_FLOOR => Some(ForcedMovementClass::TrickHouseSlippery),
        MB_SECRET_BASE_JUMP_MAT => Some(ForcedMovementClass::SecretBaseJumpMat),
        MB_SECRET_BASE_SPIN_MAT => Some(ForcedMovementClass::SecretBaseSpinMat),
        MB_CRACKED_FLOOR => Some(ForcedMovementClass::CrackedFloor),
        _ => None,
    }
}

fn forced_movement_reject_reason(class: ForcedMovementClass) -> &'static str {
    match class {
        ForcedMovementClass::Walk => "rejected: forced_walk_tile_pending_phase1_parity",
        ForcedMovementClass::Slide => "rejected: forced_slide_tile_pending_phase1_parity",
        ForcedMovementClass::Current => "rejected: forced_current_tile_pending_phase1_parity",
        ForcedMovementClass::Ice => "rejected: forced_ice_tile_pending_phase1_parity",
        ForcedMovementClass::Waterfall => "rejected: forced_waterfall_tile_pending_phase1_parity",
        ForcedMovementClass::MuddySlope => "rejected: forced_muddy_slope_pending_phase1_parity",
        ForcedMovementClass::TrickHouseSlippery => {
            "rejected: trick_house_slippery_tile_pending_phase1_parity"
        }
        ForcedMovementClass::SecretBaseJumpMat => {
            "rejected: secret_base_jump_mat_pending_phase1_parity"
        }
        ForcedMovementClass::SecretBaseSpinMat => {
            "rejected: secret_base_spin_mat_pending_phase1_parity"
        }
        ForcedMovementClass::CrackedFloor => {
            "rejected: cracked_floor_forced_behavior_pending_phase1_parity"
        }
    }
}

fn trace_walk_attempt(facing: Direction, source: TileQuery, destination: TileQuery, reason: &str) {
    if cfg!(debug_assertions) {
        tracing::trace!(
            input_direction = ?facing,
            source_tile_x = source.x,
            source_tile_y = source.y,
            destination_tile_x = destination.x,
            destination_tile_y = destination.y,
            source_collision_bits = source.collision_bits,
            destination_collision_bits = destination.collision_bits,
            source_behavior_id = source.behavior_id,
            destination_behavior_id = destination.behavior_id,
            accepted = reason.starts_with("accepted"),
            reason,
            "walk attempt evaluated"
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn map<'a>(collision: &'a [u8], behavior: &'a [u8]) -> MovementMap<'a> {
        MovementMap {
            width: 2,
            height: 2,
            collision,
            behavior,
        }
    }

    #[test]
    fn accepts_basic_walk() {
        let result = validate_walk(
            0,
            0,
            Direction::Right,
            map(&[0, 0, 0, 0], &[0, 0, 0, 0]),
            None,
        );
        assert_eq!(
            result,
            MoveValidation::Accepted {
                next_x: 1,
                next_y: 0
            }
        );
    }

    #[test]
    fn rejects_collision_tiles() {
        let result = validate_walk(
            0,
            0,
            Direction::Right,
            map(&[0, 1, 0, 0], &[0, 0, 0, 0]),
            None,
        );
        assert_eq!(
            result,
            MoveValidation::Rejected(MoveRejectReason::Collision)
        );
    }

    #[test]
    fn rejects_out_of_bounds_tiles() {
        let result = validate_walk(0, 0, Direction::Up, map(&[0, 0, 0, 0], &[0, 0, 0, 0]), None);
        assert_eq!(
            result,
            MoveValidation::Rejected(MoveRejectReason::OutOfBounds)
        );
    }

    #[test]
    fn accepts_connected_destinations() {
        let result = validate_walk(
            0,
            0,
            Direction::Up,
            map(&[0, 0, 0, 0], &[0, 0, 0, 0]),
            Some(ConnectedDestination {
                x: 1,
                y: 1,
                collision_bits: 0,
                behavior_id: 0,
            }),
        );
        assert_eq!(
            result,
            MoveValidation::Accepted {
                next_x: 1,
                next_y: 1,
            }
        );
    }

    #[test]
    fn rejects_forced_movement_tiles_in_phase1() {
        let result = validate_walk(
            0,
            0,
            Direction::Right,
            map(&[0, 0, 0, 0], &[0, MB_WALK_EAST, 0, 0]),
            None,
        );
        assert_eq!(
            result,
            MoveValidation::Rejected(MoveRejectReason::ForcedMovementDisabled)
        );
    }
}

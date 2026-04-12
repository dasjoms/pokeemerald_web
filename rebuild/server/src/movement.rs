use crate::protocol::{AcroBikeSubstate, Direction, MovementMode, TraversalState};

const MB_INVALID: u8 = u8::MAX;
const MB_WALK_EAST: u8 = 0x40;
const MB_WALK_WEST: u8 = 0x41;
const MB_WALK_NORTH: u8 = 0x42;
const MB_WALK_SOUTH: u8 = 0x43;
const MB_SLIDE_EAST: u8 = 0x44;
const MB_SLIDE_WEST: u8 = 0x45;
const MB_SLIDE_NORTH: u8 = 0x46;
const MB_SLIDE_SOUTH: u8 = 0x47;
const MB_JUMP_EAST: u8 = 0x38;
const MB_JUMP_WEST: u8 = 0x39;
const MB_JUMP_NORTH: u8 = 0x3A;
const MB_JUMP_SOUTH: u8 = 0x3B;
const MB_JUMP_NORTHEAST: u8 = 0x3C;
const MB_JUMP_NORTHWEST: u8 = 0x3D;
const MB_JUMP_SOUTHEAST: u8 = 0x3E;
const MB_JUMP_SOUTHWEST: u8 = 0x3F;
const MB_TRICK_HOUSE_PUZZLE_8_FLOOR: u8 = 0x48;
const MB_EASTWARD_CURRENT: u8 = 0x50;
const MB_WESTWARD_CURRENT: u8 = 0x51;
const MB_NORTHWARD_CURRENT: u8 = 0x52;
const MB_SOUTHWARD_CURRENT: u8 = 0x53;
const MB_WATERFALL: u8 = 0x13;
const MB_ICE: u8 = 0x20;
const MB_SECRET_BASE_JUMP_MAT: u8 = 0xBB;
const MB_SECRET_BASE_SPIN_MAT: u8 = 0xBC;
const MB_MUDDY_SLOPE: u8 = 0xD0;
const MB_BUMPY_SLOPE: u8 = 0xD1;
#[cfg(test)]
const MB_CRACKED_FLOOR: u8 = 0xD2;
const MB_ISOLATED_VERTICAL_RAIL: u8 = 0xD3;
const MB_ISOLATED_HORIZONTAL_RAIL: u8 = 0xD4;
const MB_VERTICAL_RAIL: u8 = 0xD5;
const MB_HORIZONTAL_RAIL: u8 = 0xD6;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MoveValidation {
    Accepted {
        next_x: u16,
        next_y: u16,
        collision: CollisionOutcome,
    },
    Rejected {
        reason: MoveRejectReason,
        collision: CollisionOutcome,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MoveRejectReason {
    Collision,
    OutOfBounds,
    ForcedMovementDisabled,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TraversalContext {
    pub traversal_state: TraversalState,
    pub movement_mode: MovementMode,
    pub bike_frame_counter: u8,
    pub acro_substate: Option<AcroBikeSubstate>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ForcedMovementClass {
    Walk,
    Slide,
    Current,
    Ice,
    Waterfall,
    TrickHouseSlippery,
    SecretBaseJumpMat,
    SecretBaseSpinMat,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CollisionClass {
    None,
    Impassable,
    LedgeJump,
    WheelieHop,
    IsolatedVerticalRail,
    IsolatedHorizontalRail,
    VerticalRail,
    HorizontalRail,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RailCollisionClass {
    IsolatedVertical,
    IsolatedHorizontal,
    Vertical,
    Horizontal,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CollisionOutcome {
    None,
    Impassable,
    LedgeJump,
    WheelieHop,
    Rail(RailCollisionClass),
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
    validate_walk_with_context(
        x,
        y,
        facing,
        map,
        connected_destination,
        TraversalContext {
            traversal_state: TraversalState::OnFoot,
            movement_mode: MovementMode::Walk,
            bike_frame_counter: 0,
            acro_substate: None,
        },
    )
}

pub fn validate_walk_with_context(
    x: u16,
    y: u16,
    facing: Direction,
    map: MovementMap<'_>,
    connected_destination: Option<ConnectedDestination>,
    traversal_context: TraversalContext,
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
        return MoveValidation::Rejected {
            reason: MoveRejectReason::OutOfBounds,
            collision: CollisionOutcome::None,
        };
    };

    if !can_bike_face_dir_on_metatile(facing, source.behavior_id) {
        trace_walk_attempt(
            facing,
            source,
            destination,
            "rejected: bike_dir_not_allowed_for_current_rail",
        );
        return MoveValidation::Rejected {
            reason: MoveRejectReason::Collision,
            collision: CollisionOutcome::None,
        };
    }

    let collision_class = classify_collision(destination, facing);
    let collision = collision_class_outcome(collision_class);
    if collision_reject_reason(collision_class, traversal_context).is_some() {
        trace_walk_attempt(
            facing,
            source,
            destination,
            collision_reject_reason(collision_class, traversal_context)
                .expect("checked is_some above"),
        );
        return MoveValidation::Rejected {
            reason: MoveRejectReason::Collision,
            collision,
        };
    }

    if let Some(forced_class) = forced_movement_class(source.behavior_id)
        .or_else(|| forced_movement_class(destination.behavior_id))
    {
        if let Some(reason) = forced_movement_gate_reject_reason(forced_class, traversal_context) {
            trace_walk_attempt(facing, source, destination, reason);
            return MoveValidation::Rejected {
                reason: MoveRejectReason::ForcedMovementDisabled,
                collision: CollisionOutcome::None,
            };
        }
    }

    if let Some(reason) = movement_behavior_gate_reject_reason(
        source.behavior_id,
        destination.behavior_id,
        facing,
        traversal_context,
    ) {
        trace_walk_attempt(facing, source, destination, reason);
        return MoveValidation::Rejected {
            reason: MoveRejectReason::ForcedMovementDisabled,
            collision: CollisionOutcome::None,
        };
    }

    trace_walk_attempt(facing, source, destination, "accepted: standard_walk");

    MoveValidation::Accepted {
        next_x: destination.x as u16,
        next_y: destination.y as u16,
        collision,
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

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum PlayerSpeed {
    Standing,
    Normal,
    Fast,
    Faster,
    Fastest,
}

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

pub const fn player_speed_step_speed(speed: PlayerSpeed) -> StepSpeed {
    match speed {
        PlayerSpeed::Standing | PlayerSpeed::Normal => StepSpeed::Step1,
        PlayerSpeed::Fast => StepSpeed::Step2,
        PlayerSpeed::Faster => StepSpeed::Step3,
        PlayerSpeed::Fastest => StepSpeed::Step4,
    }
}

pub const fn mach_speed_tier_for_frame_counter(bike_frame_counter: u8) -> PlayerSpeed {
    match bike_frame_counter {
        0 => PlayerSpeed::Normal,
        1 => PlayerSpeed::Fast,
        _ => PlayerSpeed::Fastest,
    }
}

pub const fn get_player_speed(
    traversal_state: TraversalState,
    movement_mode: MovementMode,
    bike_frame_counter: u8,
    acro_substate: Option<AcroBikeSubstate>,
) -> PlayerSpeed {
    match traversal_state {
        TraversalState::OnFoot => {
            if matches!(movement_mode, MovementMode::Run) {
                PlayerSpeed::Fast
            } else {
                PlayerSpeed::Normal
            }
        }
        TraversalState::MachBike => mach_speed_tier_for_frame_counter(bike_frame_counter),
        TraversalState::AcroBike => {
            match acro_substate {
                Some(AcroBikeSubstate::BunnyHop) => PlayerSpeed::Normal,
                Some(AcroBikeSubstate::MovingWheelie) => PlayerSpeed::Fast,
                _ => PlayerSpeed::Faster,
            }
        }
    }
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
        MB_TRICK_HOUSE_PUZZLE_8_FLOOR => Some(ForcedMovementClass::TrickHouseSlippery),
        MB_SECRET_BASE_JUMP_MAT => Some(ForcedMovementClass::SecretBaseJumpMat),
        MB_SECRET_BASE_SPIN_MAT => Some(ForcedMovementClass::SecretBaseSpinMat),
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
        ForcedMovementClass::TrickHouseSlippery => {
            "rejected: trick_house_slippery_tile_pending_phase1_parity"
        }
        ForcedMovementClass::SecretBaseJumpMat => {
            "rejected: secret_base_jump_mat_pending_phase1_parity"
        }
        ForcedMovementClass::SecretBaseSpinMat => {
            "rejected: secret_base_spin_mat_pending_phase1_parity"
        }
    }
}

fn forced_movement_gate_reject_reason(
    class: ForcedMovementClass,
    traversal_context: TraversalContext,
) -> Option<&'static str> {
    match class {
        ForcedMovementClass::Current | ForcedMovementClass::Slide | ForcedMovementClass::Ice => {
            match traversal_context.traversal_state {
                TraversalState::MachBike => None,
                TraversalState::AcroBike => {
                    if matches!(
                        traversal_context.acro_substate,
                        Some(AcroBikeSubstate::BunnyHop)
                    ) {
                        Some("rejected: forced_tile_requires_grounded_acro_state")
                    } else {
                        None
                    }
                }
                TraversalState::OnFoot => Some(forced_movement_reject_reason(class)),
            }
        }
        _ => Some(forced_movement_reject_reason(class)),
    }
}

fn classify_collision(destination: TileQuery, facing: Direction) -> CollisionClass {
    if destination.collision_bits != 0 {
        return CollisionClass::Impassable;
    }

    match destination.behavior_id {
        MB_JUMP_EAST | MB_JUMP_WEST | MB_JUMP_NORTH | MB_JUMP_SOUTH | MB_JUMP_NORTHEAST
        | MB_JUMP_NORTHWEST | MB_JUMP_SOUTHEAST | MB_JUMP_SOUTHWEST => {
            if ledge_allows_direction(destination.behavior_id, facing) {
                CollisionClass::LedgeJump
            } else {
                CollisionClass::Impassable
            }
        }
        MB_BUMPY_SLOPE => CollisionClass::WheelieHop,
        MB_ISOLATED_VERTICAL_RAIL => CollisionClass::IsolatedVerticalRail,
        MB_ISOLATED_HORIZONTAL_RAIL => CollisionClass::IsolatedHorizontalRail,
        MB_VERTICAL_RAIL => CollisionClass::VerticalRail,
        MB_HORIZONTAL_RAIL => CollisionClass::HorizontalRail,
        _ => CollisionClass::None,
    }
}

fn ledge_allows_direction(behavior_id: u8, facing: Direction) -> bool {
    match behavior_id {
        MB_JUMP_EAST => matches!(facing, Direction::Right),
        MB_JUMP_WEST => matches!(facing, Direction::Left),
        MB_JUMP_NORTH => matches!(facing, Direction::Up),
        MB_JUMP_SOUTH => matches!(facing, Direction::Down),
        MB_JUMP_NORTHEAST => matches!(facing, Direction::Up | Direction::Right),
        MB_JUMP_NORTHWEST => matches!(facing, Direction::Up | Direction::Left),
        MB_JUMP_SOUTHEAST => matches!(facing, Direction::Down | Direction::Right),
        MB_JUMP_SOUTHWEST => matches!(facing, Direction::Down | Direction::Left),
        _ => false,
    }
}

fn collision_class_outcome(collision: CollisionClass) -> CollisionOutcome {
    match collision {
        CollisionClass::None => CollisionOutcome::None,
        CollisionClass::Impassable => CollisionOutcome::Impassable,
        CollisionClass::LedgeJump => CollisionOutcome::LedgeJump,
        CollisionClass::WheelieHop => CollisionOutcome::WheelieHop,
        CollisionClass::IsolatedVerticalRail => {
            CollisionOutcome::Rail(RailCollisionClass::IsolatedVertical)
        }
        CollisionClass::IsolatedHorizontalRail => {
            CollisionOutcome::Rail(RailCollisionClass::IsolatedHorizontal)
        }
        CollisionClass::VerticalRail => CollisionOutcome::Rail(RailCollisionClass::Vertical),
        CollisionClass::HorizontalRail => CollisionOutcome::Rail(RailCollisionClass::Horizontal),
    }
}

fn collision_reject_reason(
    collision: CollisionClass,
    traversal_context: TraversalContext,
) -> Option<&'static str> {
    match collision {
        CollisionClass::None => None,
        CollisionClass::Impassable => Some("rejected: impassable_collision"),
        CollisionClass::LedgeJump => None,
        CollisionClass::WheelieHop => {
            if matches!(traversal_context.traversal_state, TraversalState::AcroBike)
                && matches!(
                    traversal_context.acro_substate,
                    Some(AcroBikeSubstate::BunnyHop)
                )
            {
                None
            } else {
                Some("rejected: wheelie_hop_requires_acro_bunny_hop")
            }
        }
        CollisionClass::IsolatedVerticalRail | CollisionClass::VerticalRail => {
            if matches!(traversal_context.traversal_state, TraversalState::OnFoot) {
                Some("rejected: vertical_rail_requires_bike")
            } else {
                None
            }
        }
        CollisionClass::IsolatedHorizontalRail | CollisionClass::HorizontalRail => {
            if matches!(traversal_context.traversal_state, TraversalState::OnFoot) {
                Some("rejected: horizontal_rail_requires_bike")
            } else {
                None
            }
        }
    }
}

fn can_bike_face_dir_on_metatile(direction: Direction, tile_behavior: u8) -> bool {
    if !matches!(
        tile_behavior,
        MB_ISOLATED_VERTICAL_RAIL
            | MB_ISOLATED_HORIZONTAL_RAIL
            | MB_VERTICAL_RAIL
            | MB_HORIZONTAL_RAIL
    ) {
        return true;
    }

    match direction {
        Direction::Left | Direction::Right => {
            !matches!(tile_behavior, MB_ISOLATED_VERTICAL_RAIL | MB_VERTICAL_RAIL)
        }
        Direction::Up | Direction::Down => !matches!(
            tile_behavior,
            MB_ISOLATED_HORIZONTAL_RAIL | MB_HORIZONTAL_RAIL
        ),
    }
}

pub fn is_biking_disallowed_by_player(facing: Direction, tile_behavior: u8) -> bool {
    !can_bike_face_dir_on_metatile(facing, tile_behavior)
}

fn movement_behavior_gate_reject_reason(
    source_behavior_id: u8,
    _destination_behavior_id: u8,
    _facing: Direction,
    traversal_context: TraversalContext,
) -> Option<&'static str> {
    if source_behavior_id == MB_BUMPY_SLOPE
        && !matches!(traversal_context.traversal_state, TraversalState::AcroBike)
    {
        return Some("rejected: bumpy_slope_requires_acro");
    }

    None
}

pub fn should_force_muddy_slope_slide_back(
    source_behavior_id: u8,
    facing: Direction,
    player_speed: PlayerSpeed,
) -> bool {
    source_behavior_id == MB_MUDDY_SLOPE
        && !(matches!(facing, Direction::Up) && matches!(player_speed, PlayerSpeed::Fastest))
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

    fn on_foot_walk() -> TraversalContext {
        TraversalContext {
            traversal_state: TraversalState::OnFoot,
            movement_mode: MovementMode::Walk,
            bike_frame_counter: 0,
            acro_substate: None,
        }
    }

    fn mach_bike() -> TraversalContext {
        TraversalContext {
            traversal_state: TraversalState::MachBike,
            movement_mode: MovementMode::Walk,
            bike_frame_counter: 2,
            acro_substate: None,
        }
    }

    fn acro_bike(substate: AcroBikeSubstate) -> TraversalContext {
        TraversalContext {
            traversal_state: TraversalState::AcroBike,
            movement_mode: MovementMode::Walk,
            bike_frame_counter: 0,
            acro_substate: Some(substate),
        }
    }

    #[test]
    fn accepts_basic_walk() {
        let result = validate_walk_with_context(
            0,
            0,
            Direction::Right,
            map(&[0, 0, 0, 0], &[0, 0, 0, 0]),
            None,
            on_foot_walk(),
        );
        assert_eq!(
            result,
            MoveValidation::Accepted {
                next_x: 1,
                next_y: 0,
                collision: CollisionOutcome::None,
            }
        );
    }

    #[test]
    fn rejects_collision_tiles() {
        let result = validate_walk_with_context(
            0,
            0,
            Direction::Right,
            map(&[0, 1, 0, 0], &[0, 0, 0, 0]),
            None,
            on_foot_walk(),
        );
        assert_eq!(
            result,
            MoveValidation::Rejected {
                reason: MoveRejectReason::Collision,
                collision: CollisionOutcome::Impassable,
            }
        );
    }

    #[test]
    fn rejects_out_of_bounds_tiles() {
        let result = validate_walk_with_context(
            0,
            0,
            Direction::Up,
            map(&[0, 0, 0, 0], &[0, 0, 0, 0]),
            None,
            on_foot_walk(),
        );
        assert_eq!(
            result,
            MoveValidation::Rejected {
                reason: MoveRejectReason::OutOfBounds,
                collision: CollisionOutcome::None,
            }
        );
    }

    #[test]
    fn accepts_connected_destinations() {
        let result = validate_walk_with_context(
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
            on_foot_walk(),
        );
        assert_eq!(
            result,
            MoveValidation::Accepted {
                next_x: 1,
                next_y: 1,
                collision: CollisionOutcome::None,
            }
        );
    }

    #[test]
    fn rejects_forced_movement_tiles_in_phase1() {
        let result = validate_walk_with_context(
            0,
            0,
            Direction::Right,
            map(&[0, 0, 0, 0], &[0, MB_WALK_EAST, 0, 0]),
            None,
            on_foot_walk(),
        );
        assert_eq!(
            result,
            MoveValidation::Rejected {
                reason: MoveRejectReason::ForcedMovementDisabled,
                collision: CollisionOutcome::None,
            }
        );
    }

    #[test]
    fn accepts_mach_bike_traversal_into_current_tile() {
        let result = validate_walk_with_context(
            0,
            0,
            Direction::Right,
            map(&[0, 0, 0, 0], &[0, MB_EASTWARD_CURRENT, 0, 0]),
            None,
            mach_bike(),
        );
        assert_eq!(
            result,
            MoveValidation::Accepted {
                next_x: 1,
                next_y: 0,
                collision: CollisionOutcome::None,
            }
        );
    }

    #[test]
    fn rejects_on_foot_traversal_into_current_tile() {
        let result = validate_walk_with_context(
            0,
            0,
            Direction::Right,
            map(&[0, 0, 0, 0], &[0, MB_EASTWARD_CURRENT, 0, 0]),
            None,
            on_foot_walk(),
        );
        assert_eq!(
            result,
            MoveValidation::Rejected {
                reason: MoveRejectReason::ForcedMovementDisabled,
                collision: CollisionOutcome::None,
            }
        );
    }

    #[test]
    fn rejects_acro_bunny_hop_into_current_tile() {
        let result = validate_walk_with_context(
            0,
            0,
            Direction::Right,
            map(&[0, 0, 0, 0], &[0, MB_EASTWARD_CURRENT, 0, 0]),
            None,
            acro_bike(AcroBikeSubstate::BunnyHop),
        );
        assert_eq!(
            result,
            MoveValidation::Rejected {
                reason: MoveRejectReason::ForcedMovementDisabled,
                collision: CollisionOutcome::None,
            }
        );
    }

    #[test]
    fn accepts_acro_grounded_into_ice_tile() {
        let result = validate_walk_with_context(
            0,
            0,
            Direction::Right,
            map(&[0, 0, 0, 0], &[0, MB_ICE, 0, 0]),
            None,
            acro_bike(AcroBikeSubstate::MovingWheelie),
        );
        assert_eq!(
            result,
            MoveValidation::Accepted {
                next_x: 1,
                next_y: 0,
                collision: CollisionOutcome::None,
            }
        );
    }

    #[test]
    fn accepts_mach_bike_when_starting_on_slide_tile() {
        let result = validate_walk_with_context(
            0,
            0,
            Direction::Right,
            map(&[0, 0, 0, 0], &[MB_SLIDE_EAST, 0, 0, 0]),
            None,
            mach_bike(),
        );
        assert_eq!(
            result,
            MoveValidation::Accepted {
                next_x: 1,
                next_y: 0,
                collision: CollisionOutcome::None,
            }
        );
    }

    #[test]
    fn accepts_cracked_floor_tiles_even_when_not_fastest() {
        let result = validate_walk_with_context(
            0,
            0,
            Direction::Right,
            map(&[0, 0, 0, 0], &[0, MB_CRACKED_FLOOR, 0, 0]),
            None,
            on_foot_walk(),
        );
        assert_eq!(
            result,
            MoveValidation::Accepted {
                next_x: 1,
                next_y: 0,
                collision: CollisionOutcome::None,
            }
        );
    }

    #[test]
    fn ledge_jump_allows_matching_direction_and_rejects_other_directions() {
        let accepted = validate_walk_with_context(
            0,
            0,
            Direction::Right,
            map(&[0, 0, 0, 0], &[0, MB_JUMP_EAST, 0, 0]),
            None,
            on_foot_walk(),
        );
        assert_eq!(
            accepted,
            MoveValidation::Accepted {
                next_x: 1,
                next_y: 0,
                collision: CollisionOutcome::LedgeJump,
            }
        );

        let rejected = validate_walk_with_context(
            0,
            0,
            Direction::Down,
            map(&[0, 0, 0, 0], &[0, 0, MB_JUMP_EAST, 0]),
            None,
            on_foot_walk(),
        );
        assert_eq!(
            rejected,
            MoveValidation::Rejected {
                reason: MoveRejectReason::Collision,
                collision: CollisionOutcome::Impassable,
            }
        );
    }

    #[test]
    fn rails_return_structured_collision_outcome() {
        let on_foot = validate_walk_with_context(
            0,
            0,
            Direction::Right,
            map(&[0, 0, 0, 0], &[0, MB_VERTICAL_RAIL, 0, 0]),
            None,
            on_foot_walk(),
        );
        assert_eq!(
            on_foot,
            MoveValidation::Rejected {
                reason: MoveRejectReason::Collision,
                collision: CollisionOutcome::Rail(RailCollisionClass::Vertical),
            }
        );

        let on_bike = validate_walk_with_context(
            0,
            0,
            Direction::Right,
            map(&[0, 0, 0, 0], &[0, MB_VERTICAL_RAIL, 0, 0]),
            None,
            TraversalContext {
                traversal_state: TraversalState::MachBike,
                movement_mode: MovementMode::Walk,
                bike_frame_counter: 0,
                acro_substate: None,
            },
        );
        assert_eq!(
            on_bike,
            MoveValidation::Accepted {
                next_x: 1,
                next_y: 0,
                collision: CollisionOutcome::Rail(RailCollisionClass::Vertical),
            }
        );
    }

    #[test]
    fn bumpy_slope_collision_requires_bunny_hop_and_reports_outcome() {
        let blocked = validate_walk_with_context(
            0,
            0,
            Direction::Right,
            map(&[0, 0, 0, 0], &[0, MB_BUMPY_SLOPE, 0, 0]),
            None,
            TraversalContext {
                traversal_state: TraversalState::AcroBike,
                movement_mode: MovementMode::Walk,
                bike_frame_counter: 0,
                acro_substate: Some(AcroBikeSubstate::MovingWheelie),
            },
        );
        assert_eq!(
            blocked,
            MoveValidation::Rejected {
                reason: MoveRejectReason::Collision,
                collision: CollisionOutcome::WheelieHop,
            }
        );

        let allowed = validate_walk_with_context(
            0,
            0,
            Direction::Right,
            map(&[0, 0, 0, 0], &[0, MB_BUMPY_SLOPE, 0, 0]),
            None,
            TraversalContext {
                traversal_state: TraversalState::AcroBike,
                movement_mode: MovementMode::Walk,
                bike_frame_counter: 0,
                acro_substate: Some(AcroBikeSubstate::BunnyHop),
            },
        );
        assert_eq!(
            allowed,
            MoveValidation::Accepted {
                next_x: 1,
                next_y: 0,
                collision: CollisionOutcome::WheelieHop,
            }
        );
    }

    #[test]
    fn muddy_slope_forces_slide_back_on_foot() {
        assert!(should_force_muddy_slope_slide_back(
            MB_MUDDY_SLOPE,
            Direction::Up,
            PlayerSpeed::Normal
        ));
    }

    #[test]
    fn muddy_slope_forces_slide_back_for_mach_insufficient_speed() {
        assert!(should_force_muddy_slope_slide_back(
            MB_MUDDY_SLOPE,
            Direction::Up,
            PlayerSpeed::Faster
        ));
    }

    #[test]
    fn muddy_slope_allows_fastest_north_on_mach() {
        assert!(!should_force_muddy_slope_slide_back(
            MB_MUDDY_SLOPE,
            Direction::Up,
            PlayerSpeed::Fastest
        ));
    }

    #[test]
    fn acro_bunny_hop_uses_normal_speed_tier() {
        assert_eq!(
            get_player_speed(
                TraversalState::AcroBike,
                MovementMode::Walk,
                0,
                Some(AcroBikeSubstate::BunnyHop)
            ),
            PlayerSpeed::Normal
        );
        assert_eq!(
            player_speed_step_speed(PlayerSpeed::Normal),
            StepSpeed::Step1
        );
    }

    #[test]
    fn acro_moving_wheelie_uses_fast_speed_tier() {
        assert_eq!(
            get_player_speed(
                TraversalState::AcroBike,
                MovementMode::Walk,
                0,
                Some(AcroBikeSubstate::MovingWheelie)
            ),
            PlayerSpeed::Fast
        );
        assert_eq!(player_speed_step_speed(PlayerSpeed::Fast), StepSpeed::Step2);
    }

    #[test]
    fn acro_non_wheelie_grounded_uses_faster_speed_tier() {
        assert_eq!(
            get_player_speed(TraversalState::AcroBike, MovementMode::Walk, 0, None),
            PlayerSpeed::Faster
        );
        assert_eq!(
            get_player_speed(
                TraversalState::AcroBike,
                MovementMode::Walk,
                0,
                Some(AcroBikeSubstate::StandingWheelie)
            ),
            PlayerSpeed::Faster
        );
        assert_eq!(
            player_speed_step_speed(PlayerSpeed::Faster),
            StepSpeed::Step3
        );
    }
}

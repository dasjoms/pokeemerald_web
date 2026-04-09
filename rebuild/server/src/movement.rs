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
    WheelieHop,
    IsolatedVerticalRail,
    IsolatedHorizontalRail,
    VerticalRail,
    HorizontalRail,
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
        return MoveValidation::Rejected(MoveRejectReason::OutOfBounds);
    };

    if !can_bike_face_dir_on_metatile(facing, source.behavior_id) {
        trace_walk_attempt(
            facing,
            source,
            destination,
            "rejected: bike_dir_not_allowed_for_current_rail",
        );
        return MoveValidation::Rejected(MoveRejectReason::Collision);
    }

    let collision_class = classify_collision(destination);
    if collision_reject_reason(collision_class, traversal_context).is_some() {
        trace_walk_attempt(
            facing,
            source,
            destination,
            collision_reject_reason(collision_class, traversal_context)
                .expect("checked is_some above"),
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

    if let Some(reason) = movement_behavior_gate_reject_reason(
        source.behavior_id,
        destination.behavior_id,
        facing,
        traversal_context,
    ) {
        trace_walk_attempt(facing, source, destination, reason);
        return MoveValidation::Rejected(MoveRejectReason::ForcedMovementDisabled);
    }

    trace_walk_attempt(facing, source, destination, "accepted: standard_walk");

    MoveValidation::Accepted {
        next_x: destination.x as u16,
        next_y: destination.y as u16,
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
        TraversalState::AcroBike => PlayerSpeed::Faster,
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

fn classify_collision(destination: TileQuery) -> CollisionClass {
    if destination.collision_bits != 0 {
        return CollisionClass::Impassable;
    }

    match destination.behavior_id {
        MB_BUMPY_SLOPE => CollisionClass::WheelieHop,
        MB_ISOLATED_VERTICAL_RAIL => CollisionClass::IsolatedVerticalRail,
        MB_ISOLATED_HORIZONTAL_RAIL => CollisionClass::IsolatedHorizontalRail,
        MB_VERTICAL_RAIL => CollisionClass::VerticalRail,
        MB_HORIZONTAL_RAIL => CollisionClass::HorizontalRail,
        _ => CollisionClass::None,
    }
}

fn collision_reject_reason(
    collision: CollisionClass,
    traversal_context: TraversalContext,
) -> Option<&'static str> {
    match collision {
        CollisionClass::None => None,
        CollisionClass::Impassable => Some("rejected: impassable_collision"),
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
                next_y: 0
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
            MoveValidation::Rejected(MoveRejectReason::Collision)
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
            MoveValidation::Rejected(MoveRejectReason::OutOfBounds)
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
            MoveValidation::Rejected(MoveRejectReason::ForcedMovementDisabled)
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
                next_y: 0
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
}

use std::{fs, path::PathBuf};

use rebuild_server::{
    bike::{decide_bike_traversal, BikeState, TraversalState},
    movement::{validate_movement, BikeSubstate, ConnectedDestination, MoveValidation, MovementContext, MovementMap},
    protocol::{Direction, MovementMode, RejectionReason},
};
use serde::Deserialize;

#[derive(Debug, Deserialize)]
struct FixtureRoot {
    scenarios: Vec<FixtureScenario>,
}

#[derive(Debug, Deserialize)]
struct FixtureScenario {
    name: String,
    map: FixtureMap,
    initial: FixturePosition,
    inputs: Vec<FixtureInput>,
    expected: FixtureExpectedByMode,
}

#[derive(Debug, Deserialize)]
struct FixtureMap {
    width: u16,
    height: u16,
    default_behavior: u8,
    default_collision: u8,
    #[serde(default)]
    behavior_overrides: Vec<FixtureBehaviorOverride>,
    #[serde(default)]
    collision_overrides: Vec<FixtureCollisionOverride>,
}

#[derive(Debug, Deserialize)]
struct FixtureBehaviorOverride {
    x: u16,
    y: u16,
    behavior_id: u8,
}

#[derive(Debug, Deserialize)]
struct FixtureCollisionOverride {
    x: u16,
    y: u16,
    collision: u8,
}

#[derive(Debug, Deserialize, Clone, Copy)]
struct FixturePosition {
    x: u16,
    y: u16,
    facing: Direction,
}

#[derive(Debug, Deserialize)]
struct FixtureInput {
    seq: u32,
    tick: u64,
    direction: Direction,
    movement_mode: MovementMode,
    connected_destination: Option<FixtureConnectedDestination>,
}

#[derive(Debug, Deserialize, Clone, Copy)]
struct FixtureConnectedDestination {
    x: u16,
    y: u16,
    behavior_id: u8,
    collision_bits: u8,
}

#[derive(Debug, Deserialize)]
struct FixtureExpectedByMode {
    bike: FixtureModeExpected,
    on_foot: FixtureModeExpected,
}

#[derive(Debug, Deserialize)]
struct FixtureModeExpected {
    transitions: Vec<FixtureTransition>,
    #[serde(rename = "final")]
    final_pos: FixturePosition,
}

#[derive(Debug, Deserialize)]
struct FixtureTransition {
    accepted: bool,
    x: u16,
    y: u16,
    facing: Direction,
    reason: RejectionReason,
}

#[derive(Debug)]
struct ReplayTransition {
    input_seq: u32,
    accepted: bool,
    x: u16,
    y: u16,
    facing: Direction,
    reason: RejectionReason,
    movement_mode: MovementMode,
    source_behavior_id: u8,
    destination_behavior_id: u8,
}

#[derive(Debug)]
struct ReplayOutcome {
    transitions: Vec<ReplayTransition>,
    final_pos: FixturePosition,
}

#[test]
fn bike_movement_replay_fixtures_match_authoritative_parity() {
    let repo_root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join("..");
    let fixture_path = repo_root.join("rebuild/tests/fixtures/bike_movement_replay.json");
    let raw = fs::read_to_string(&fixture_path)
        .unwrap_or_else(|_| panic!("failed to read fixture file {}", fixture_path.display()));
    let fixture: FixtureRoot = serde_json::from_str(&raw)
        .unwrap_or_else(|_| panic!("failed to parse fixture file {}", fixture_path.display()));

    assert!(
        !fixture.scenarios.is_empty(),
        "expected at least one bike replay scenario in {}",
        fixture_path.display()
    );

    for scenario in fixture.scenarios {
        let (collision, behavior) = build_map_arrays(&scenario.map);
        let map = MovementMap {
            width: scenario.map.width,
            height: scenario.map.height,
            collision: &collision,
            behavior: &behavior,
        };

        let bike_outcome = replay_scenario(&scenario, map, false);
        let foot_outcome = replay_scenario(&scenario, map, true);

        assert_transitions("bike", &scenario.name, &scenario.expected.bike, &bike_outcome);
        assert_transitions(
            "on_foot",
            &scenario.name,
            &scenario.expected.on_foot,
            &foot_outcome,
        );

        assert_ne!(
            format!("{:?}", bike_outcome.final_pos),
            format!("{:?}", foot_outcome.final_pos),
            "fixture {} should intentionally diverge between bike and on-foot outcomes",
            scenario.name
        );
    }
}

fn replay_scenario(
    scenario: &FixtureScenario,
    map: MovementMap<'_>,
    force_on_foot: bool,
) -> ReplayOutcome {
    let mut x = scenario.initial.x;
    let mut y = scenario.initial.y;
    let mut facing = scenario.initial.facing;
    let mut traversal_state = TraversalState::default();
    let mut transitions = Vec::with_capacity(scenario.inputs.len());

    for input in &scenario.inputs {
        let movement_mode = if force_on_foot {
            MovementMode::Walk
        } else {
            input.movement_mode
        };

        facing = input.direction;

        let source_behavior = behavior_at(map, x as i32, y as i32).unwrap_or(u8::MAX);
        let (dx, dy) = match input.direction {
            Direction::Up => (0, -1),
            Direction::Down => (0, 1),
            Direction::Left => (-1, 0),
            Direction::Right => (1, 0),
        };
        let attempted_x = x as i32 + dx;
        let attempted_y = y as i32 + dy;
        let destination_behavior = if let Some(behavior_id) = behavior_at(map, attempted_x, attempted_y) {
            behavior_id
        } else {
            input
                .connected_destination
                .as_ref()
                .map_or(u8::MAX, |dest| dest.behavior_id)
        };

        let bike_decision = decide_bike_traversal(
            traversal_state,
            movement_mode,
            input.direction,
            source_behavior,
            destination_behavior,
            input.tick,
        );

        let (accepted, reason, next_x, next_y, next_state) = match bike_decision {
            Err(reason) => (false, reason, x, y, traversal_state),
            Ok(decision) => {
                let connected_destination = input.connected_destination.map(|dest| ConnectedDestination {
                    x: dest.x,
                    y: dest.y,
                    collision_bits: dest.collision_bits,
                    behavior_id: dest.behavior_id,
                });
                match validate_movement(
                    x,
                    y,
                    input.direction,
                    map,
                    connected_destination,
                    MovementContext {
                        movement_mode,
                        bike_substate: bike_substate_for_validation(decision.next_state.bike_state),
                    },
                ) {
                    MoveValidation::Accepted { next_x, next_y } => {
                        (true, RejectionReason::None, next_x, next_y, decision.next_state)
                    }
                    MoveValidation::Rejected(reason) => (
                        false,
                        map_reject_reason(reason),
                        x,
                        y,
                        traversal_state,
                    ),
                }
            }
        };

        if accepted {
            x = next_x;
            y = next_y;
            traversal_state = next_state;
        }

        transitions.push(ReplayTransition {
            input_seq: input.seq,
            accepted,
            x,
            y,
            facing,
            reason,
            movement_mode,
            source_behavior_id: source_behavior,
            destination_behavior_id: destination_behavior,
        });
    }

    ReplayOutcome {
        transitions,
        final_pos: FixturePosition { x, y, facing },
    }
}

fn assert_transitions(
    mode_label: &str,
    scenario_name: &str,
    expected: &FixtureModeExpected,
    actual: &ReplayOutcome,
) {
    assert_eq!(
        expected.transitions.len(),
        actual.transitions.len(),
        "fixture {} [{}] transition length drift",
        scenario_name,
        mode_label
    );

    for (idx, (expected_step, actual_step)) in expected
        .transitions
        .iter()
        .zip(actual.transitions.iter())
        .enumerate()
    {
        assert_eq!(
            expected_step.accepted, actual_step.accepted,
            "fixture {} [{}] transition {} acceptance drift: input_seq={} pos=({}, {}) behavior(src={}, dst={}) movement_mode={:?} expected={:?} actual={:?}",
            scenario_name,
            mode_label,
            idx,
            actual_step.input_seq,
            actual_step.x,
            actual_step.y,
            actual_step.source_behavior_id,
            actual_step.destination_behavior_id,
            actual_step.movement_mode,
            expected_step,
            actual_step,
        );
        assert_eq!(
            expected_step.x, actual_step.x,
            "fixture {} [{}] transition {} x drift: input_seq={} behavior(src={}, dst={}) movement_mode={:?} expected={:?} actual={:?}",
            scenario_name,
            mode_label,
            idx,
            actual_step.input_seq,
            actual_step.source_behavior_id,
            actual_step.destination_behavior_id,
            actual_step.movement_mode,
            expected_step,
            actual_step,
        );
        assert_eq!(
            expected_step.y, actual_step.y,
            "fixture {} [{}] transition {} y drift: input_seq={} behavior(src={}, dst={}) movement_mode={:?} expected={:?} actual={:?}",
            scenario_name,
            mode_label,
            idx,
            actual_step.input_seq,
            actual_step.source_behavior_id,
            actual_step.destination_behavior_id,
            actual_step.movement_mode,
            expected_step,
            actual_step,
        );
        assert_eq!(
            expected_step.facing, actual_step.facing,
            "fixture {} [{}] transition {} facing drift: input_seq={} behavior(src={}, dst={}) movement_mode={:?} expected={:?} actual={:?}",
            scenario_name,
            mode_label,
            idx,
            actual_step.input_seq,
            actual_step.source_behavior_id,
            actual_step.destination_behavior_id,
            actual_step.movement_mode,
            expected_step,
            actual_step,
        );
        assert_eq!(
            expected_step.reason, actual_step.reason,
            "fixture {} [{}] transition {} reason drift: input_seq={} behavior(src={}, dst={}) movement_mode={:?} expected={:?} actual={:?}",
            scenario_name,
            mode_label,
            idx,
            actual_step.input_seq,
            actual_step.source_behavior_id,
            actual_step.destination_behavior_id,
            actual_step.movement_mode,
            expected_step,
            actual_step,
        );
    }

    assert_eq!(
        expected.final_pos.x, actual.final_pos.x,
        "fixture {} [{}] final x drift: expected={:?} actual={:?}",
        scenario_name, mode_label, expected.final_pos, actual.final_pos
    );
    assert_eq!(
        expected.final_pos.y, actual.final_pos.y,
        "fixture {} [{}] final y drift: expected={:?} actual={:?}",
        scenario_name, mode_label, expected.final_pos, actual.final_pos
    );
    assert_eq!(
        expected.final_pos.facing, actual.final_pos.facing,
        "fixture {} [{}] final facing drift: expected={:?} actual={:?}",
        scenario_name, mode_label, expected.final_pos, actual.final_pos
    );
}

fn build_map_arrays(map: &FixtureMap) -> (Vec<u8>, Vec<u8>) {
    let len = map.width as usize * map.height as usize;
    let mut collision = vec![map.default_collision; len];
    let mut behavior = vec![map.default_behavior; len];

    for entry in &map.behavior_overrides {
        let idx = index(map.width, map.height, entry.x, entry.y);
        behavior[idx] = entry.behavior_id;
    }
    for entry in &map.collision_overrides {
        let idx = index(map.width, map.height, entry.x, entry.y);
        collision[idx] = entry.collision;
    }

    (collision, behavior)
}

fn index(width: u16, height: u16, x: u16, y: u16) -> usize {
    assert!(x < width && y < height, "fixture tile out of bounds: ({x}, {y}) in {width}x{height}");
    y as usize * width as usize + x as usize
}

fn behavior_at(map: MovementMap<'_>, x: i32, y: i32) -> Option<u8> {
    if x < 0 || y < 0 || x >= map.width as i32 || y >= map.height as i32 {
        return None;
    }
    let idx = y as usize * map.width as usize + x as usize;
    Some(map.behavior[idx])
}

fn bike_substate_for_validation(state: Option<BikeState>) -> BikeSubstate {
    match state {
        Some(BikeState::Mach { .. }) => BikeSubstate::Mach,
        Some(BikeState::AcroNeutral) => BikeSubstate::AcroNeutral,
        Some(BikeState::AcroWheeliePrep { .. }) => BikeSubstate::AcroWheeliePrep,
        Some(BikeState::AcroWheelieMove { .. }) => BikeSubstate::AcroWheelieMove,
        Some(BikeState::AcroHop { .. }) => BikeSubstate::AcroHop,
        None => BikeSubstate::None,
    }
}

fn map_reject_reason(reason: rebuild_server::movement::MoveRejectReason) -> RejectionReason {
    match reason {
        rebuild_server::movement::MoveRejectReason::Collision => RejectionReason::Collision,
        rebuild_server::movement::MoveRejectReason::OutOfBounds => RejectionReason::OutOfBounds,
        rebuild_server::movement::MoveRejectReason::ForcedMovementDisabled => {
            RejectionReason::ForcedMovementDisabled
        }
    }
}

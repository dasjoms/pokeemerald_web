use std::{fs, path::PathBuf};

use rebuild_server::{
    acro::{AcroRuntime, AcroState},
    movement::{validate_walk_with_context, MoveValidation, MovementMap, TraversalContext},
    protocol::{AcroBikeSubstate, Direction, Facing, MovementMode, TraversalState},
};
use serde::Deserialize;

#[derive(Debug, Deserialize)]
struct Fixture {
    name: String,
    map: FixtureMap,
    initial: PositionedFacing,
    inputs: Vec<FixtureInput>,
    expected: Expected,
}

#[derive(Debug, Deserialize)]
struct FixtureMap {
    width: u16,
    height: u16,
    collision: Vec<u8>,
    behavior: Vec<u8>,
}

#[derive(Debug, Deserialize)]
struct PositionedFacing {
    x: u16,
    y: u16,
    facing: Facing,
}

#[derive(Debug, Deserialize)]
struct FixtureInput {
    direction: Option<Facing>,
    hold_b: bool,
}

#[derive(Debug, Deserialize)]
struct Expected {
    attempt_acceptance: Vec<bool>,
    #[serde(rename = "final")]
    final_pos: PositionedFacing,
}

#[test]
fn acro_puzzle_fixture_is_solvable_under_authoritative_validation() {
    let repo_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..");
    let fixture_path = repo_root
        .join("rebuild")
        .join("tests")
        .join("acro_fixtures")
        .join("acro_bumpy_lane_boundary.json");

    let raw = fs::read_to_string(&fixture_path)
        .unwrap_or_else(|_| panic!("failed to read fixture file {}", fixture_path.display()));
    let fixture: Fixture = serde_json::from_str(&raw)
        .unwrap_or_else(|_| panic!("failed to parse fixture file {}", fixture_path.display()));

    let mut runtime = AcroRuntime::default();
    let mut x = fixture.initial.x;
    let mut y = fixture.initial.y;
    let mut facing = fixture.initial.facing;
    let mut acceptance = Vec::new();

    for input in &fixture.inputs {
        let held_direction = input.direction.map(to_direction);
        let idx = y as usize * fixture.map.width as usize + x as usize;
        let on_bumpy_slope = fixture.map.behavior.get(idx).copied().unwrap_or_default() == 0xD1;
        runtime.set_on_bumpy_slope(on_bumpy_slope);
        runtime.set_held_input(held_direction, input.hold_b);
        runtime.advance_tick();

        if let Some(direction) = held_direction {
            let result = validate_walk_with_context(
                x,
                y,
                direction,
                MovementMap {
                    width: fixture.map.width,
                    height: fixture.map.height,
                    collision: &fixture.map.collision,
                    behavior: &fixture.map.behavior,
                },
                None,
                TraversalContext {
                    traversal_state: TraversalState::AcroBike,
                    movement_mode: MovementMode::Walk,
                    bike_frame_counter: runtime.bike_frame_counter,
                    acro_substate: Some(to_protocol_acro_state(runtime.state)),
                },
            );
            match result {
                MoveValidation::Accepted { next_x, next_y, .. } => {
                    x = next_x;
                    y = next_y;
                    acceptance.push(true);
                }
                MoveValidation::Rejected { .. } => {
                    acceptance.push(false);
                }
            }

            runtime.apply_step(direction, direction);
            facing = input
                .direction
                .expect("direction should be present when step attempted");
        }
    }

    assert_eq!(
        acceptance, fixture.expected.attempt_acceptance,
        "fixture {} acceptance sequence drifted",
        fixture.name
    );
    assert_eq!(
        x, fixture.expected.final_pos.x,
        "fixture {} final x drift",
        fixture.name
    );
    assert_eq!(
        y, fixture.expected.final_pos.y,
        "fixture {} final y drift",
        fixture.name
    );
    assert_eq!(
        facing, fixture.expected.final_pos.facing,
        "fixture {} final facing drift",
        fixture.name
    );
}

fn to_direction(facing: Facing) -> Direction {
    match facing {
        Facing::Up => Direction::Up,
        Facing::Down => Direction::Down,
        Facing::Left => Direction::Left,
        Facing::Right => Direction::Right,
    }
}

fn to_protocol_acro_state(state: AcroState) -> AcroBikeSubstate {
    match state {
        AcroState::WheelieStanding => AcroBikeSubstate::StandingWheelie,
        AcroState::WheelieMoving => AcroBikeSubstate::MovingWheelie,
        AcroState::BunnyHop => AcroBikeSubstate::BunnyHop,
        _ => AcroBikeSubstate::None,
    }
}

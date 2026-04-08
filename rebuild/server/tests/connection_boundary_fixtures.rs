use std::{fs, path::PathBuf};

use rebuild_server::{
    movement::{
        validate_walk, ConnectedDestination, MoveRejectReason, MoveValidation, MovementMap,
    },
    protocol::Direction,
};
use serde::Deserialize;

#[derive(Debug, Deserialize)]
struct Fixture {
    name: String,
    source: FixtureMap,
    target: FixtureMap,
    connection: FixtureConnection,
    start: FixturePos,
    input: String,
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
struct FixtureConnection {
    direction: String,
    offset: i32,
}

#[derive(Debug, Deserialize)]
struct FixturePos {
    x: u16,
    y: u16,
}

#[derive(Debug, Deserialize)]
struct Expected {
    accepted: bool,
    x: Option<u16>,
    y: Option<u16>,
    reason: Option<String>,
}

#[test]
fn boundary_connection_fixtures_match_parity_expectations() {
    let repo_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..");
    let fixture_dir = repo_root.join("rebuild/tests/connection_fixtures");

    let mut fixture_paths = fs::read_dir(&fixture_dir)
        .expect("fixture directory should exist")
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.extension().is_some_and(|ext| ext == "json"))
        .collect::<Vec<_>>();
    fixture_paths.sort();

    for path in fixture_paths {
        let raw = fs::read_to_string(&path)
            .unwrap_or_else(|_| panic!("failed to read fixture file {}", path.display()));
        let fixture: Fixture = serde_json::from_str(&raw)
            .unwrap_or_else(|_| panic!("failed to parse fixture file {}", path.display()));

        let connected_destination = resolve_connected_destination(&fixture);
        let input = parse_direction(&fixture.input);
        let result = validate_walk(
            fixture.start.x,
            fixture.start.y,
            input,
            MovementMap {
                width: fixture.source.width,
                height: fixture.source.height,
                collision: &fixture.source.collision,
                behavior: &fixture.source.behavior,
            },
            connected_destination,
        );

        match result {
            MoveValidation::Accepted { next_x, next_y } => {
                assert!(
                    fixture.expected.accepted,
                    "fixture {} unexpectedly accepted",
                    fixture.name
                );
                assert_eq!(
                    fixture.expected.x,
                    Some(next_x),
                    "fixture {} x drift",
                    fixture.name
                );
                assert_eq!(
                    fixture.expected.y,
                    Some(next_y),
                    "fixture {} y drift",
                    fixture.name
                );
            }
            MoveValidation::Rejected(reason) => {
                assert!(
                    !fixture.expected.accepted,
                    "fixture {} unexpectedly rejected",
                    fixture.name
                );
                if fixture.expected.reason.as_deref() == Some("out_of_bounds") {
                    assert_eq!(
                        reason,
                        MoveRejectReason::OutOfBounds,
                        "fixture {} reject reason drift",
                        fixture.name
                    );
                }
            }
        }
    }
}

fn resolve_connected_destination(fixture: &Fixture) -> Option<ConnectedDestination> {
    let connection_direction = parse_direction(&fixture.connection.direction);
    let input_direction = parse_direction(&fixture.input);

    if connection_direction != input_direction {
        return None;
    }

    let (dest_x, dest_y) = match connection_direction {
        Direction::Left => (
            fixture.target.width as i32 - 1,
            fixture.start.y as i32 - fixture.connection.offset,
        ),
        Direction::Right => (0, fixture.start.y as i32 - fixture.connection.offset),
        Direction::Up => (
            fixture.start.x as i32 - fixture.connection.offset,
            fixture.target.height as i32 - 1,
        ),
        Direction::Down => (fixture.start.x as i32 - fixture.connection.offset, 0),
    };

    if dest_x < 0
        || dest_y < 0
        || dest_x >= fixture.target.width as i32
        || dest_y >= fixture.target.height as i32
    {
        return None;
    }

    let index = dest_y as usize * fixture.target.width as usize + dest_x as usize;
    Some(ConnectedDestination {
        x: dest_x as u16,
        y: dest_y as u16,
        collision_bits: fixture.target.collision[index],
        behavior_id: fixture.target.behavior[index],
    })
}

fn parse_direction(direction: &str) -> Direction {
    match direction {
        "up" => Direction::Up,
        "down" => Direction::Down,
        "left" => Direction::Left,
        "right" => Direction::Right,
        _ => panic!("unsupported fixture direction: {direction}"),
    }
}

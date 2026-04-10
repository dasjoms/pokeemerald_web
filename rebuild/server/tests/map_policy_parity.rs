use std::path::PathBuf;

use rebuild_server::{
    movement::{validate_walk, MoveValidation, MovementMap},
    protocol::{Direction, HeldInputState, MovementMode, ServerMessage, WalkInput},
    world::World,
};
use serde::Deserialize;
use tokio::sync::mpsc;

fn test_asset_paths() -> (String, String) {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..");
    (
        root.join("assets/maps_index.json")
            .to_string_lossy()
            .into_owned(),
        root.join("assets/layouts_index.json")
            .to_string_lossy()
            .into_owned(),
    )
}

fn fixture_path(name: &str) -> String {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("tests")
        .join("fixtures")
        .join(name)
        .to_string_lossy()
        .into_owned()
}

#[derive(Debug, Deserialize)]
struct CrackedFloorLaneFixture {
    name: String,
    map_id: String,
    tiles: Vec<[u16; 2]>,
}

fn reverse(direction: Direction) -> Direction {
    match direction {
        Direction::Up => Direction::Down,
        Direction::Down => Direction::Up,
        Direction::Left => Direction::Right,
        Direction::Right => Direction::Left,
    }
}

fn find_reversible_direction(world: &World, map_id: &str, x: u16, y: u16) -> Direction {
    let map = world.map(map_id).expect("map should be loaded");

    [
        Direction::Up,
        Direction::Down,
        Direction::Left,
        Direction::Right,
    ]
    .into_iter()
    .find(|direction| {
        let MoveValidation::Accepted { next_x, next_y, .. } = validate_walk(
            x,
            y,
            *direction,
            MovementMap {
                width: map.width,
                height: map.height,
                collision: &map.collision,
                behavior: &map.behavior,
            },
            None,
        ) else {
            return false;
        };

        matches!(
            validate_walk(
                next_x,
                next_y,
                reverse(*direction),
                MovementMap {
                    width: map.width,
                    height: map.height,
                    collision: &map.collision,
                    behavior: &map.behavior,
                },
                None,
            ),
            MoveValidation::Accepted { .. }
        )
    })
    .expect("spawn should have a reversible walking direction")
}

async fn second_accepted_tick_for_run_inputs(initial_map_id: &str) -> u32 {
    let (maps_index, layouts_index) = test_asset_paths();
    let world = World::load_from_assets(initial_map_id, &maps_index, &layouts_index)
        .expect("world should load from test assets");

    let (tx, mut rx) = mpsc::unbounded_channel();
    let session = world
        .create_session(tx)
        .await
        .expect("session should be created");

    world
        .join_session(session.connection_id, "policy-parity")
        .await
        .expect("session should join");

    while let Ok(_message) = rx.try_recv() {}

    let current = session.player_state;
    let direction =
        find_reversible_direction(&world, &current.map_id, current.tile_x, current.tile_y);
    let opposite = reverse(direction);

    world
        .enqueue_held_input_state(
            session.connection_id,
            HeldInputState {
                input_seq: 0,
                held_direction: Some(direction),
                held_buttons: 0,
                client_time: 0,
            },
        )
        .await
        .expect("first held input should queue");
    world
        .enqueue_walk_input(
            session.connection_id,
            WalkInput {
                direction,
                movement_mode: MovementMode::Run,
                held_buttons: 0,
                input_seq: 0,
                client_time: 0,
            },
        )
        .await
        .expect("first run input should queue");

    let mut first_step_accepted = false;
    let mut second_step_enqueued = false;
    let mut second_tick = None;
    for tick_index in 1..=64 {
        world.tick().await;

        while let Ok(message) = rx.try_recv() {
            if let ServerMessage::WalkResult(result) = message {
                if result.accepted && result.input_seq == 0 {
                    first_step_accepted = true;
                }
                if result.accepted && result.input_seq == 1 {
                    second_tick = Some(tick_index);
                    break;
                }
            }
        }

        if first_step_accepted && !second_step_enqueued {
            world
                .enqueue_held_input_state(
                    session.connection_id,
                    HeldInputState {
                        input_seq: 1,
                        held_direction: Some(opposite),
                        held_buttons: 0,
                        client_time: tick_index as u64,
                    },
                )
                .await
                .expect("second held input should queue");
            world
                .enqueue_walk_input(
                    session.connection_id,
                    WalkInput {
                        direction: opposite,
                        movement_mode: MovementMode::Run,
                        held_buttons: 0,
                        input_seq: 1,
                        client_time: tick_index as u64,
                    },
                )
                .await
                .expect("second run input should queue");
            second_step_enqueued = true;
        }

        if second_tick.is_some() {
            break;
        }
    }

    second_tick.expect("queued second input should eventually resolve")
}

#[tokio::test]
async fn maps_index_exposes_disallow_cycling_running_for_indoor_shop_and_puzzle_maps() {
    let (maps_index, layouts_index) = test_asset_paths();

    let explicit_disallow_maps = [
        "MAP_OLDALE_TOWN_MART",
        "MAP_MAUVILLE_CITY_BIKE_SHOP",
        "MAP_ROUTE110_TRICK_HOUSE_PUZZLE1",
    ];

    for map_id in explicit_disallow_maps {
        let world = World::load_from_assets(map_id, &maps_index, &layouts_index)
            .expect("world should load from test assets");
        let map = world.map(map_id).expect("target map should be loaded");

        assert!(
            !map.allow_cycling,
            "{map_id} should explicitly disallow cycling"
        );
        assert!(
            !map.allow_running,
            "{map_id} should explicitly disallow running"
        );
    }
}

#[tokio::test]
async fn run_inputs_fallback_to_walk_timing_when_running_is_disallowed() {
    let second_tick = second_accepted_tick_for_run_inputs("MAP_OLDALE_TOWN_MART").await;
    assert_eq!(second_tick, 17);
}

#[tokio::test]
async fn run_inputs_keep_run_timing_when_running_is_allowed() {
    let second_tick = second_accepted_tick_for_run_inputs("MAP_LITTLEROOT_TOWN").await;
    assert_eq!(second_tick, 9);
}

#[tokio::test]
async fn sky_pillar_cracked_floor_lane_fixtures_match_behavior_tiles() {
    let (maps_index, layouts_index) = test_asset_paths();
    let fixture_raw = std::fs::read_to_string(fixture_path("sky_pillar_cracked_floor_lanes.json"))
        .expect("fixture file should be readable");
    let fixtures: Vec<CrackedFloorLaneFixture> =
        serde_json::from_str(&fixture_raw).expect("fixture file should parse");

    for fixture in fixtures {
        let world = World::load_from_assets(&fixture.map_id, &maps_index, &layouts_index)
            .expect("world should load for sky pillar fixture");
        let map = world
            .map(&fixture.map_id)
            .expect("fixture map should be loaded");

        for [x, y] in fixture.tiles {
            let index = y as usize * map.width as usize + x as usize;
            let behavior = map
                .behavior
                .get(index)
                .copied()
                .expect("fixture coordinate should stay in bounds");
            assert_eq!(
                behavior, 0xD2,
                "fixture {} tile ({x}, {y}) drifted from cracked-floor behavior in {}",
                fixture.name, fixture.map_id
            );
        }
    }
}

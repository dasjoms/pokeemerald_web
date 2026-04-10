use std::path::PathBuf;

use rebuild_server::{
    movement::{validate_walk, MoveValidation, MovementMap},
    protocol::{
        Direction, HeldInputState, MovementMode, RejectionReason, ServerMessage, WalkInput,
    },
    world::World,
};
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

#[tokio::test]
async fn accepted_walk_result_reports_destination_coordinates_immediately() {
    let (maps_index, layouts_index) = test_asset_paths();
    let world = World::load_from_assets("MAP_LITTLEROOT_TOWN", &maps_index, &layouts_index)
        .expect("world should load from test assets");

    let (tx, mut rx) = mpsc::unbounded_channel();
    let session = world
        .create_session(tx)
        .await
        .expect("session should be created");

    world
        .join_session(session.connection_id, "test-player")
        .await
        .expect("session should join");

    while let Ok(_message) = rx.try_recv() {}

    let current = session.player_state;
    let map = world
        .map(&current.map_id)
        .expect("initial map should be loaded");

    let accepted_direction = [
        Direction::Up,
        Direction::Down,
        Direction::Left,
        Direction::Right,
    ]
    .into_iter()
    .find_map(|direction| {
        match validate_walk(
            current.tile_x,
            current.tile_y,
            direction,
            MovementMap {
                width: map.width,
                height: map.height,
                collision: &map.collision,
                behavior: &map.behavior,
            },
            None,
        ) {
            MoveValidation::Accepted { next_x, next_y, .. } => Some((direction, next_x, next_y)),
            MoveValidation::Rejected { .. } => None,
        }
    })
    .expect("spawn must have at least one walkable adjacent tile");

    world
        .enqueue_held_input_state(
            session.connection_id,
            HeldInputState {
                input_seq: 0,
                held_dpad: rebuild_server::protocol::direction_to_held_dpad_mask(accepted_direction.0),
                held_buttons: 0,
                client_time: 0,
            },
        )
        .await
        .expect("held input should queue");

    world
        .enqueue_walk_input(
            session.connection_id,
            WalkInput {
                direction: accepted_direction.0,
                movement_mode: MovementMode::Walk,
                held_buttons: 0,
                input_seq: 0,
                client_time: 0,
            },
        )
        .await
        .expect("walk input should queue");

    world.tick().await;

    let walk_result = loop {
        match rx.recv().await {
            Some(ServerMessage::WalkResult(result)) => break result,
            Some(_) => continue,
            None => panic!("expected walk result message"),
        }
    };

    assert!(walk_result.accepted);
    assert_eq!(walk_result.reason, RejectionReason::None);
    assert_eq!(walk_result.authoritative_pos.x, accepted_direction.1);
    assert_eq!(walk_result.authoritative_pos.y, accepted_direction.2);
}

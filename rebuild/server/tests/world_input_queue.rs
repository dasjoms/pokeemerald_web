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

fn find_accepted_direction(world: &World, map_id: &str, x: u16, y: u16) -> Direction {
    let map = world.map(map_id).expect("map should exist");

    [
        Direction::Up,
        Direction::Down,
        Direction::Left,
        Direction::Right,
    ]
    .into_iter()
    .find(|direction| {
        matches!(
            validate_walk(
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
            ),
            MoveValidation::Accepted { .. }
        )
    })
    .expect("spawn should have at least one walkable adjacent tile")
}

#[tokio::test]
async fn walk_queue_drops_oldest_input_when_capacity_reached() {
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

    let walk_direction = find_accepted_direction(
        &world,
        &session.player_state.map_id,
        session.player_state.tile_x,
        session.player_state.tile_y,
    );
    world
        .enqueue_held_input_state(
            session.connection_id,
            HeldInputState {
                held_dpad: rebuild_server::protocol::direction_to_held_dpad_mask(walk_direction),
                held_buttons: 0,
                input_seq: 0,
                client_time: 0,
            },
        )
        .await
        .expect("held direction should queue");

    for input_seq in 0..=2 {
        world
            .enqueue_walk_input(
                session.connection_id,
                WalkInput {
                    direction: walk_direction,
                    movement_mode: MovementMode::Walk,
                    held_buttons: 0,
                    input_seq,
                    client_time: 0,
                },
            )
            .await
            .expect("walk input should queue");
    }

    world
        .enqueue_walk_input(
            session.connection_id,
            WalkInput {
                direction: walk_direction,
                movement_mode: MovementMode::Walk,
                held_buttons: 0,
                input_seq: 0,
                client_time: 0,
            },
        )
        .await
        .expect("out-of-sequence input should return a rejection message");

    let mismatch = loop {
        match rx.recv().await {
            Some(ServerMessage::WalkResult(result))
                if result.reason == RejectionReason::SequenceMismatch =>
            {
                break result
            }
            Some(_) => continue,
            None => panic!("expected sequence mismatch response"),
        }
    };
    assert_eq!(mismatch.input_seq, 0);

    let mut accepted_sequences = Vec::new();
    for _ in 0..20 {
        world.tick().await;
        while let Ok(message) = rx.try_recv() {
            if let ServerMessage::WalkResult(result) = message {
                if result.accepted {
                    accepted_sequences.push(result.input_seq);
                }
            }
        }
        if accepted_sequences.len() >= 1 {
            break;
        }
    }

    assert_eq!(accepted_sequences, vec![2]);

    world
        .enqueue_walk_input(
            session.connection_id,
            WalkInput {
                direction: walk_direction,
                movement_mode: MovementMode::Walk,
                held_buttons: 0,
                input_seq: 3,
                client_time: 0,
            },
        )
        .await
        .expect("next sequence should still be accepted after queue drop");

    let accepted_sequence = loop {
        world.tick().await;
        match rx.try_recv() {
            Ok(ServerMessage::WalkResult(result)) if result.accepted => break result.input_seq,
            Ok(_) => continue,
            Err(_) => continue,
        }
    };

    assert_eq!(accepted_sequence, 3);
}

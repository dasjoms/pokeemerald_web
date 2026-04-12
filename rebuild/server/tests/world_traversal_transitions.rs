use std::path::PathBuf;

use rebuild_server::{
    protocol::{
        AcroBikeSubstate, BikeTransitionType, DebugTraversalAction, DebugTraversalInput,
        ServerMessage, TraversalState,
    },
    world::World,
};
use tokio::sync::mpsc;

const BIKE_EFFECT_TIRE_TRACKS: u8 = 1 << 0;
const BIKE_EFFECT_CYCLING_BGM_MOUNT: u8 = 1 << 3;
const BIKE_EFFECT_CYCLING_BGM_DISMOUNT: u8 = 1 << 4;
const MB_DEEP_SAND: u8 = 0x06;
const MB_SAND: u8 = 0x21;

fn is_track_eligible_behavior(behavior: u8) -> bool {
    matches!(behavior, MB_SAND | MB_DEEP_SAND)
}

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

fn drain_messages(rx: &mut mpsc::UnboundedReceiver<ServerMessage>) {
    while rx.try_recv().is_ok() {}
}

async fn recv_world_snapshot(
    rx: &mut mpsc::UnboundedReceiver<ServerMessage>,
) -> rebuild_server::protocol::WorldSnapshot {
    loop {
        match rx.recv().await {
            Some(ServerMessage::WorldSnapshot(snapshot)) => return snapshot,
            Some(_) => continue,
            None => panic!("expected world snapshot"),
        }
    }
}

async fn recv_walk_result(
    rx: &mut mpsc::UnboundedReceiver<ServerMessage>,
) -> rebuild_server::protocol::WalkResult {
    loop {
        match rx.recv().await {
            Some(ServerMessage::WalkResult(result)) => return result,
            Some(_) => continue,
            None => panic!("expected walk result"),
        }
    }
}

#[tokio::test]
async fn traversal_transitions_emit_snapshot_and_walk_result_state() {
    let (maps_index, layouts_index) = test_asset_paths();
    let world = World::load_from_assets("MAP_LITTLEROOT_TOWN", &maps_index, &layouts_index)
        .expect("world should load");

    let (tx, mut rx) = mpsc::unbounded_channel();
    let session = world
        .create_session(tx)
        .await
        .expect("session should create");
    world
        .join_session(session.connection_id, "bike-transition-player")
        .await
        .expect("session should join");
    drain_messages(&mut rx);

    world
        .handle_debug_traversal_input(
            session.connection_id,
            DebugTraversalInput {
                action: DebugTraversalAction::ToggleMount,
            },
        )
        .await
        .expect("mount command should succeed");
    let mount_snapshot = recv_world_snapshot(&mut rx).await;
    assert_eq!(mount_snapshot.traversal_state, TraversalState::MachBike);
    assert_eq!(mount_snapshot.preferred_bike_type, TraversalState::MachBike);
    assert_eq!(mount_snapshot.mach_speed_stage, Some(0));
    assert_eq!(mount_snapshot.acro_substate, None);
    assert_eq!(
        mount_snapshot.bike_transition,
        Some(BikeTransitionType::Mount)
    );
    assert_eq!(
        mount_snapshot.bike_effect_flags,
        BIKE_EFFECT_CYCLING_BGM_MOUNT
    );

    world
        .reject_invalid_direction_input(session.connection_id, 0)
        .await
        .expect("mount follow-up walk result should emit");
    let mount_walk_result = recv_walk_result(&mut rx).await;
    assert!(!mount_walk_result.accepted);
    assert_eq!(mount_walk_result.traversal_state, TraversalState::MachBike);
    assert_eq!(
        mount_walk_result.bike_transition,
        Some(BikeTransitionType::Mount)
    );
    assert_ne!(
        mount_walk_result.bike_effect_flags & BIKE_EFFECT_CYCLING_BGM_MOUNT,
        0
    );
    assert_eq!(
        mount_walk_result.bike_effect_flags & BIKE_EFFECT_TIRE_TRACKS,
        0
    );

    let source_behavior = {
        let map = world
            .map(&session.player_state.map_id)
            .expect("current map should exist");
        let source_idx = session.player_state.tile_y as usize * map.width as usize
            + session.player_state.tile_x as usize;
        map.behavior[source_idx]
    };
    assert!(
        !is_track_eligible_behavior(source_behavior),
        "test fixture expects a non-sand source tile"
    );

    world
        .handle_debug_traversal_input(
            session.connection_id,
            DebugTraversalInput {
                action: DebugTraversalAction::SwapBikeType,
            },
        )
        .await
        .expect("swap command should succeed");
    let swap_snapshot = recv_world_snapshot(&mut rx).await;
    assert_eq!(swap_snapshot.traversal_state, TraversalState::AcroBike);
    assert_eq!(swap_snapshot.preferred_bike_type, TraversalState::AcroBike);
    assert_eq!(swap_snapshot.mach_speed_stage, None);
    assert_eq!(swap_snapshot.acro_substate, Some(AcroBikeSubstate::None));
    assert_eq!(
        swap_snapshot.bike_transition,
        Some(BikeTransitionType::None)
    );
    assert_eq!(swap_snapshot.bike_effect_flags, 0);

    world
        .reject_invalid_direction_input(session.connection_id, 1)
        .await
        .expect("swap follow-up walk result should emit");
    let swap_walk_result = recv_walk_result(&mut rx).await;
    assert!(!swap_walk_result.accepted);
    assert_eq!(swap_walk_result.traversal_state, TraversalState::AcroBike);
    assert_eq!(
        swap_walk_result.bike_transition,
        Some(BikeTransitionType::None)
    );
    assert_eq!(
        swap_walk_result.bike_effect_flags & BIKE_EFFECT_TIRE_TRACKS,
        0
    );

    world
        .handle_debug_traversal_input(
            session.connection_id,
            DebugTraversalInput {
                action: DebugTraversalAction::ToggleMount,
            },
        )
        .await
        .expect("dismount command should succeed");
    let dismount_snapshot = recv_world_snapshot(&mut rx).await;
    assert_eq!(dismount_snapshot.traversal_state, TraversalState::OnFoot);
    assert_eq!(
        dismount_snapshot.preferred_bike_type,
        TraversalState::AcroBike
    );
    assert_eq!(dismount_snapshot.mach_speed_stage, None);
    assert_eq!(dismount_snapshot.acro_substate, None);
    assert_eq!(
        dismount_snapshot.bike_transition,
        Some(BikeTransitionType::Dismount)
    );
    assert_eq!(
        dismount_snapshot.bike_effect_flags,
        BIKE_EFFECT_CYCLING_BGM_DISMOUNT
    );

    world
        .reject_invalid_direction_input(session.connection_id, 2)
        .await
        .expect("dismount follow-up walk result should emit");
    let dismount_walk_result = recv_walk_result(&mut rx).await;
    assert!(!dismount_walk_result.accepted);
    assert_eq!(dismount_walk_result.traversal_state, TraversalState::OnFoot);
    assert_eq!(
        dismount_walk_result.bike_transition,
        Some(BikeTransitionType::Dismount)
    );
    assert_eq!(
        dismount_walk_result.bike_effect_flags & BIKE_EFFECT_CYCLING_BGM_DISMOUNT,
        BIKE_EFFECT_CYCLING_BGM_DISMOUNT
    );
    assert_eq!(
        dismount_walk_result.bike_effect_flags & BIKE_EFFECT_TIRE_TRACKS,
        0
    );
}

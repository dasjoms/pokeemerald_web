use std::process::Command;

use rebuild_server::protocol::{
    decode_client_message, encode_server_message, BikeRuntimeDelta, BikeTransitionType,
    ClientMessage, Direction, HeldInputState, HopLandingParticleClass, MessageType, MovementMode,
    Position, RejectionReason, ServerMessage, TraversalState, WalkResult, PROTOCOL_VERSION,
};

#[test]
fn shared_walk_input_decodes_in_server_runtime() {
    let output = Command::new("python3")
        .args([
            "-c",
            r#"import pathlib, sys; sys.path.insert(0, str(pathlib.Path('../shared').resolve())); import protocol; frame=protocol.encode_message(protocol.WalkInput(direction=protocol.Direction.LEFT,movement_mode=protocol.MovementMode.WALK,held_buttons=protocol.HeldButtons.B,input_seq=7,client_time=42)); print(frame.hex())"#,
        ])
        .output()
        .expect("python must run");
    assert!(output.status.success(), "python encoding failed");
    let hex = String::from_utf8(output.stdout).expect("utf8");
    let frame = hex::decode(hex.trim()).expect("hex decode");

    let decoded = decode_client_message(&frame).expect("decode walk input");
    assert_eq!(
        decoded,
        ClientMessage::WalkInput(rebuild_server::protocol::WalkInput {
            direction: Direction::Left,
            movement_mode: MovementMode::Walk,
            held_buttons: 1,
            input_seq: 7,
            client_time: 42,
        })
    );
}

#[test]
fn server_walk_result_decodes_in_shared_python_runtime() {
    let frame = encode_server_message(&ServerMessage::WalkResult(WalkResult {
        input_seq: 9,
        accepted: true,
        authoritative_pos: Position { x: 3, y: 4 },
        facing: Direction::Up,
        reason: RejectionReason::None,
        server_frame: 88,
        traversal_state: TraversalState::OnFoot,
        preferred_bike_type: TraversalState::MachBike,
        player_elevation: 0,
        authoritative_step_speed: None,
        mach_speed_stage: None,
        acro_substate: None,
        bike_transition: Some(BikeTransitionType::None),
        bike_effect_flags: 0,
        bunny_hop_cycle_tick: None,
        hop_landing_particle_class: None,
        hop_landing_tile_x: None,
        hop_landing_tile_y: None,
    }))
    .expect("encode walk result");

    let status = Command::new("python3")
        .args([
            "-c",
            r#"import pathlib, sys; sys.path.insert(0, str(pathlib.Path('../shared').resolve())); import protocol, binascii; frame=binascii.unhexlify(sys.argv[1]); msg=protocol.decode_message(frame); assert isinstance(msg, protocol.WalkResult); assert msg.input_seq==9 and msg.accepted and msg.authoritative_pos.x==3 and msg.authoritative_pos.y==4 and msg.facing==protocol.Direction.UP and msg.reason==protocol.RejectionReason.NONE and msg.server_frame==88 and msg.traversal_state==protocol.TraversalState.ON_FOOT and msg.preferred_bike_type==protocol.TraversalState.MACH_BIKE and msg.bike_transition==protocol.BikeTransitionType.NONE and msg.bike_effect_flags==0"#,
            &hex::encode(frame),
        ])
        .status()
        .expect("python must run");

    assert!(status.success(), "python decoder assertions failed");
}

#[test]
fn rejection_reason_enum_values_match_shared_schema() {
    assert_eq!(RejectionReason::None as u8, 0);
    assert_eq!(RejectionReason::Collision as u8, 1);
    assert_eq!(RejectionReason::OutOfBounds as u8, 2);
    assert_eq!(RejectionReason::SequenceMismatch as u8, 3);
    assert_eq!(RejectionReason::NotJoined as u8, 4);
    assert_eq!(RejectionReason::InvalidDirection as u8, 5);
    assert_eq!(RejectionReason::ForcedMovementDisabled as u8, 6);

    let status = Command::new("python3")
        .args([
            "-c",
            r#"import pathlib, sys; sys.path.insert(0, str(pathlib.Path('../shared').resolve())); import protocol; assert int(protocol.RejectionReason.NONE) == 0; assert int(protocol.RejectionReason.COLLISION) == 1; assert int(protocol.RejectionReason.OUT_OF_BOUNDS) == 2; assert int(protocol.RejectionReason.SEQUENCE_MISMATCH) == 3; assert int(protocol.RejectionReason.NOT_JOINED) == 4; assert int(protocol.RejectionReason.INVALID_DIRECTION) == 5; assert int(protocol.RejectionReason.FORCED_MOVEMENT_DISABLED) == 6"#,
        ])
        .status()
        .expect("python must run");

    assert!(status.success(), "python enum value assertions failed");
}

#[test]
fn shared_held_input_state_decodes_in_server_runtime() {
    let output = Command::new("python3")
        .args([
            "-c",
            r#"import pathlib, sys; sys.path.insert(0, str(pathlib.Path('../shared').resolve())); import protocol; frame=protocol.encode_message(protocol.HeldInputState(held_direction=None,held_buttons=protocol.HeldButtons.B,input_seq=17,client_time=1337)); print(frame.hex())"#,
        ])
        .output()
        .expect("python must run");
    assert!(output.status.success(), "python encoding failed");
    let hex = String::from_utf8(output.stdout).expect("utf8");
    let frame = hex::decode(hex.trim()).expect("hex decode");

    let decoded = decode_client_message(&frame).expect("decode held input state");
    assert_eq!(
        decoded,
        ClientMessage::HeldInputState(HeldInputState {
            held_direction: None,
            held_buttons: 1,
            input_seq: 17,
            client_time: 1337,
        })
    );
}

#[test]
fn walk_result_wire_encoding_with_forced_movement_disabled_is_canonical() {
    let frame = encode_server_message(&ServerMessage::WalkResult(WalkResult {
        input_seq: 0x0102_0304,
        accepted: false,
        authoritative_pos: Position {
            x: 0x1122,
            y: 0x3344,
        },
        facing: Direction::Left,
        reason: RejectionReason::ForcedMovementDisabled,
        server_frame: 0x0a0b_0c0d,
        traversal_state: TraversalState::OnFoot,
        preferred_bike_type: TraversalState::OnFoot,
        player_elevation: 0,
        authoritative_step_speed: None,
        mach_speed_stage: None,
        acro_substate: None,
        bike_transition: Some(BikeTransitionType::None),
        bike_effect_flags: 0,
        bunny_hop_cycle_tick: None,
        hop_landing_particle_class: None,
        hop_landing_tile_x: None,
        hop_landing_tile_y: None,
    }))
    .expect("encode walk result");

    let mut expected_frame = Vec::new();
    expected_frame.extend_from_slice(&PROTOCOL_VERSION.to_le_bytes());
    expected_frame.push(MessageType::WalkResult as u8);
    expected_frame.push(0x1c);
    expected_frame.extend(
        hex::decode("00000004030201002211443302060d0c0b0a00000004000000000000000000")
            .expect("valid expected payload"),
    );
    assert_eq!(frame, expected_frame);

    let status = Command::new("python3")
        .args([
            "-c",
            r#"import pathlib, sys, binascii; sys.path.insert(0, str(pathlib.Path('../shared').resolve())); import protocol; frame=binascii.unhexlify(sys.argv[1]); msg=protocol.decode_message(frame); assert isinstance(msg, protocol.WalkResult); assert msg.input_seq == 0x01020304; assert msg.accepted is False; assert msg.authoritative_pos.x == 0x1122; assert msg.authoritative_pos.y == 0x3344; assert msg.facing == protocol.Direction.LEFT; assert msg.reason == protocol.RejectionReason.FORCED_MOVEMENT_DISABLED; assert msg.server_frame == 0x0a0b0c0d; assert msg.traversal_state == protocol.TraversalState.ON_FOOT; assert msg.preferred_bike_type == protocol.TraversalState.ON_FOOT; assert msg.bike_transition == protocol.BikeTransitionType.NONE and msg.bike_effect_flags == 0"#,
            &hex::encode(frame),
        ])
        .status()
        .expect("python must run");

    assert!(
        status.success(),
        "python walk result decoder assertions failed"
    );
}

#[test]
fn server_bike_runtime_delta_decodes_in_shared_python_runtime_with_authoritative_facing() {
    let frame = encode_server_message(&ServerMessage::BikeRuntimeDelta(BikeRuntimeDelta {
        server_frame: 55,
        traversal_state: TraversalState::AcroBike,
        player_elevation: 2,
        facing: Direction::Right,
        authoritative_step_speed: None,
        mach_speed_stage: Some(1),
        acro_substate: None,
        bike_transition: Some(BikeTransitionType::HopStanding),
        bunny_hop_cycle_tick: Some(7),
        hop_landing_particle_class: Some(HopLandingParticleClass::NormalGroundDust),
        hop_landing_tile_x: Some(9),
        hop_landing_tile_y: Some(10),
    }))
    .expect("encode bike runtime delta");

    let status = Command::new("python3")
        .args([
            "-c",
            r#"import pathlib, sys, binascii; sys.path.insert(0, str(pathlib.Path('../shared').resolve())); import protocol; frame=binascii.unhexlify(sys.argv[1]); msg=protocol.decode_message(frame); assert isinstance(msg, protocol.BikeRuntimeDelta); assert msg.server_frame == 55; assert msg.traversal_state == protocol.TraversalState.ACRO_BIKE; assert msg.player_elevation == 2; assert msg.facing == protocol.Direction.RIGHT; assert msg.mach_speed_stage == 1; assert msg.bike_transition == protocol.BikeTransitionType.HOP_STANDING; assert msg.bunny_hop_cycle_tick == 7; assert msg.hop_landing_particle_class == protocol.HopLandingParticleClass.NORMAL_GROUND_DUST; assert msg.hop_landing_tile_x == 9 and msg.hop_landing_tile_y == 10"#,
            &hex::encode(frame),
        ])
        .status()
        .expect("python must run");

    assert!(
        status.success(),
        "python bike runtime delta decoder assertions failed"
    );
}

use std::process::Command;

use rebuild_server::protocol::{
    decode_client_message, encode_server_message, BikeTransitionType, ClientMessage, Direction,
    MovementMode, Position, RejectionReason, ServerMessage, TraversalState, WalkResult,
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
        mach_speed_stage: None,
        acro_substate: None,
        bike_transition: Some(BikeTransitionType::None),
        bike_effect_flags: 0,
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
        mach_speed_stage: None,
        acro_substate: None,
        bike_transition: Some(BikeTransitionType::None),
        bike_effect_flags: 0,
    }))
    .expect("encode walk result");

    assert_eq!(
        hex::encode(&frame),
        "0600831400000004030201002211443302060d0c0b0a0000040000"
    );

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

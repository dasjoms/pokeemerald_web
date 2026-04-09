use std::process::Command;

use rebuild_server::protocol::{
    decode_client_message, encode_server_message, ClientMessage, Direction, MovementMode, Position,
    RejectionReason, ServerMessage, WalkResult,
};

#[test]
fn shared_walk_input_decodes_in_server_runtime() {
    let output = Command::new("python3")
        .args([
            "-c",
            r#"import pathlib, sys; sys.path.insert(0, str(pathlib.Path('../shared').resolve())); import protocol; frame=protocol.encode_message(protocol.WalkInput(direction=protocol.Direction.LEFT,movement_mode=protocol.MovementMode.WALK,input_seq=7,client_time=42)); print(frame.hex())"#,
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
    }))
    .expect("encode walk result");

    let status = Command::new("python3")
        .args([
            "-c",
            r#"import pathlib, sys; sys.path.insert(0, str(pathlib.Path('../shared').resolve())); import protocol, binascii; frame=binascii.unhexlify(sys.argv[1]); msg=protocol.decode_message(frame); assert isinstance(msg, protocol.WalkResult); assert msg.input_seq==9 and msg.accepted and msg.authoritative_pos.x==3 and msg.authoritative_pos.y==4 and msg.facing==protocol.Direction.UP and msg.reason==protocol.RejectionReason.NONE and msg.server_frame==88"#,
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
    }))
    .expect("encode walk result");

    assert_eq!(
        hex::encode(&frame),
        "0200830f00000004030201002211443302060d0c0b0a"
    );

    let status = Command::new("python3")
        .args([
            "-c",
            r#"import pathlib, sys, binascii; sys.path.insert(0, str(pathlib.Path('../shared').resolve())); import protocol; frame=binascii.unhexlify(sys.argv[1]); msg=protocol.decode_message(frame); assert isinstance(msg, protocol.WalkResult); assert msg.input_seq == 0x01020304; assert msg.accepted is False; assert msg.authoritative_pos.x == 0x1122; assert msg.authoritative_pos.y == 0x3344; assert msg.facing == protocol.Direction.LEFT; assert msg.reason == protocol.RejectionReason.FORCED_MOVEMENT_DISABLED; assert msg.server_frame == 0x0a0b0c0d"#,
            &hex::encode(frame),
        ])
        .status()
        .expect("python must run");

    assert!(
        status.success(),
        "python walk result decoder assertions failed"
    );
}

use std::process::Command;

use rebuild_server::protocol::{
    decode_client_message, encode_server_message, ClientMessage, Direction, Position,
    RejectionReason, ServerMessage, WalkResult,
};

#[test]
fn shared_walk_input_decodes_in_server_runtime() {
    let output = Command::new("python3")
        .args([
            "-c",
            r#"import pathlib, sys; sys.path.insert(0, str(pathlib.Path('../shared').resolve())); import protocol; frame=protocol.encode_message(protocol.WalkInput(direction=protocol.Direction.LEFT,input_seq=7,client_time=42)); print(frame.hex())"#,
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

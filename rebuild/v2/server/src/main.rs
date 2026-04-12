use std::{env, path::PathBuf};

use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Query,
    },
    response::IntoResponse,
    routing::get,
    Router,
};
use serde::Deserialize;
use tracing::{error, info};

const DEFAULT_ASSET_ROOT: &str = "../../assets";
const DEFAULT_BIND_ADDR: &str = "127.0.0.1:4100";
const PROTOCOL_VERSION: u16 = 1;

#[derive(Debug, Deserialize)]
struct HandshakeQuery {
    #[serde(default, rename = "clientVersion")]
    client_version: String,
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();

    let asset_root = resolve_asset_root();
    if let Err(message) = validate_asset_root(&asset_root) {
        error!("{message}");
        std::process::exit(1);
    }

    let app = Router::new().route("/ws", get(handle_ws_upgrade));
    let bind_addr =
        env::var("V2_SERVER_BIND_ADDR").unwrap_or_else(|_| DEFAULT_BIND_ADDR.to_string());

    let listener = tokio::net::TcpListener::bind(&bind_addr)
        .await
        .expect("failed to bind v2 server listener");

    info!(
        protocol_version = PROTOCOL_VERSION,
        asset_root = %asset_root.display(),
        "rebuild v2 server starting"
    );

    axum::serve(listener, app)
        .await
        .expect("rebuild v2 server failed");
}

fn resolve_asset_root() -> PathBuf {
    env::var("V2_ASSET_ROOT")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from(DEFAULT_ASSET_ROOT))
}

fn validate_asset_root(asset_root: &PathBuf) -> Result<(), String> {
    if !asset_root.exists() {
        return Err(format!(
            "V2 asset root does not exist: {} (set V2_ASSET_ROOT or ensure rebuild/assets is present)",
            asset_root.display()
        ));
    }

    let required_dirs = ["layouts", "render", "players"];
    for dir in required_dirs {
        let full = asset_root.join(dir);
        if !full.exists() {
            return Err(format!(
                "V2 asset root is missing required directory: {} (asset root: {})",
                full.display(),
                asset_root.display()
            ));
        }
    }

    Ok(())
}

async fn handle_ws_upgrade(
    ws: WebSocketUpgrade,
    Query(query): Query<HandshakeQuery>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_socket(socket, query.client_version))
}

async fn handle_socket(mut socket: WebSocket, client_version: String) {
    let server_hello = format!(
        r#"{{"type":"server_hello","protocolVersion":{},"serverAuthority":true,"clientVersion":"{}"}}"#,
        PROTOCOL_VERSION, client_version
    );

    if socket.send(Message::Text(server_hello)).await.is_err() {
        return;
    }

    while let Some(Ok(message)) = socket.recv().await {
        if let Message::Close(_) = message {
            break;
        }
    }
}

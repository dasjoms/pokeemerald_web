use std::{env, net::SocketAddr, path::Path, sync::Arc, time::Duration};

use anyhow::{anyhow, Context};
use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        State,
    },
    response::IntoResponse,
    routing::get,
    Router,
};
use futures::{SinkExt, StreamExt};
use serde::Deserialize;
use tokio::sync::mpsc;
use tracing::{error, info, warn};

use rebuild_server::{
    protocol::{decode_client_message, encode_server_message, ClientMessage, ServerMessage},
    world::World,
};

const DEFAULT_INITIAL_MAP_ID: &str = "MAP_LITTLEROOT_TOWN";
const INITIAL_MAP_ENV_VAR: &str = "REBUILD_INITIAL_MAP";
const MAPS_INDEX_PATH: &str = "../assets/maps_index.json";
const LAYOUTS_INDEX_PATH: &str = "../assets/layouts_index.json";

#[derive(Clone)]
struct AppState {
    world: Arc<World>,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();

    let initial_map_id = resolve_initial_map_id()?;
    let startup_map = resolve_startup_map(&initial_map_id)?;
    info!(
        map_id = %startup_map.map_id,
        layout_id = %startup_map.layout_id,
        layout_path = %startup_map.layout_path,
        "loaded startup map configuration"
    );

    let world = Arc::new(World::load_from_layout(
        startup_map.map_id,
        &startup_map.layout_path,
    )?);

    let simulation_world = Arc::clone(&world);
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_millis(50));
        loop {
            interval.tick().await;
            simulation_world.tick().await;
        }
    });

    let app_state = AppState { world };
    let app = Router::new()
        .route("/ws", get(ws_handler))
        .with_state(app_state);

    let addr = SocketAddr::from(([127, 0, 0, 1], 8080));
    info!(%addr, "starting rebuild server");
    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app).await?;

    Ok(())
}

fn resolve_initial_map_id() -> anyhow::Result<String> {
    let mut args = env::args().skip(1);
    while let Some(arg) = args.next() {
        if arg == "--initial-map" {
            let map_id = args
                .next()
                .ok_or_else(|| anyhow!("missing value for --initial-map"))?;
            return Ok(map_id);
        }

        if let Some(map_id) = arg.strip_prefix("--initial-map=") {
            if map_id.is_empty() {
                return Err(anyhow!("--initial-map cannot be empty"));
            }
            return Ok(map_id.to_string());
        }
    }

    if let Ok(map_id) = env::var(INITIAL_MAP_ENV_VAR) {
        let trimmed = map_id.trim();
        if trimmed.is_empty() {
            return Err(anyhow!("{INITIAL_MAP_ENV_VAR} cannot be empty"));
        }
        return Ok(trimmed.to_string());
    }

    Ok(DEFAULT_INITIAL_MAP_ID.to_string())
}

fn resolve_startup_map(selected_map_id: &str) -> anyhow::Result<StartupMapConfig> {
    let maps_index = load_maps_index(MAPS_INDEX_PATH)?;
    let map_entry = maps_index
        .maps
        .iter()
        .find(|map| map.map_id == selected_map_id)
        .ok_or_else(|| anyhow!("map id {selected_map_id} was not found in {MAPS_INDEX_PATH}"))?;

    let layouts_index = load_layouts_index(LAYOUTS_INDEX_PATH)?;
    let layout_entry = layouts_index
        .layouts
        .iter()
        .find(|layout| layout.id == map_entry.layout_id)
        .ok_or_else(|| {
            anyhow!(
                "layout id {} (from map {}) was not found in {}",
                map_entry.layout_id,
                map_entry.map_id,
                LAYOUTS_INDEX_PATH
            )
        })?;

    let layout_path = format!("../assets/{}", layout_entry.decoded_path);
    if !Path::new(&layout_path).is_file() {
        return Err(anyhow!(
            "decoded layout artifact does not exist for layout {} at {}",
            layout_entry.id,
            layout_path
        ));
    }

    Ok(StartupMapConfig {
        map_id: map_entry.map_id.clone(),
        layout_id: layout_entry.id.clone(),
        layout_path,
    })
}

fn load_maps_index(path: &str) -> anyhow::Result<MapsIndex> {
    let raw = std::fs::read_to_string(path)
        .with_context(|| format!("failed to read maps index at {path}"))?;
    serde_json::from_str(&raw).with_context(|| format!("failed to parse maps index at {path}"))
}

fn load_layouts_index(path: &str) -> anyhow::Result<LayoutsIndex> {
    let raw = std::fs::read_to_string(path)
        .with_context(|| format!("failed to read layouts index at {path}"))?;
    serde_json::from_str(&raw).with_context(|| format!("failed to parse layouts index at {path}"))
}

#[derive(Debug)]
struct StartupMapConfig {
    map_id: String,
    layout_id: String,
    layout_path: String,
}

#[derive(Debug, Deserialize)]
struct MapsIndex {
    maps: Vec<MapEntry>,
}

#[derive(Debug, Deserialize)]
struct MapEntry {
    map_id: String,
    layout_id: String,
}

#[derive(Debug, Deserialize)]
struct LayoutsIndex {
    layouts: Vec<LayoutEntry>,
}

#[derive(Debug, Deserialize)]
struct LayoutEntry {
    id: String,
    decoded_path: String,
}

async fn ws_handler(ws: WebSocketUpgrade, State(state): State<AppState>) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_socket(socket, state))
}

async fn handle_socket(socket: WebSocket, state: AppState) {
    let (mut ws_tx, mut ws_rx) = socket.split();
    let (outgoing_tx, mut outgoing_rx) = mpsc::unbounded_channel::<ServerMessage>();

    let writer = tokio::spawn(async move {
        while let Some(message) = outgoing_rx.recv().await {
            match encode_server_message(&message) {
                Ok(payload) => {
                    if ws_tx.send(Message::Binary(payload)).await.is_err() {
                        break;
                    }
                }
                Err(err) => {
                    error!(
                        ?err,
                        "failed to serialize outgoing websocket binary message"
                    );
                }
            }
        }
    });

    let session = state.world.create_session(outgoing_tx).await;

    while let Some(frame_result) = ws_rx.next().await {
        let message = match frame_result {
            Ok(msg) => msg,
            Err(err) => {
                warn!(
                    ?err,
                    connection_id = session.connection_id,
                    "websocket receive error"
                );
                break;
            }
        };

        match message {
            Message::Binary(payload) => match decode_client_message(&payload) {
                Ok(ClientMessage::WalkInput(input)) => {
                    if let Err(err) = state
                        .world
                        .enqueue_walk_input(session.connection_id, input)
                        .await
                    {
                        warn!(
                            ?err,
                            connection_id = session.connection_id,
                            "failed to enqueue walk input"
                        );
                    }
                }
                Ok(ClientMessage::WalkInputInvalidDirection { input_seq, .. }) => {
                    if let Err(err) = state
                        .world
                        .reject_invalid_direction_input(session.connection_id, input_seq)
                        .await
                    {
                        warn!(
                            ?err,
                            connection_id = session.connection_id,
                            "failed to reject invalid walk input direction"
                        );
                    }
                }
                Ok(ClientMessage::JoinSession(_)) => {
                    if let Err(err) = state.world.join_session(session.connection_id).await {
                        warn!(
                            ?err,
                            connection_id = session.connection_id,
                            "failed to process join session"
                        );
                        break;
                    }
                }
                Err(err) => {
                    warn!(
                        ?err,
                        connection_id = session.connection_id,
                        "invalid client payload"
                    );
                }
            },
            Message::Text(_) => {
                warn!(
                    connection_id = session.connection_id,
                    "ignoring text websocket frame; binary protocol is required"
                );
            }
            Message::Close(_) => {
                break;
            }
            Message::Ping(_) | Message::Pong(_) => {}
        }
    }

    state.world.remove_session(session.connection_id).await;
    writer.abort();
}

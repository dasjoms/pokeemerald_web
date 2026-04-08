use std::{env, net::SocketAddr, sync::Arc, time::Duration};

use anyhow::anyhow;
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
    let world = Arc::new(World::load_from_assets(
        &initial_map_id,
        MAPS_INDEX_PATH,
        LAYOUTS_INDEX_PATH,
    )?);
    info!(map_id = %initial_map_id, "loaded startup map configuration");

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

    let session = match state.world.create_session(outgoing_tx).await {
        Ok(session) => session,
        Err(err) => {
            warn!(?err, "failed to create session");
            return;
        }
    };

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

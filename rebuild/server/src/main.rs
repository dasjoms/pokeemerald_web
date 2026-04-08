use std::{net::SocketAddr, sync::Arc, time::Duration};

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

#[derive(Clone)]
struct AppState {
    world: Arc<World>,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();

    let world = Arc::new(World::load_littleroot(
        "../assets/layouts/LAYOUT_LITTLEROOT_TOWN.json",
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

use std::{
    env, fs,
    net::SocketAddr,
    path::{Component, Path, PathBuf},
    sync::Arc,
    time::Duration,
};

use anyhow::anyhow;
use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Path as AxumPath, State,
    },
    http::{header, HeaderValue, StatusCode},
    response::IntoResponse,
    routing::get,
    Router,
};
use futures::{SinkExt, StreamExt};
use tokio::sync::mpsc;
use tracing::{error, info, warn};

use rebuild_server::{
    movement::WALK_SAMPLE_MS,
    protocol::{decode_client_message, encode_server_message, ClientMessage, ServerMessage},
    world::World,
};

const DEFAULT_INITIAL_MAP_ID: &str = "MAP_LITTLEROOT_TOWN";
const INITIAL_MAP_ENV_VAR: &str = "REBUILD_INITIAL_MAP";
const DEBUG_ACTIONS_ENV_VAR: &str = "REBUILD_ENABLE_DEBUG_ACTIONS";
const MAPS_INDEX_PATH: &str = "../assets/maps_index.json";
const LAYOUTS_INDEX_PATH: &str = "../assets/layouts_index.json";
const ASSET_ROOT_ENV_VAR: &str = "REBUILD_ASSET_ROOT";
const DEFAULT_ASSET_ROOT: &str = "../assets";
const ALLOWED_ASSET_TOP_LEVEL_DIRS: &[&str] =
    &["layouts", "players", "render", "meta", "field_effects"];

#[derive(Clone)]
struct AppState {
    world: Arc<World>,
    allow_debug_actions: bool,
    asset_root: PathBuf,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();

    let initial_map_id = resolve_initial_map_id()?;
    let allow_debug_actions = resolve_debug_actions_enabled();
    let asset_root = resolve_asset_root();
    if let Err(message) = validate_asset_root(&asset_root) {
        error!("{message}");
        std::process::exit(1);
    }
    let canonical_asset_root = asset_root
        .canonicalize()
        .expect("asset root canonicalization should succeed after validation");
    let world = Arc::new(World::load_from_assets(
        &initial_map_id,
        MAPS_INDEX_PATH,
        LAYOUTS_INDEX_PATH,
    )?);
    info!(map_id = %initial_map_id, "loaded startup map configuration");
    info!(allow_debug_actions, "debug traversal actions configuration");

    let simulation_world = Arc::clone(&world);
    tokio::spawn(async move {
        let mut interval =
            tokio::time::interval(Duration::from_secs_f64((WALK_SAMPLE_MS / 1000.0) as f64));
        loop {
            interval.tick().await;
            simulation_world.tick().await;
        }
    });

    let app_state = AppState {
        world,
        allow_debug_actions,
        asset_root: canonical_asset_root,
    };
    let app = Router::new()
        .route("/ws", get(ws_handler))
        .route("/assets/*path", get(handle_asset_request))
        .route("/v1/assets/*path", get(handle_asset_request))
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

fn resolve_debug_actions_enabled() -> bool {
    env::var(DEBUG_ACTIONS_ENV_VAR)
        .ok()
        .map(|value| {
            matches!(
                value.trim().to_ascii_lowercase().as_str(),
                "1" | "true" | "yes" | "on"
            )
        })
        .unwrap_or(false)
}

fn resolve_asset_root() -> PathBuf {
    env::var(ASSET_ROOT_ENV_VAR)
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from(DEFAULT_ASSET_ROOT))
}

fn validate_asset_root(asset_root: &PathBuf) -> Result<(), String> {
    if !asset_root.exists() {
        return Err(format!(
            "asset root does not exist: {} (set {ASSET_ROOT_ENV_VAR} or ensure rebuild/assets is present)",
            asset_root.display()
        ));
    }

    let required_dirs = ["layouts", "render", "players"];
    for dir in required_dirs {
        let full = asset_root.join(dir);
        if !full.exists() {
            return Err(format!(
                "asset root is missing required directory: {} (asset root: {})",
                full.display(),
                asset_root.display()
            ));
        }
    }

    Ok(())
}

async fn handle_asset_request(
    State(state): State<AppState>,
    AxumPath(path): AxumPath<String>,
) -> impl IntoResponse {
    let relative_path = match normalize_and_validate_asset_path(&path) {
        Ok(relative_path) => relative_path,
        Err(status) => return status.into_response(),
    };
    let requested_path = state.asset_root.join(&relative_path);

    let canonical_requested_path = match requested_path.canonicalize() {
        Ok(path) => path,
        Err(_) => return StatusCode::NOT_FOUND.into_response(),
    };

    if !canonical_requested_path.starts_with(&state.asset_root) {
        return StatusCode::FORBIDDEN.into_response();
    }

    let bytes = match fs::read(&canonical_requested_path) {
        Ok(bytes) => bytes,
        Err(_) => return StatusCode::NOT_FOUND.into_response(),
    };

    let content_type = content_type_for_path(&canonical_requested_path);
    let mut response = (StatusCode::OK, bytes).into_response();
    response
        .headers_mut()
        .insert(header::CONTENT_TYPE, HeaderValue::from_static(content_type));
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("public, max-age=3600"),
    );
    response
}

fn normalize_and_validate_asset_path(path: &str) -> Result<PathBuf, StatusCode> {
    let request_path = Path::new(path);
    let mut normalized = PathBuf::new();

    for component in request_path.components() {
        match component {
            Component::Normal(part) => normalized.push(part),
            Component::CurDir => {}
            Component::ParentDir | Component::Prefix(_) | Component::RootDir => {
                return Err(StatusCode::FORBIDDEN);
            }
        }
    }

    let first_segment = normalized
        .components()
        .next()
        .and_then(|component| match component {
            Component::Normal(part) => part.to_str(),
            _ => None,
        })
        .ok_or(StatusCode::NOT_FOUND)?;

    if !ALLOWED_ASSET_TOP_LEVEL_DIRS.contains(&first_segment) {
        return Err(StatusCode::FORBIDDEN);
    }

    Ok(normalized)
}

fn content_type_for_path(path: &Path) -> &'static str {
    match path.extension().and_then(|ext| ext.to_str()) {
        Some("json") => "application/json",
        Some("png") => "image/png",
        Some("bin") => "application/octet-stream",
        Some("pal") => "application/octet-stream",
        _ => "application/octet-stream",
    }
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
                Ok(ClientMessage::HeldInputState(input)) => {
                    if let Err(err) = state
                        .world
                        .enqueue_held_input_state(session.connection_id, input)
                        .await
                    {
                        warn!(
                            ?err,
                            connection_id = session.connection_id,
                            "failed to apply held input state"
                        );
                    }
                }
                Ok(ClientMessage::PlayerActionInput(input)) => {
                    if let Err(err) = state
                        .world
                        .handle_player_action_input(session.connection_id, input)
                        .await
                    {
                        warn!(
                            ?err,
                            connection_id = session.connection_id,
                            "failed to process player action input"
                        );
                    }
                }
                Ok(ClientMessage::DebugTraversalInput(input)) => {
                    if !state.allow_debug_actions {
                        warn!(
                            connection_id = session.connection_id,
                            "ignoring debug traversal input because debug actions are disabled"
                        );
                        continue;
                    }
                    if let Err(err) = state
                        .world
                        .handle_debug_traversal_input(session.connection_id, input)
                        .await
                    {
                        warn!(
                            ?err,
                            connection_id = session.connection_id,
                            "failed to process debug traversal input"
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
                Ok(ClientMessage::JoinSession(join)) => {
                    if let Err(err) = state
                        .world
                        .join_session(session.connection_id, &join.player_id)
                        .await
                    {
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

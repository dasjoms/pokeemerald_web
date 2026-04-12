use std::{env, path::PathBuf, sync::Arc};

use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Query, State,
    },
    response::IntoResponse,
    routing::get,
    Router,
};
use rebuild_v2_server::{
    map_runtime::{RuntimeMapAssembler, MAP_OFFSET},
    render_assets::RenderMetatileResolver,
    render_state::{
        CameraAnchor, RenderStateV1, RenderWindow, ServerMessage, RENDER_WINDOW_HEIGHT,
        RENDER_WINDOW_WIDTH,
    },
};
use serde::Deserialize;
use tracing::{error, info};

const DEFAULT_ASSET_ROOT: &str = "../../assets";
const DEFAULT_BIND_ADDR: &str = "127.0.0.1:4100";
const PROTOCOL_VERSION: u16 = 1;
const DEFAULT_MAP_ID: &str = "MAP_PETALBURG_CITY";

#[derive(Clone)]
struct AppState {
    asset_root: PathBuf,
    player_runtime: PlayerRuntimeState,
}

#[derive(Debug, Deserialize)]
struct HandshakeQuery {
    #[serde(default, rename = "clientVersion")]
    client_version: String,
}

#[derive(Clone, Copy, Debug)]
struct MapLocalCoord {
    x: i32,
    y: i32,
}

#[derive(Clone, Copy, Debug)]
struct RuntimeCoord {
    x: i32,
    y: i32,
}

#[derive(Clone, Debug)]
struct PlayerRuntimeState {
    map_id: String,
    map_local: MapLocalCoord,
}

impl PlayerRuntimeState {
    fn runtime_camera_from_map_local(map_local: MapLocalCoord) -> RuntimeCoord {
        RuntimeCoord {
            x: map_local.x + MAP_OFFSET as i32,
            y: map_local.y + MAP_OFFSET as i32,
        }
    }
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

    let state = Arc::new(AppState {
        asset_root: asset_root.clone(),
        player_runtime: PlayerRuntimeState {
            map_id: DEFAULT_MAP_ID.to_owned(),
            map_local: MapLocalCoord { x: 0, y: 0 },
        },
    });

    let app = Router::new()
        .route("/ws", get(handle_ws_upgrade))
        .with_state(state);
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
    State(state): State<Arc<AppState>>,
    Query(query): Query<HandshakeQuery>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_socket(socket, state, query.client_version))
}

async fn handle_socket(mut socket: WebSocket, state: Arc<AppState>, client_version: String) {
    let hello = ServerMessage::ServerHello {
        protocol_version: PROTOCOL_VERSION,
        server_authority: true,
        client_version_echo: client_version,
    };

    if send_json(&mut socket, &hello).await.is_err() {
        return;
    }

    match build_render_state(&state.asset_root, &state.player_runtime) {
        Ok(render_state) => {
            if send_json(
                &mut socket,
                &ServerMessage::RenderStateV1 {
                    state: render_state,
                },
            )
            .await
            .is_err()
            {
                return;
            }
        }
        Err(err) => {
            error!("failed to build render state: {err}");
            return;
        }
    }

    while let Some(Ok(message)) = socket.recv().await {
        if let Message::Close(_) = message {
            break;
        }
    }
}

fn build_render_state(
    asset_root: &PathBuf,
    player_runtime: &PlayerRuntimeState,
) -> Result<RenderStateV1, String> {
    let assembler =
        RuntimeMapAssembler::from_asset_root(asset_root).map_err(|err| err.to_string())?;
    let bundle = assembler
        .build_bundle_for_map_id(&player_runtime.map_id)
        .map_err(|err| err.to_string())?;

    let runtime = bundle.runtime;
    let layout = bundle.layout;
    let render_assets = layout
        .render_assets
        .as_ref()
        .ok_or_else(|| format!("layout {} missing render assets", layout.id))?;

    let clamped_player_x = player_runtime.map_local.x.clamp(0, layout.width as i32 - 1);
    let clamped_player_y = player_runtime
        .map_local
        .y
        .clamp(0, layout.height as i32 - 1);
    let camera_runtime = PlayerRuntimeState::runtime_camera_from_map_local(MapLocalCoord {
        x: clamped_player_x,
        y: clamped_player_y,
    });
    let camera_runtime_x = camera_runtime.x;
    let camera_runtime_y = camera_runtime.y;
    let origin_runtime_x = camera_runtime_x - (RENDER_WINDOW_WIDTH as i32 / 2);
    let origin_runtime_y = camera_runtime_y - (RENDER_WINDOW_HEIGHT as i32 / 2);

    let resolver = RenderMetatileResolver::from_layout(asset_root, &layout)?;
    let mut metatiles = Vec::with_capacity(RENDER_WINDOW_WIDTH * RENDER_WINDOW_HEIGHT);
    for y in 0..RENDER_WINDOW_HEIGHT as i32 {
        for x in 0..RENDER_WINDOW_WIDTH as i32 {
            let packed =
                runtime.get_packed_with_border_fallback(origin_runtime_x + x, origin_runtime_y + y);
            metatiles.push(resolver.resolve(packed)?);
        }
    }

    Ok(RenderStateV1 {
        protocol_version: PROTOCOL_VERSION,
        map_id: player_runtime.map_id.clone(),
        tileset_pair_id: render_assets.pair_id.clone(),
        camera: CameraAnchor {
            runtime_x: camera_runtime_x,
            runtime_y: camera_runtime_y,
        },
        window: RenderWindow {
            origin_runtime_x,
            origin_runtime_y,
            width: RENDER_WINDOW_WIDTH,
            height: RENDER_WINDOW_HEIGHT,
        },
        metatiles,
    })
}

async fn send_json(socket: &mut WebSocket, message: &ServerMessage) -> Result<(), ()> {
    let payload = serde_json::to_string(message).map_err(|_| ())?;
    socket
        .send(Message::Text(payload.into()))
        .await
        .map_err(|_| ())
}

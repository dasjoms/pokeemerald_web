use std::{
    collections::HashMap,
    env, fs,
    path::{Component, Path, PathBuf},
    sync::Arc,
};

use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Path as AxumPath, Query, State,
    },
    http::{header, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
    Router,
};
use rebuild_v2_server::{
    map_runtime::{LayoutRenderAssets, RuntimeMapAssembler, MAP_OFFSET},
    render_assets::RenderMetatileResolver,
    render_state::{
        AssetManifest, CameraAnchor, RenderStateV1, RenderWindow, ServerMessage,
        RENDER_WINDOW_HEIGHT, RENDER_WINDOW_WIDTH,
    },
};
use serde::Deserialize;
use tracing::{error, info};

const DEFAULT_ASSET_ROOT: &str = "../../assets";
const DEFAULT_BIND_ADDR: &str = "127.0.0.1:4100";
const PROTOCOL_VERSION: u16 = 1;
const DEFAULT_MAP_ID: &str = "MAP_LITTLEROOT_TOWN";
const DEFAULT_START_MAP_LOCAL_X: i32 = 10;
const DEFAULT_START_MAP_LOCAL_Y: i32 = 1;
const ALLOWED_ASSET_TOP_LEVEL_DIRS: &[&str] = &["layouts", "players", "render"];
const DEFAULT_ASSET_BASE_URL: &str = "/assets";
const DEFAULT_ASSET_VERSION: &str = "dev";

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

    let canonical_asset_root = asset_root
        .canonicalize()
        .expect("asset root canonicalization should succeed after validation");

    let state = Arc::new(AppState {
        asset_root: canonical_asset_root,
        player_runtime: PlayerRuntimeState {
            map_id: DEFAULT_MAP_ID.to_owned(),
            // temporary Phase 1 spawn near Route 101 transition
            map_local: MapLocalCoord {
                x: DEFAULT_START_MAP_LOCAL_X,
                y: DEFAULT_START_MAP_LOCAL_Y,
            },
        },
    });

    let app = Router::new()
        .route("/ws", get(handle_ws_upgrade))
        .route("/assets/*path", get(handle_asset_request))
        .route("/v2/assets/*path", get(handle_asset_request))
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

async fn handle_asset_request(
    State(state): State<Arc<AppState>>,
    AxumPath(path): AxumPath<String>,
) -> Response {
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

async fn handle_socket(mut socket: WebSocket, state: Arc<AppState>, client_version: String) {
    let render_payload = match build_render_payload(&state.asset_root, &state.player_runtime) {
        Ok(payload) => payload,
        Err(err) => {
            error!("failed to build render payload: {err}");
            return;
        }
    };

    let hello = ServerMessage::ServerHello {
        protocol_version: PROTOCOL_VERSION,
        server_authority: true,
        client_version_echo: client_version,
        asset_manifest: render_payload.asset_manifest.clone(),
    };

    if send_json(&mut socket, &hello).await.is_err() {
        return;
    }

    if send_json(
        &mut socket,
        &ServerMessage::RenderStateV1 {
            state: render_payload.render_state,
        },
    )
    .await
    .is_err()
    {
        return;
    }

    while let Some(Ok(message)) = socket.recv().await {
        if let Message::Close(_) = message {
            return;
        }
    }
}

struct BuildRenderPayload {
    render_state: RenderStateV1,
    asset_manifest: AssetManifest,
}

fn build_render_payload(
    asset_root: &PathBuf,
    player_runtime: &PlayerRuntimeState,
) -> Result<BuildRenderPayload, String> {
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

    let mut resolver_by_map_id: HashMap<String, RenderMetatileResolver> = HashMap::new();
    for (source_map_id, source_layout) in &bundle.source_layouts_by_map_id {
        let resolver =
            RenderMetatileResolver::from_layout(asset_root, source_layout).map_err(|err| {
                format!(
                    "failed building metatile resolver for source_map_id={source_map_id}: {err}"
                )
            })?;
        resolver_by_map_id.insert(source_map_id.clone(), resolver);
    }

    let active_pair_id = render_assets.pair_id.clone();
    let mut metatiles = Vec::with_capacity(RENDER_WINDOW_WIDTH * RENDER_WINDOW_HEIGHT);
    for y in 0..RENDER_WINDOW_HEIGHT as i32 {
        for x in 0..RENDER_WINDOW_WIDTH as i32 {
            let runtime_x = origin_runtime_x + x;
            let runtime_y = origin_runtime_y + y;
            let (packed, source_map_id) = runtime.packed_and_source_map_id_with_border_fallback(
                runtime_x,
                runtime_y,
                &player_runtime.map_id,
            );
            let resolver = resolver_by_map_id.get(source_map_id).ok_or_else(|| {
                format!(
                    "missing render resolver for source_map_id={source_map_id}; active_pair_id={active_pair_id}; metatile_id={}",
                    packed & rebuild_v2_server::map_runtime::MAPGRID_METATILE_ID_MASK
                )
            })?;
            let source_pair_id = resolver.pair_id();
            let metatile = resolver.resolve(packed).map_err(|err| {
                format!(
                    "metatile resolve failed: source_map_id={source_map_id}, active_pair_id={active_pair_id}, source_pair_id={source_pair_id}, metatile_id={}, runtime_x={runtime_x}, runtime_y={runtime_y}, error={err}",
                    packed & rebuild_v2_server::map_runtime::MAPGRID_METATILE_ID_MASK
                )
            })?;
            metatiles.push(metatile);
        }
    }

    let render_state = RenderStateV1 {
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
    };

    Ok(BuildRenderPayload {
        render_state,
        asset_manifest: build_asset_manifest(render_assets),
    })
}

fn build_asset_manifest(render_assets: &LayoutRenderAssets) -> AssetManifest {
    let asset_base_url =
        env::var("V2_ASSET_BASE_URL").unwrap_or_else(|_| DEFAULT_ASSET_BASE_URL.to_string());
    let asset_version =
        env::var("V2_ASSET_VERSION").unwrap_or_else(|_| DEFAULT_ASSET_VERSION.to_string());
    let normalized_base = asset_base_url.trim_end_matches('/').to_string();

    AssetManifest {
        asset_base_url: normalized_base.clone(),
        asset_version,
        tileset_pair_id: render_assets.pair_id.clone(),
        atlas_url: Some(build_asset_url(&normalized_base, &render_assets.atlas)),
        palettes_url: Some(build_asset_url(&normalized_base, &render_assets.palettes)),
        metatiles_url: Some(build_asset_url(&normalized_base, &render_assets.metatiles)),
    }
}

fn build_asset_url(base_url: &str, relative_path: &str) -> String {
    let normalized_path = relative_path.trim_start_matches('/');
    if base_url.is_empty() {
        return format!("/{normalized_path}");
    }
    format!("{base_url}/{normalized_path}")
}

async fn send_json(socket: &mut WebSocket, message: &ServerMessage) -> Result<(), ()> {
    let payload = serde_json::to_string(message).map_err(|_| ())?;
    socket
        .send(Message::Text(payload.into()))
        .await
        .map_err(|_| ())
}

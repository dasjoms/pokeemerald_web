use serde::Serialize;

pub const RENDER_WINDOW_WIDTH: usize = 16;
pub const RENDER_WINDOW_HEIGHT: usize = 16;

#[derive(Debug, Serialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum ServerMessage {
    ServerHello {
        protocol_version: u16,
        server_authority: bool,
        client_version_echo: String,
        asset_manifest: AssetManifest,
    },
    RenderStateV1 {
        #[serde(flatten)]
        state: RenderStateV1,
    },
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AssetManifest {
    pub asset_base_url: String,
    pub asset_version: String,
    pub tileset_pair_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub atlas_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub palettes_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metatiles_url: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderStateV1 {
    pub protocol_version: u16,
    pub map_id: String,
    pub tileset_pair_id: String,
    pub camera: CameraAnchor,
    pub scroll: BgScroll,
    pub movement: MovementFrame,
    pub wheel: CameraWheelFrame,
    pub window: RenderWindow,
    pub metatiles: Vec<RenderMetatile>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CameraAnchor {
    pub runtime_x: i32,
    pub runtime_y: i32,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BgScroll {
    pub x_pixel_offset: i32,
    pub y_pixel_offset: i32,
    pub horizontal_pan: i32,
    pub vertical_pan: i32,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MovementFrame {
    pub running_state: String,
    pub tile_transition_state: String,
    pub facing_direction: String,
    pub movement_direction: String,
    pub step_timer: u8,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CameraWheelFrame {
    pub camera_pos_x: i32,
    pub camera_pos_y: i32,
    pub x_tile_offset: i32,
    pub y_tile_offset: i32,
    pub strip_redraws: Vec<StripRedrawFrame>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct StripRedrawFrame {
    pub dest_x: i32,
    pub dest_y: i32,
    pub world_x: i32,
    pub world_y: i32,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderWindow {
    pub origin_runtime_x: i32,
    pub origin_runtime_y: i32,
    pub width: usize,
    pub height: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderMetatile {
    pub packed_raw: u16,
    pub metatile_id: u16,
    pub collision: u8,
    pub elevation: u8,
    pub layer_type: u8,
    pub subtiles: [RenderSubtile; 8],
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderSubtile {
    pub subtile_index: u8,
    pub tile_index: u16,
    pub palette_index: u8,
    pub hflip: bool,
    pub vflip: bool,
    pub layer: u8,
    pub layer_order: u8,
}

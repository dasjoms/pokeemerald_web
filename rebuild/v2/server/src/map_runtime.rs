use std::{
    collections::HashMap,
    fmt, fs,
    path::{Path, PathBuf},
};

use serde::Deserialize;

pub const MAP_OFFSET: usize = 7;
pub const MAP_OFFSET_W: usize = MAP_OFFSET * 2 + 1;
pub const MAP_OFFSET_H: usize = MAP_OFFSET * 2;
pub const MAPGRID_UNDEFINED: u16 = 0x03FF;
pub const MAPGRID_IMPASSABLE: u16 = 0x0C00;
pub const MAX_MAP_DATA_SIZE: usize = 10_240;

#[derive(Debug, Clone)]
pub struct RuntimeMapGrid {
    pub width: usize,
    pub height: usize,
    pub tiles: Vec<u16>,
    pub border_tiles: [u16; 4],
}

impl RuntimeMapGrid {
    pub fn get_packed_with_border_fallback(&self, x: i32, y: i32) -> u16 {
        if x >= 0 && y >= 0 && (x as usize) < self.width && (y as usize) < self.height {
            self.tiles[x as usize + y as usize * self.width]
        } else {
            let mut i = ((x + 1) & 1) as usize;
            i += (((y + 1) & 1) as usize) * 2;
            self.border_tiles[i] | MAPGRID_IMPASSABLE
        }
    }
}

#[derive(Debug)]
pub enum MapRuntimeError {
    Io(std::io::Error),
    Json(serde_json::Error),
    MissingMap(String),
    MissingLayout(String),
    InvalidBorderLength { layout_id: String, len: usize },
}

impl fmt::Display for MapRuntimeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io(err) => write!(f, "i/o error: {err}"),
            Self::Json(err) => write!(f, "json parse error: {err}"),
            Self::MissingMap(map_id) => write!(f, "map id not found in maps_index.json: {map_id}"),
            Self::MissingLayout(layout_id) => {
                write!(f, "layout file not found for id: {layout_id}")
            }
            Self::InvalidBorderLength { layout_id, len } => {
                write!(f, "layout {layout_id} must have 4 border tiles, got {len}")
            }
        }
    }
}

impl std::error::Error for MapRuntimeError {}

impl From<std::io::Error> for MapRuntimeError {
    fn from(value: std::io::Error) -> Self {
        Self::Io(value)
    }
}

impl From<serde_json::Error> for MapRuntimeError {
    fn from(value: serde_json::Error) -> Self {
        Self::Json(value)
    }
}

#[derive(Debug, Deserialize, Clone)]
pub struct LayoutAsset {
    pub id: String,
    pub width: usize,
    pub height: usize,
    pub tiles: Vec<PackedTile>,
    pub border_tiles: Vec<PackedTile>,
}

#[derive(Debug, Deserialize, Clone)]
pub struct PackedTile {
    pub raw: u16,
}

#[derive(Debug, Deserialize)]
struct MapsIndexAsset {
    maps: Vec<MapAsset>,
}

#[derive(Debug, Deserialize, Clone)]
struct MapAsset {
    map_id: String,
    layout_id: String,
    #[serde(default)]
    connections: Vec<MapConnectionAsset>,
}

#[derive(Debug, Deserialize, Clone)]
struct MapConnectionAsset {
    direction: String,
    offset: i32,
    target_map_id: String,
}

pub struct RuntimeMapAssembler {
    asset_root: PathBuf,
    maps_by_id: HashMap<String, MapAsset>,
}

impl RuntimeMapAssembler {
    pub fn from_asset_root(asset_root: impl AsRef<Path>) -> Result<Self, MapRuntimeError> {
        let asset_root = asset_root.as_ref().to_path_buf();
        let maps_index: MapsIndexAsset =
            serde_json::from_str(&fs::read_to_string(asset_root.join("maps_index.json"))?)?;
        let maps_by_id = maps_index
            .maps
            .into_iter()
            .map(|map| (map.map_id.clone(), map))
            .collect();

        Ok(Self {
            asset_root,
            maps_by_id,
        })
    }

    pub fn build_for_map_id(
        &self,
        map_id: &str,
    ) -> Result<Option<RuntimeMapGrid>, MapRuntimeError> {
        let active_map = match self.maps_by_id.get(map_id) {
            Some(map) => map,
            None => return Err(MapRuntimeError::MissingMap(map_id.to_owned())),
        };

        let active_layout = self.load_layout(&active_map.layout_id)?;
        let mut runtime = assemble_runtime_grid(&active_layout, MAX_MAP_DATA_SIZE)?;

        if runtime.width * runtime.height <= MAX_MAP_DATA_SIZE {
            for connection in &active_map.connections {
                if connection.target_map_id.trim().is_empty() {
                    continue;
                }

                let connected_map = self
                    .maps_by_id
                    .get(&connection.target_map_id)
                    .ok_or_else(|| MapRuntimeError::MissingMap(connection.target_map_id.clone()))?;
                let connected_layout = self.load_layout(&connected_map.layout_id)?;
                fill_declared_connection(
                    &mut runtime,
                    &active_layout,
                    &connected_layout,
                    connection,
                );
            }
        }

        Ok(Some(runtime))
    }

    fn load_layout(&self, layout_id: &str) -> Result<LayoutAsset, MapRuntimeError> {
        let path = self
            .asset_root
            .join("layouts")
            .join(format!("{layout_id}.json"));
        if !path.exists() {
            return Err(MapRuntimeError::MissingLayout(layout_id.to_owned()));
        }

        let layout: LayoutAsset = serde_json::from_str(&fs::read_to_string(path)?)?;
        Ok(layout)
    }
}

pub fn assemble_runtime_grid(
    active_layout: &LayoutAsset,
    max_map_data_size: usize,
) -> Result<RuntimeMapGrid, MapRuntimeError> {
    let runtime_width = active_layout.width + MAP_OFFSET_W;
    let runtime_height = active_layout.height + MAP_OFFSET_H;
    let mut tiles = vec![MAPGRID_UNDEFINED; runtime_width * runtime_height];
    if runtime_width * runtime_height <= max_map_data_size {
        for y in 0..active_layout.height {
            let src_start = y * active_layout.width;
            let dst_start = MAP_OFFSET + (MAP_OFFSET + y) * runtime_width;
            let src_end = src_start + active_layout.width;
            let dst_end = dst_start + active_layout.width;
            for (dst, src) in tiles[dst_start..dst_end]
                .iter_mut()
                .zip(active_layout.tiles[src_start..src_end].iter())
            {
                *dst = src.raw;
            }
        }
    }

    let border_tiles = extract_border_tiles(active_layout)?;

    Ok(RuntimeMapGrid {
        width: runtime_width,
        height: runtime_height,
        tiles,
        border_tiles,
    })
}

fn extract_border_tiles(layout: &LayoutAsset) -> Result<[u16; 4], MapRuntimeError> {
    if layout.border_tiles.len() != 4 {
        return Err(MapRuntimeError::InvalidBorderLength {
            layout_id: layout.id.clone(),
            len: layout.border_tiles.len(),
        });
    }
    Ok([
        layout.border_tiles[0].raw,
        layout.border_tiles[1].raw,
        layout.border_tiles[2].raw,
        layout.border_tiles[3].raw,
    ])
}

fn fill_declared_connection(
    runtime: &mut RuntimeMapGrid,
    active_layout: &LayoutAsset,
    connected_layout: &LayoutAsset,
    connection: &MapConnectionAsset,
) {
    match connection.direction.as_str() {
        "down" => {
            fill_south_connection(runtime, active_layout, connected_layout, connection.offset)
        }
        "up" => fill_north_connection(runtime, connected_layout, connection.offset),
        "left" => fill_west_connection(runtime, connected_layout, connection.offset),
        "right" => {
            fill_east_connection(runtime, active_layout, connected_layout, connection.offset)
        }
        _ => {}
    }
}

fn fill_connection(
    runtime: &mut RuntimeMapGrid,
    connected_layout: &LayoutAsset,
    dest_x: i32,
    dest_y: i32,
    src_x: i32,
    src_y: i32,
    width: i32,
    height: i32,
) {
    if width <= 0 || height <= 0 {
        return;
    }

    for row in 0..height as usize {
        let src_start = (src_x as usize) + (src_y as usize + row) * connected_layout.width;
        let src_end = src_start + width as usize;
        let dst_start = (dest_x as usize) + (dest_y as usize + row) * runtime.width;
        let dst_end = dst_start + width as usize;

        for (dst, src) in runtime.tiles[dst_start..dst_end]
            .iter_mut()
            .zip(connected_layout.tiles[src_start..src_end].iter())
        {
            *dst = src.raw;
        }
    }
}

fn fill_south_connection(
    runtime: &mut RuntimeMapGrid,
    active_layout: &LayoutAsset,
    connected_layout: &LayoutAsset,
    offset: i32,
) {
    let c_width = connected_layout.width as i32;
    let mut x = offset + MAP_OFFSET as i32;
    let y = (active_layout.height + MAP_OFFSET) as i32;
    let src_x;
    let copy_width;

    if x < 0 {
        src_x = -x;
        x += c_width;
        copy_width = x.min(runtime.width as i32);
        x = 0;
    } else {
        src_x = 0;
        copy_width = if x + c_width < runtime.width as i32 {
            c_width
        } else {
            runtime.width as i32 - x
        };
    }

    fill_connection(
        runtime,
        connected_layout,
        x,
        y,
        src_x,
        0,
        copy_width,
        MAP_OFFSET as i32,
    );
}

fn fill_north_connection(
    runtime: &mut RuntimeMapGrid,
    connected_layout: &LayoutAsset,
    offset: i32,
) {
    let c_width = connected_layout.width as i32;
    let c_height = connected_layout.height as i32;
    let mut x = offset + MAP_OFFSET as i32;
    let src_y = c_height - MAP_OFFSET as i32;
    let src_x;
    let copy_width;

    if x < 0 {
        src_x = -x;
        x += c_width;
        copy_width = x.min(runtime.width as i32);
        x = 0;
    } else {
        src_x = 0;
        copy_width = if x + c_width < runtime.width as i32 {
            c_width
        } else {
            runtime.width as i32 - x
        };
    }

    fill_connection(
        runtime,
        connected_layout,
        x,
        0,
        src_x,
        src_y,
        copy_width,
        MAP_OFFSET as i32,
    );
}

fn fill_west_connection(runtime: &mut RuntimeMapGrid, connected_layout: &LayoutAsset, offset: i32) {
    let c_width = connected_layout.width as i32;
    let c_height = connected_layout.height as i32;
    let mut y = offset + MAP_OFFSET as i32;
    let src_x = c_width - MAP_OFFSET as i32;
    let src_y;
    let copy_height;

    if y < 0 {
        src_y = -y;
        copy_height = if y + c_height < runtime.height as i32 {
            y + c_height
        } else {
            runtime.height as i32
        };
        y = 0;
    } else {
        src_y = 0;
        copy_height = if y + c_height < runtime.height as i32 {
            c_height
        } else {
            runtime.height as i32 - y
        };
    }

    fill_connection(
        runtime,
        connected_layout,
        0,
        y,
        src_x,
        src_y,
        MAP_OFFSET as i32,
        copy_height,
    );
}

fn fill_east_connection(
    runtime: &mut RuntimeMapGrid,
    active_layout: &LayoutAsset,
    connected_layout: &LayoutAsset,
    offset: i32,
) {
    let c_height = connected_layout.height as i32;
    let x = (active_layout.width + MAP_OFFSET) as i32;
    let mut y = offset + MAP_OFFSET as i32;
    let src_y;
    let copy_height;

    if y < 0 {
        src_y = -y;
        copy_height = if y + c_height < runtime.height as i32 {
            y + c_height
        } else {
            runtime.height as i32
        };
        y = 0;
    } else {
        src_y = 0;
        copy_height = if y + c_height < runtime.height as i32 {
            c_height
        } else {
            runtime.height as i32 - y
        };
    }

    fill_connection(
        runtime,
        connected_layout,
        x,
        y,
        0,
        src_y,
        (MAP_OFFSET + 1) as i32,
        copy_height,
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mk_layout(
        id: &str,
        width: usize,
        height: usize,
        start_raw: u16,
        border: [u16; 4],
    ) -> LayoutAsset {
        let mut v = Vec::with_capacity(width * height);
        for i in 0..(width * height) {
            v.push(PackedTile {
                raw: start_raw + i as u16,
            });
        }
        LayoutAsset {
            id: id.to_owned(),
            width,
            height,
            tiles: v,
            border_tiles: border.into_iter().map(|raw| PackedTile { raw }).collect(),
        }
    }

    fn get(runtime: &RuntimeMapGrid, x: usize, y: usize) -> u16 {
        runtime.tiles[x + y * runtime.width]
    }

    #[test]
    fn active_map_origin_and_runtime_size_match_emerald_offsets() {
        let active = mk_layout("A", 3, 2, 100, [1, 2, 3, 4]);
        let runtime = assemble_runtime_grid(&active, MAX_MAP_DATA_SIZE)
            .expect("runtime");

        assert_eq!(runtime.width, 3 + 15);
        assert_eq!(runtime.height, 2 + 14);
        assert_eq!(get(&runtime, 7, 7), 100);
        assert_eq!(get(&runtime, 9, 8), 105);
        assert_eq!(get(&runtime, 0, 0), MAPGRID_UNDEFINED);
    }

    #[test]
    fn east_is_8_columns_and_west_is_7_columns() {
        let active = mk_layout("A", 4, 4, 10, [1, 2, 3, 4]);
        let west = mk_layout("W", 9, 4, 1000, [1, 2, 3, 4]);
        let east = mk_layout("E", 12, 4, 2000, [1, 2, 3, 4]);
        let mut runtime = assemble_runtime_grid(&active, MAX_MAP_DATA_SIZE)
            .expect("runtime");

        fill_west_connection(&mut runtime, &west, 0);
        fill_east_connection(&mut runtime, &active, &east, 0);

        for x in 0..7 {
            assert_ne!(get(&runtime, x, 7), MAPGRID_UNDEFINED);
        }
        assert_eq!(get(&runtime, 7, 7), 10);

        let east_start = active.width + MAP_OFFSET;
        for x in east_start..(east_start + 8) {
            assert_eq!(get(&runtime, x, 7), 2000 + (x - east_start) as u16);
        }
    }

    #[test]
    fn north_and_south_connections_clip_for_negative_and_positive_offsets() {
        let active = mk_layout("A", 6, 5, 50, [1, 2, 3, 4]);
        let connected = mk_layout("N", 8, 12, 1000, [1, 2, 3, 4]);

        let mut runtime_neg = assemble_runtime_grid(&active, MAX_MAP_DATA_SIZE)
            .expect("runtime neg");
        fill_north_connection(&mut runtime_neg, &connected, -9);
        assert_eq!(
            get(&runtime_neg, 0, 0),
            connected.tiles[2 + 5 * connected.width].raw
        );

        let mut runtime_pos = assemble_runtime_grid(&active, MAX_MAP_DATA_SIZE)
            .expect("runtime pos");
        fill_south_connection(&mut runtime_pos, &active, &connected, 4);
        let sx = 4 + MAP_OFFSET;
        let sy = active.height + MAP_OFFSET;
        assert_eq!(get(&runtime_pos, sx, sy), connected.tiles[0].raw);
        assert_eq!(
            get(&runtime_pos, runtime_pos.width - 1, sy),
            MAPGRID_UNDEFINED
        );
    }

    #[test]
    fn west_and_east_connections_clip_for_negative_and_positive_offsets() {
        let active = mk_layout("A", 6, 5, 100, [1, 2, 3, 4]);
        let connected = mk_layout("C", 10, 8, 3000, [1, 2, 3, 4]);

        let mut runtime_neg = assemble_runtime_grid(&active, MAX_MAP_DATA_SIZE)
            .expect("runtime neg");
        fill_west_connection(&mut runtime_neg, &connected, -10);
        assert_eq!(
            get(&runtime_neg, 0, 0),
            connected.tiles[3 + 3 * connected.width].raw
        );

        let mut runtime_pos = assemble_runtime_grid(&active, MAX_MAP_DATA_SIZE)
            .expect("runtime pos");
        fill_east_connection(&mut runtime_pos, &active, &connected, 10);
        let x = active.width + MAP_OFFSET;
        let y = 10 + MAP_OFFSET;
        assert_eq!(get(&runtime_pos, x, y), connected.tiles[0].raw);
    }

    #[test]
    fn out_of_bounds_reads_use_border_2x2_index_and_impassable_collision() {
        let active = mk_layout("A", 2, 2, 10, [0x0001, 0x0002, 0x0003, 0x0004]);
        let runtime = assemble_runtime_grid(&active, MAX_MAP_DATA_SIZE)
            .expect("runtime");

        assert_eq!(
            runtime.get_packed_with_border_fallback(-1, -1),
            0x0001 | MAPGRID_IMPASSABLE
        );
        assert_eq!(
            runtime.get_packed_with_border_fallback(0, -1),
            0x0002 | MAPGRID_IMPASSABLE
        );
        assert_eq!(
            runtime.get_packed_with_border_fallback(-1, 0),
            0x0003 | MAPGRID_IMPASSABLE
        );
        assert_eq!(
            runtime.get_packed_with_border_fallback(0, 0),
            MAPGRID_UNDEFINED
        );
    }

    #[test]
    fn connection_fill_order_matches_declared_source_order() {
        let active = mk_layout("A", 4, 4, 10, [1, 2, 3, 4]);
        let east = mk_layout("E", 8, 8, 2000, [1, 2, 3, 4]);
        let south = mk_layout("S", 8, 8, 3000, [1, 2, 3, 4]);
        let mut runtime = assemble_runtime_grid(&active, MAX_MAP_DATA_SIZE)
            .expect("runtime");

        let declared = vec![
            MapConnectionAsset {
                direction: "right".to_string(),
                offset: 5,
                target_map_id: "MAP_E".to_string(),
            },
            MapConnectionAsset {
                direction: "down".to_string(),
                offset: 4,
                target_map_id: "MAP_S".to_string(),
            },
        ];

        for connection in &declared {
            let connected = if connection.direction == "right" {
                &east
            } else {
                &south
            };
            fill_declared_connection(&mut runtime, &active, connected, connection);
        }

        // Overlap cell should contain south because it is filled second.
        assert_eq!(get(&runtime, 11, 12), south.tiles[8].raw);
    }

    #[test]
    fn oversized_runtime_grid_still_returns_prefilled_buffer() {
        let active = mk_layout("A", 200, 100, 10, [1, 2, 3, 4]);
        let runtime = assemble_runtime_grid(&active, MAX_MAP_DATA_SIZE).expect("runtime");

        assert_eq!(runtime.width, active.width + MAP_OFFSET_W);
        assert_eq!(runtime.height, active.height + MAP_OFFSET_H);
        assert!(runtime.tiles.iter().all(|&tile| tile == MAPGRID_UNDEFINED));
    }
}

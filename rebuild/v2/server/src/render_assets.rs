use std::{fs, path::Path};

use serde::Deserialize;

use crate::{
    map_runtime::{
        LayoutAsset, MAPGRID_COLLISION_MASK, MAPGRID_COLLISION_SHIFT, MAPGRID_ELEVATION_MASK,
        MAPGRID_ELEVATION_SHIFT, MAPGRID_METATILE_ID_MASK,
    },
    render_state::{RenderMetatile, RenderSubtile},
};

const NUM_METATILES_IN_PRIMARY: usize = 512;

#[derive(Debug, Deserialize)]
struct MetatileAsset {
    tilesets: Vec<MetatileTileset>,
}

#[derive(Debug, Deserialize)]
struct MetatileTileset {
    metatiles: Vec<MetatileDefinition>,
}

#[derive(Debug, Deserialize)]
struct MetatileDefinition {
    layer_type: u8,
    subtiles: Vec<MetatileSubtile>,
}

#[derive(Debug, Deserialize)]
struct MetatileSubtile {
    subtile_index: u8,
    tile_index: u16,
    palette_index: u8,
    hflip: bool,
    vflip: bool,
    layer: u8,
    layer_order: u8,
}

pub struct RenderMetatileResolver {
    pair_id: String,
    metatiles: MetatileAsset,
}

impl RenderMetatileResolver {
    pub fn from_layout(asset_root: &Path, layout: &LayoutAsset) -> Result<Self, String> {
        let render_assets = layout
            .render_assets
            .as_ref()
            .ok_or_else(|| format!("layout {} missing render_assets", layout.id))?;

        let metatiles_path = asset_root.join(&render_assets.metatiles);
        let source = fs::read_to_string(&metatiles_path)
            .map_err(|err| format!("failed reading {}: {err}", metatiles_path.display()))?;
        let metatiles: MetatileAsset = serde_json::from_str(&source)
            .map_err(|err| format!("failed parsing {}: {err}", metatiles_path.display()))?;

        Ok(Self {
            pair_id: render_assets.pair_id.clone(),
            metatiles,
        })
    }

    pub fn resolve(&self, packed_raw: u16) -> Result<RenderMetatile, String> {
        let metatile_id = packed_raw & MAPGRID_METATILE_ID_MASK;
        let (tileset_index, in_tileset_index) = if metatile_id as usize >= NUM_METATILES_IN_PRIMARY
        {
            (1usize, metatile_id as usize - NUM_METATILES_IN_PRIMARY)
        } else {
            (0usize, metatile_id as usize)
        };

        let definition = self
            .metatiles
            .tilesets
            .get(tileset_index)
            .and_then(|tileset| tileset.metatiles.get(in_tileset_index))
            .ok_or_else(|| {
                format!(
                    "metatile definition missing: pair={}, metatile_id={metatile_id}",
                    self.pair_id
                )
            })?;

        let subtiles = to_subtiles(&definition.subtiles)?;
        let collision = ((packed_raw & MAPGRID_COLLISION_MASK) >> MAPGRID_COLLISION_SHIFT) as u8;
        let elevation = ((packed_raw & MAPGRID_ELEVATION_MASK) >> MAPGRID_ELEVATION_SHIFT) as u8;

        Ok(RenderMetatile {
            packed_raw,
            metatile_id,
            collision,
            elevation,
            layer_type: definition.layer_type,
            subtiles,
        })
    }

    pub fn pair_id(&self) -> &str {
        &self.pair_id
    }
}

fn to_subtiles(raw: &[MetatileSubtile]) -> Result<[RenderSubtile; 8], String> {
    if raw.len() < 8 {
        return Err(format!(
            "metatile subtile count must be >= 8, got {}",
            raw.len()
        ));
    }

    let mut out = [RenderSubtile {
        subtile_index: 0,
        tile_index: 0,
        palette_index: 0,
        hflip: false,
        vflip: false,
        layer: 0,
        layer_order: 0,
    }; 8];

    for (i, subtile) in raw.iter().take(8).enumerate() {
        out[i] = RenderSubtile {
            subtile_index: subtile.subtile_index,
            tile_index: subtile.tile_index,
            palette_index: subtile.palette_index,
            hflip: subtile.hflip,
            vflip: subtile.vflip,
            layer: subtile.layer,
            layer_order: subtile.layer_order,
        };
    }

    Ok(out)
}

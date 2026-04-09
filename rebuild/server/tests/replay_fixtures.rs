use std::{fs, path::PathBuf};

use rebuild_server::{
    movement::{validate_walk, MoveValidation, MovementMap},
    protocol::Facing,
};
use serde::Deserialize;

const PRIMARY_METATILE_COUNT: usize = 512;

#[derive(Debug, Deserialize)]
struct Fixture {
    name: String,
    map_id: String,
    initial: PositionedFacing,
    inputs: Vec<Facing>,
    expected: Expected,
}

#[derive(Debug, Deserialize)]
struct PositionedFacing {
    x: u16,
    y: u16,
    facing: Facing,
}

#[derive(Debug, Deserialize)]
struct Expected {
    accepted: Vec<bool>,
    #[serde(rename = "final")]
    final_pos: PositionedFacing,
}

#[derive(Debug, Deserialize)]
struct Masks {
    #[serde(rename = "MAPGRID_METATILE_ID_MASK")]
    mapgrid_metatile_id_mask: u16,
    #[serde(rename = "MAPGRID_COLLISION_MASK")]
    mapgrid_collision_mask: u16,
    #[serde(rename = "MAPGRID_METATILE_ID_SHIFT")]
    mapgrid_metatile_id_shift: u8,
    #[serde(rename = "MAPGRID_COLLISION_SHIFT")]
    mapgrid_collision_shift: u8,
    #[serde(rename = "METATILE_ATTR_BEHAVIOR_MASK")]
    metatile_attr_behavior_mask: u16,
    #[serde(rename = "METATILE_ATTR_BEHAVIOR_SHIFT")]
    metatile_attr_behavior_shift: u8,
}

#[derive(Debug)]
struct SourceMap {
    map_id: String,
    width: u16,
    height: u16,
    collision: Vec<u8>,
    behavior: Vec<u8>,
}

#[derive(Debug, Deserialize)]
struct SourceMapInfo {
    id: String,
    layout: String,
}

#[derive(Debug, Deserialize)]
struct LayoutCatalog {
    layouts: Vec<LayoutRecord>,
}

#[derive(Debug, Deserialize)]
struct LayoutRecord {
    id: String,
    width: u16,
    height: u16,
    primary_tileset: String,
    secondary_tileset: String,
    blockdata_filepath: String,
}

#[test]
fn littleroot_movement_replay_fixtures_remain_deterministic() {
    let repo_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..");

    let source_map = load_littleroot_source_map(&repo_root);
    let fixtures = load_fixtures(&repo_root);

    for fixture in fixtures {
        assert_eq!(
            fixture.map_id, source_map.map_id,
            "fixture {} map_id drift",
            fixture.name
        );
        assert_eq!(
            fixture.inputs.len(),
            fixture.expected.accepted.len(),
            "fixture {} has mismatched input and expected acceptance lengths",
            fixture.name
        );

        let mut x = fixture.initial.x;
        let mut y = fixture.initial.y;
        let mut facing = fixture.initial.facing;
        let mut acceptance = Vec::with_capacity(fixture.inputs.len());

        for input in &fixture.inputs {
            facing = *input;
            let result = validate_walk(
                x,
                y,
                *input,
                MovementMap {
                    width: source_map.width,
                    height: source_map.height,
                    collision: &source_map.collision,
                    behavior: &source_map.behavior,
                },
                None,
            );
            match result {
                MoveValidation::Accepted { next_x, next_y } => {
                    x = next_x;
                    y = next_y;
                    acceptance.push(true);
                }
                MoveValidation::Rejected(_) => {
                    acceptance.push(false);
                }
            }
        }

        assert_eq!(
            acceptance, fixture.expected.accepted,
            "fixture {} acceptance sequence drifted",
            fixture.name
        );
        assert_eq!(
            x, fixture.expected.final_pos.x,
            "fixture {} final x drift",
            fixture.name
        );
        assert_eq!(
            y, fixture.expected.final_pos.y,
            "fixture {} final y drift",
            fixture.name
        );
        assert_eq!(
            facing, fixture.expected.final_pos.facing,
            "fixture {} final facing drift",
            fixture.name
        );
    }
}

fn load_fixtures(repo_root: &std::path::Path) -> Vec<Fixture> {
    let fixture_dir = repo_root.join("rebuild/tests/fixtures");
    let mut fixture_paths = fs::read_dir(&fixture_dir)
        .expect("fixture directory should exist")
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.starts_with("littleroot_"))
        })
        .filter(|path| path.extension().is_some_and(|ext| ext == "json"))
        .collect::<Vec<_>>();
    fixture_paths.sort();

    let fixtures = fixture_paths
        .into_iter()
        .map(|path| {
            let raw = fs::read_to_string(&path)
                .unwrap_or_else(|_| panic!("failed to read fixture file {}", path.display()));
            serde_json::from_str(&raw)
                .unwrap_or_else(|_| panic!("failed to parse fixture file {}", path.display()))
        })
        .collect::<Vec<_>>();

    assert!(
        !fixtures.is_empty(),
        "expected at least one littleroot movement fixture in {}",
        fixture_dir.display()
    );

    fixtures
}

fn load_littleroot_source_map(repo_root: &std::path::Path) -> SourceMap {
    let map_info: SourceMapInfo = read_json(repo_root.join("data/maps/LittlerootTown/map.json"));
    assert_eq!(map_info.layout, "LAYOUT_LITTLEROOT_TOWN");

    let catalog: LayoutCatalog = read_json(repo_root.join("data/layouts/layouts.json"));
    let layout = catalog
        .layouts
        .into_iter()
        .find(|record| record.id == map_info.layout)
        .expect("littleroot layout must be present in layout catalog");

    let masks: Masks = read_json(repo_root.join("rebuild/assets/meta/masks.json"));

    let block_words = read_u16_words(repo_root.join(&layout.blockdata_filepath));
    assert_eq!(
        block_words.len(),
        layout.width as usize * layout.height as usize,
        "Littleroot blockdata dimensions changed unexpectedly"
    );

    let primary_attrs = read_u16_words(repo_root.join(tileset_attr_path(&layout.primary_tileset)));
    let secondary_attrs =
        read_u16_words(repo_root.join(tileset_attr_path(&layout.secondary_tileset)));

    let mut collision = Vec::with_capacity(block_words.len());
    let mut behavior = Vec::with_capacity(block_words.len());

    for raw_block in block_words {
        let metatile_id = ((raw_block & masks.mapgrid_metatile_id_mask)
            >> masks.mapgrid_metatile_id_shift) as usize;
        let collision_bits =
            ((raw_block & masks.mapgrid_collision_mask) >> masks.mapgrid_collision_shift) as u8;

        let attr = if metatile_id < PRIMARY_METATILE_COUNT {
            *primary_attrs
                .get(metatile_id)
                .expect("primary metatile attr index out of range")
        } else {
            let secondary_id = metatile_id - PRIMARY_METATILE_COUNT;
            *secondary_attrs
                .get(secondary_id)
                .expect("secondary metatile attr index out of range")
        };

        let behavior_id = ((attr & masks.metatile_attr_behavior_mask)
            >> masks.metatile_attr_behavior_shift) as u8;

        collision.push(collision_bits);
        behavior.push(behavior_id);
    }

    SourceMap {
        map_id: map_info.id,
        width: layout.width,
        height: layout.height,
        collision,
        behavior,
    }
}

fn read_u16_words(path: PathBuf) -> Vec<u16> {
    let raw = fs::read(path).expect("binary source file should be readable");
    assert_eq!(
        raw.len() % 2,
        0,
        "source binary should have even byte length"
    );

    raw.chunks_exact(2)
        .map(|chunk| u16::from_le_bytes([chunk[0], chunk[1]]))
        .collect()
}

fn read_json<T: for<'de> Deserialize<'de>>(path: PathBuf) -> T {
    let raw = fs::read_to_string(path).expect("json source file should be readable");
    serde_json::from_str(&raw).expect("json source file should parse")
}

fn tileset_attr_path(tileset: &str) -> &'static str {
    match tileset {
        "gTileset_General" => "data/tilesets/primary/general/metatile_attributes.bin",
        "gTileset_Petalburg" => "data/tilesets/secondary/petalburg/metatile_attributes.bin",
        _ => panic!("unsupported tileset in Littleroot fixture seed source: {tileset}"),
    }
}

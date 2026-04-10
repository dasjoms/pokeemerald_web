# `rebuild/tools`

Extraction and parity tooling.

## Map data extractor / validator

Use the rebuild-owned extractor to convert legacy reference map/layout/tileset metadata into rebuild-native artifacts:

```bash
python3 -m rebuild.tools.map_assets.cli validate
python3 -m rebuild.tools.map_assets.cli extract --clean --output-dir rebuild/assets
python3 -m rebuild.tools.map_assets.cli extract-render --clean --output-dir rebuild/assets
python3 -m rebuild.tools.map_assets.cli validate-render --output-dir rebuild/assets
```

### Commands

- `validate`
  - Checks that all map/layout/tileset files referenced by source JSON/C headers exist.
  - Prints loaded counts for maps, layouts, and tilesets.

- `extract`
  - Writes artifacts under `rebuild/assets/` (or a custom output dir).
  - Produces:
    - `maps_index.json` preserving map group ordering/indexes.
    - `layouts_index.json` with layout dimensions and decode file pointers.
    - `meta/masks.json` from `include/global.fieldmap.h`.
    - `meta/metatile_behaviors.json` from `include/constants/metatile_behaviors.h`.
    - Per-layout decoded block data in `layouts/<LAYOUT_ID>.json` (metatile id/collision/elevation/behavior id).

- `extract-render`
  - Runs `extract` and then generates render data under `render/`:
    - per-pair atlas image references
    - per-pair decoded metatile subtile definitions
    - per-pair decoded palettes
  - Automatically runs render parity validation before completion.

- `validate-render`
  - Validates extracted render data for parity safety before visual QA:
    - every metatile referenced by decoded layouts resolves to a renderable metatile entry,
    - every referenced tile index and palette index is in bounds for atlas/palette tables,
    - failures stop with contextual details (layout file + tileset IDs),
    - prints a summary report (layouts checked, metatiles resolved, unresolved count).


## Field effect asset extractor / validator

Use the rebuild-owned extractor to convert Acro-bike hop field-effect definitions into rebuild-native metadata artifacts and runtime source copies:

```bash
python3 -m rebuild.tools.field_effect_assets.cli validate
python3 -m rebuild.tools.field_effect_assets.cli extract --clean --output-dir rebuild/assets
```

### Commands

- `validate`
  - Checks ROM-reference symbols and animation/template metadata for:
    - hop shadows (`FLDEFF_SHADOW`),
    - landing dust (`FLDEFF_DUST` / ground impact dust).

- `extract`
  - Writes artifacts under `rebuild/assets/field_effects/` (or a custom output dir):
    - `acro_bike_effects_manifest.json` with versioned metadata for shadow template mapping, vertical offsets, dust frame timing, source symbols, and palette references.
    - runtime source copies under `field_effects/acro_bike/`:
      - `pics/*.png` (resolved from declared `.4bpp` sources when available as PNG),
      - `palettes/*.gbapal` or `palettes/*.pal` (fallback when declared `.gbapal` resolves to `.pal` in source tree),
      - `runtime_asset_index.json` mapping symbols + declared source paths to emitted files.

## Player asset extractor / validator

Use the rebuild-owned extractor to convert player avatar object-event definitions into rebuild-native artifacts:

```bash
python3 -m rebuild.tools.player_assets.cli validate
python3 -m rebuild.tools.player_assets.cli extract --clean --output-dir rebuild/assets
```

### Commands

- `validate`
  - Checks Brendan/May player references from object event graphics/pic tables/graphics info/anim table definitions.
  - Verifies required source assets and prints summary frame/dimension counts.

- `extract`
  - Writes artifacts under `rebuild/assets/players/` (or a custom output dir):
    - `players_manifest.json` with versioned avatar metadata (atlas mapping, palettes, dimensions/anchor, face/walk/run directional animation bindings).
    - Source player sprite sheets and palette files for Brendan/May and bridge reflection palette.

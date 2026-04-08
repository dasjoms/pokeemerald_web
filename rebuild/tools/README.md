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

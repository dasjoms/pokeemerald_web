# `rebuild/tools`

Extraction and parity tooling.

## Map data extractor / validator

Use the rebuild-owned extractor to convert legacy reference map/layout/tileset metadata into rebuild-native artifacts:

```bash
python3 -m rebuild.tools.map_assets.cli validate
python3 -m rebuild.tools.map_assets.cli extract --clean --output-dir rebuild/assets
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

> Do not commit extracted asset output; regenerate locally as needed.

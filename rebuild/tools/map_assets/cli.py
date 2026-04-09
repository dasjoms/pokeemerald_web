#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import re
import shutil
import struct
import zlib
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from rebuild.shared.mapgrid import (
    DEFAULT_MAPGRID_MASKS,
    decode_map_block,
    decode_metatile_attr,
)

ROOT = Path(__file__).resolve().parents[3]
PRIMARY_METATILE_COUNT = 512
NUM_TILES_IN_PRIMARY = 512
METATILE_ENTRY_TILE_INDEX_MASK = 0x03FF
METATILE_ENTRY_HFLIP_MASK = 0x0400
METATILE_ENTRY_VFLIP_MASK = 0x0800
METATILE_ENTRY_PALETTE_MASK = 0xF000
METATILE_ENTRY_PALETTE_SHIFT = 12
METATILE_SUBTILE_COUNT = 8


@dataclass(frozen=True)
class LayoutRecord:
    id: str
    name: str
    width: int
    height: int
    primary_tileset: str
    secondary_tileset: str
    border_filepath: str
    blockdata_filepath: str


@dataclass(frozen=True)
class ResolvedAnimFrameSource:
    symbol: str
    source_path: str
    render_extension: str
    data: bytes
    width: int | None
    height: int | None
    tile_count: int | None


TILE_ANIMS_VERSION = 2


def read_json(path: Path) -> Any:
    with path.open("r", encoding="utf-8") as f:
        return json.load(f)


def read_u16_le(path: Path) -> list[int]:
    raw = path.read_bytes()
    if len(raw) % 2 != 0:
        raise ValueError(f"Expected even byte length for u16 file: {path}")
    return [int.from_bytes(raw[i : i + 2], "little") for i in range(0, len(raw), 2)]


def parse_mapgrid_masks() -> dict[str, int]:
    content = (ROOT / "include/global.fieldmap.h").read_text(encoding="utf-8")

    def macro(name: str) -> int:
        match = re.search(rf"#define\s+{name}\s+(0x[0-9A-Fa-f]+|\d+)", content)
        if not match:
            raise ValueError(f"Missing macro {name} in include/global.fieldmap.h")
        return int(match.group(1), 0)

    return {
        "MAPGRID_METATILE_ID_MASK": macro("MAPGRID_METATILE_ID_MASK"),
        "MAPGRID_COLLISION_MASK": macro("MAPGRID_COLLISION_MASK"),
        "MAPGRID_ELEVATION_MASK": macro("MAPGRID_ELEVATION_MASK"),
        "MAPGRID_METATILE_ID_SHIFT": macro("MAPGRID_METATILE_ID_SHIFT"),
        "MAPGRID_COLLISION_SHIFT": macro("MAPGRID_COLLISION_SHIFT"),
        "MAPGRID_ELEVATION_SHIFT": macro("MAPGRID_ELEVATION_SHIFT"),
        "METATILE_ATTR_BEHAVIOR_MASK": macro("METATILE_ATTR_BEHAVIOR_MASK"),
        "METATILE_ATTR_LAYER_MASK": macro("METATILE_ATTR_LAYER_MASK"),
        "METATILE_ATTR_BEHAVIOR_SHIFT": macro("METATILE_ATTR_BEHAVIOR_SHIFT"),
        "METATILE_ATTR_LAYER_SHIFT": macro("METATILE_ATTR_LAYER_SHIFT"),
    }


def parse_behavior_ids() -> list[dict[str, Any]]:
    path = ROOT / "include/constants/metatile_behaviors.h"
    lines = path.read_text(encoding="utf-8").splitlines()
    in_enum = False
    behaviors: list[dict[str, Any]] = []
    for line in lines:
        stripped = line.strip()
        if stripped == "enum {":
            in_enum = True
            continue
        if not in_enum:
            continue
        if stripped.startswith("};"):
            break
        if not stripped or stripped.startswith("//"):
            continue

        token = stripped.split("//", 1)[0].strip().rstrip(",")
        if token == "NUM_METATILE_BEHAVIORS":
            break
        behaviors.append({"id": len(behaviors), "name": token})
    return behaviors


def parse_tileset_attr_file_map() -> dict[str, str]:
    metatiles_h = (ROOT / "src/data/tilesets/metatiles.h").read_text(encoding="utf-8")
    symbol_to_path = dict(
        re.findall(
            r"const\s+u16\s+(gMetatileAttributes_[A-Za-z0-9_]+)\[]\s*=\s*INCBIN_U16\(\"([^\"]+)\"\);",
            metatiles_h,
        )
    )

    headers_h = (ROOT / "src/data/tilesets/headers.h").read_text(encoding="utf-8")
    tileset_to_attr_symbol: dict[str, str] = {}
    block_pattern = re.compile(
        r"const\s+struct\s+Tileset\s+(gTileset_[A-Za-z0-9_]+)\s*=\s*\{(.*?)\};",
        re.S,
    )
    for tileset_name, block_body in block_pattern.findall(headers_h):
        attr_match = re.search(r"\.metatileAttributes\s*=\s*(gMetatileAttributes_[A-Za-z0-9_]+)", block_body)
        if attr_match:
            tileset_to_attr_symbol[tileset_name] = attr_match.group(1)

    output: dict[str, str] = {}
    for tileset_name, attr_symbol in tileset_to_attr_symbol.items():
        if attr_symbol not in symbol_to_path:
            raise ValueError(f"No metatile attribute source path for {attr_symbol} ({tileset_name})")
        output[tileset_name] = symbol_to_path[attr_symbol]
    return output


def parse_tileset_metatile_file_map() -> dict[str, str]:
    metatiles_h = (ROOT / "src/data/tilesets/metatiles.h").read_text(encoding="utf-8")
    symbol_to_path = dict(
        re.findall(
            r"const\s+u16\s+(gMetatiles_[A-Za-z0-9_]+)\[]\s*=\s*INCBIN_U16\(\"([^\"]+)\"\);",
            metatiles_h,
        )
    )

    headers_h = (ROOT / "src/data/tilesets/headers.h").read_text(encoding="utf-8")
    tileset_to_metatiles_symbol: dict[str, str] = {}
    block_pattern = re.compile(
        r"const\s+struct\s+Tileset\s+(gTileset_[A-Za-z0-9_]+)\s*=\s*\{(.*?)\};",
        re.S,
    )
    for tileset_name, block_body in block_pattern.findall(headers_h):
        metatile_match = re.search(r"\.metatiles\s*=\s*(gMetatiles_[A-Za-z0-9_]+)", block_body)
        if metatile_match:
            tileset_to_metatiles_symbol[tileset_name] = metatile_match.group(1)

    output: dict[str, str] = {}
    for tileset_name, metatile_symbol in tileset_to_metatiles_symbol.items():
        if metatile_symbol not in symbol_to_path:
            raise ValueError(f"No metatiles source path for {metatile_symbol} ({tileset_name})")
        output[tileset_name] = symbol_to_path[metatile_symbol]
    return output


def resolve_tiles_png_for_tileset(tileset_name: str, tileset_dir: Path) -> Path:
    direct = tileset_dir / "tiles.png"
    if direct.exists():
        return direct

    candidates = sorted(tileset_dir.glob("**/tiles.png"))
    if not candidates:
        raise ValueError(f"Missing tiles.png for {tileset_name}: {tileset_dir}")

    lowered = tileset_name.lower()
    for candidate in candidates:
        parts = {p.lower() for p in candidate.relative_to(tileset_dir).parts}
        if {"blue", "cave"} <= parts and "blue" in lowered:
            return candidate
        if {"red", "cave"} <= parts and "red" in lowered:
            return candidate
        if {"yellow", "cave"} <= parts and "yellow" in lowered:
            return candidate
        if {"brown", "cave"} <= parts and "brown" in lowered:
            return candidate
        if "tree" in parts and "tree" in lowered:
            return candidate
        if "shrub" in parts and "shrub" in lowered:
            return candidate

    return candidates[0]


def load_layouts() -> dict[str, LayoutRecord]:
    layouts_data = read_json(ROOT / "data/layouts/layouts.json")
    layouts: dict[str, LayoutRecord] = {}
    for item in layouts_data["layouts"]:
        rec = LayoutRecord(**item)
        layouts[rec.id] = rec
    return layouts


def load_map_group_index() -> dict[str, Any]:
    groups = read_json(ROOT / "data/maps/map_groups.json")
    map_entries: list[dict[str, Any]] = []
    for group_index, group_name in enumerate(groups["group_order"]):
        maps = groups[group_name]
        for map_index, map_name in enumerate(maps):
            map_json_path = ROOT / "data/maps" / map_name / "map.json"
            map_json = read_json(map_json_path)
            map_entries.append(
                {
                    "group_name": group_name,
                    "group_index": group_index,
                    "map_index": map_index,
                    "map_name": map_name,
                    "map_id": map_json.get("id"),
                    "layout_id": map_json.get("layout"),
                    "allow_cycling": bool(map_json.get("allow_cycling", True)),
                    "allow_running": bool(map_json.get("allow_running", True)),
                    "map_json_path": str(map_json_path.relative_to(ROOT)),
                    "connections": normalize_connections(map_json.get("connections")),
                }
            )
    return {
        "group_order": groups["group_order"],
        "maps": map_entries,
    }


def normalize_connections(raw_connections: Any) -> list[dict[str, Any]]:
    if not raw_connections:
        return []

    normalized: list[dict[str, Any]] = []
    for raw in raw_connections:
        if not isinstance(raw, dict):
            continue

        direction = str(raw.get("direction", "")).strip().lower()
        if direction not in {"up", "down", "left", "right"}:
            continue

        target_map_id = str(raw.get("map", "")).strip()
        if not target_map_id:
            continue

        try:
            offset = int(raw.get("offset", 0))
        except (TypeError, ValueError):
            continue

        normalized.append(
            {
                "direction": direction,
                "offset": offset,
                "target_map_id": target_map_id,
            }
        )

    return normalized


def decode_layout(
    layout: LayoutRecord,
    tileset_attr_data: dict[str, list[int]],
) -> dict[str, Any]:
    block_path = ROOT / layout.blockdata_filepath
    border_path = ROOT / layout.border_filepath
    blocks = read_u16_le(block_path)
    borders = read_u16_le(border_path)

    expected = layout.width * layout.height
    if len(blocks) != expected:
        if len(blocks) > expected:
            blocks = blocks[:expected]
        else:
            blocks = blocks + [DEFAULT_MAPGRID_MASKS.metatile_id_mask] * (expected - len(blocks))

    primary = tileset_attr_data[layout.primary_tileset]
    secondary = tileset_attr_data.get(layout.secondary_tileset, [])

    def behavior_for_metatile(metatile_id: int) -> int | None:
        if metatile_id < PRIMARY_METATILE_COUNT:
            return decode_metatile_attr(primary[metatile_id])["behavior_id"] if metatile_id < len(primary) else None
        secondary_index = metatile_id - PRIMARY_METATILE_COUNT
        return (
            decode_metatile_attr(secondary[secondary_index])["behavior_id"]
            if secondary_index < len(secondary)
            else None
        )

    decoded_tiles = []
    for raw in blocks:
        tile = decode_map_block(raw)
        tile["behavior_id"] = behavior_for_metatile(tile["metatile_id"])
        decoded_tiles.append(tile)

    decoded_border = []
    for raw in borders:
        tile = decode_map_block(raw)
        tile["behavior_id"] = behavior_for_metatile(tile["metatile_id"])
        decoded_border.append(tile)

    return {
        "id": layout.id,
        "name": layout.name,
        "width": layout.width,
        "height": layout.height,
        "primary_tileset": layout.primary_tileset,
        "secondary_tileset": layout.secondary_tileset,
        "blockdata_filepath": layout.blockdata_filepath,
        "border_filepath": layout.border_filepath,
        "tiles": decoded_tiles,
        "border_tiles": decoded_border,
    }


def run_extract(output_dir: Path, clean: bool) -> None:
    if clean and output_dir.exists():
        shutil.rmtree(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    masks = parse_mapgrid_masks()
    behavior_ids = parse_behavior_ids()
    layouts = load_layouts()
    group_index = load_map_group_index()
    tileset_attr_paths = parse_tileset_attr_file_map()

    tileset_attr_data = {
        name: read_u16_le(ROOT / attr_path)
        for name, attr_path in tileset_attr_paths.items()
    }

    (output_dir / "meta").mkdir(parents=True, exist_ok=True)
    (output_dir / "layouts").mkdir(parents=True, exist_ok=True)

    (output_dir / "meta/masks.json").write_text(json.dumps(masks, indent=2) + "\n", encoding="utf-8")
    (output_dir / "meta/metatile_behaviors.json").write_text(
        json.dumps({"behaviors": behavior_ids}, indent=2) + "\n", encoding="utf-8"
    )
    (output_dir / "maps_index.json").write_text(
        json.dumps(group_index, indent=2) + "\n", encoding="utf-8"
    )

    layout_summaries: list[dict[str, Any]] = []
    for layout in layouts.values():
        block_path = ROOT / layout.blockdata_filepath
        block_count = len(read_u16_le(block_path))
        expected = layout.width * layout.height
        if block_count != expected:
            print(
                f"warning: {layout.id} block count mismatch (expected {expected}, found {block_count}); "
                "normalizing during decode"
            )
        decoded = decode_layout(layout, tileset_attr_data)
        layout_summaries.append(
            {
                "id": decoded["id"],
                "name": decoded["name"],
                "width": decoded["width"],
                "height": decoded["height"],
                "primary_tileset": decoded["primary_tileset"],
                "secondary_tileset": decoded["secondary_tileset"],
                "decoded_path": f"layouts/{decoded['id']}.json",
            }
        )
        (output_dir / f"layouts/{layout.id}.json").write_text(json.dumps(decoded), encoding="utf-8")

    (output_dir / "layouts_index.json").write_text(
        json.dumps({"layouts": layout_summaries}, indent=2) + "\n", encoding="utf-8"
    )

    print(f"Extracted {len(layouts)} layouts and {len(group_index['maps'])} maps to {output_dir}")


def run_validate() -> None:
    layouts = load_layouts()
    groups = read_json(ROOT / "data/maps/map_groups.json")
    tileset_attr_paths = parse_tileset_attr_file_map()

    missing: list[Path] = []

    map_count = 0
    for group in groups["group_order"]:
        for map_name in groups[group]:
            map_path = ROOT / "data/maps" / map_name / "map.json"
            map_count += 1
            if not map_path.exists():
                missing.append(map_path)

    for layout in layouts.values():
        for rel in (layout.border_filepath, layout.blockdata_filepath):
            p = ROOT / rel
            if not p.exists():
                missing.append(p)

    tileset_count = 0
    for rel in sorted(set(tileset_attr_paths.values())):
        tileset_count += 1
        p = ROOT / rel
        if not p.exists():
            missing.append(p)

    if missing:
        print("Missing referenced files:")
        for m in missing:
            print(f"  - {m.relative_to(ROOT)}")
        raise SystemExit(1)

    print("Validation report")
    print(f"maps loaded: {map_count}")
    print(f"layouts loaded: {len(layouts)}")
    print(f"tilesets loaded: {tileset_count}")


def decode_jasc_palette(path: Path) -> list[list[int]]:
    lines = [line.strip() for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]
    if len(lines) < 4 or lines[0] != "JASC-PAL":
        raise ValueError(f"Unsupported palette format: {path}")
    color_count = int(lines[2])
    colors: list[list[int]] = []
    for line in lines[3 : 3 + color_count]:
        rgb = [int(part) for part in line.split()]
        if len(rgb) != 3:
            raise ValueError(f"Malformed palette entry in {path}: {line!r}")
        colors.append(rgb)
    return colors


def decode_metatile_entries(raw_entries: list[int]) -> list[dict[str, Any]]:
    if len(raw_entries) % METATILE_SUBTILE_COUNT != 0:
        raise ValueError(
            f"metatiles.bin u16 entry count ({len(raw_entries)}) is not divisible by {METATILE_SUBTILE_COUNT}"
        )

    metatiles: list[dict[str, Any]] = []
    for metatile_index in range(len(raw_entries) // METATILE_SUBTILE_COUNT):
        start = metatile_index * METATILE_SUBTILE_COUNT
        entries = raw_entries[start : start + METATILE_SUBTILE_COUNT]
        subtiles = []
        for sub_index, value in enumerate(entries):
            subtiles.append(
                {
                    "subtile_index": sub_index,
                    "tile_index": value & METATILE_ENTRY_TILE_INDEX_MASK,
                    "palette_index": (value & METATILE_ENTRY_PALETTE_MASK) >> METATILE_ENTRY_PALETTE_SHIFT,
                    "hflip": bool(value & METATILE_ENTRY_HFLIP_MASK),
                    "vflip": bool(value & METATILE_ENTRY_VFLIP_MASK),
                    "layer": 0 if sub_index < 4 else 1,
                    "layer_order": sub_index if sub_index < 4 else sub_index - 4,
                }
            )

        metatiles.append(
            {
                "metatile_index": metatile_index,
                "bottom_layer_subtiles": subtiles[:4],
                "top_layer_subtiles": subtiles[4:],
                "subtiles": subtiles,
            }
        )
    return metatiles


def read_png_dimensions(path: Path) -> tuple[int, int]:
    with path.open("rb") as png_file:
        header = png_file.read(24)
    if len(header) < 24 or header[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError(f"Unsupported PNG file header: {path}")
    width, height = struct.unpack(">II", header[16:24])
    if width <= 0 or height <= 0:
        raise ValueError(f"Invalid PNG dimensions for {path}: {width}x{height}")
    return width, height


def pair_id(primary_tileset: str, secondary_tileset: str) -> str:
    return f"{primary_tileset}__{secondary_tileset}".replace("/", "_")


def _parse_c_functions(content: str) -> dict[str, str]:
    functions: dict[str, str] = {}
    signature = re.compile(r"(?:static\s+)?void\s+([A-Za-z0-9_]+)\s*\([^)]*\)\s*\{", re.M)
    for match in signature.finditer(content):
        name = match.group(1)
        brace_index = match.end() - 1
        depth = 0
        end = brace_index
        while end < len(content):
            char = content[end]
            if char == "{":
                depth += 1
            elif char == "}":
                depth -= 1
                if depth == 0:
                    break
            end += 1
        functions[name] = content[brace_index + 1 : end]
    return functions


def _parse_tile_offset_expr(expr: str) -> int | None:
    normalized = expr.replace(" ", "")
    if normalized.startswith("NUM_TILES_IN_PRIMARY+"):
        try:
            return NUM_TILES_IN_PRIMARY + int(normalized.split("+", 1)[1], 0)
        except ValueError:
            return None
    try:
        return int(normalized, 0)
    except ValueError:
        return None


def _parse_tile_destinations(expr: str, vdest_arrays: dict[str, list[int]]) -> list[int]:
    match = re.search(r"TILE_OFFSET_4BPP\(([^)]+)\)", expr)
    if match:
        tile_index = _parse_tile_offset_expr(match.group(1))
        return [tile_index] if tile_index is not None else []

    match = re.match(r"([A-Za-z0-9_]+)\[[^]]+\]", expr.strip())
    if match:
        return list(vdest_arrays.get(match.group(1), []))
    return []


def _parse_tileset_anim_data() -> dict[str, Any]:
    tileset_anims = (ROOT / "src/tileset_anims.c").read_text(encoding="utf-8")
    graphics_c = (ROOT / "src/graphics.c").read_text(encoding="utf-8")
    headers_h = (ROOT / "src/data/tilesets/headers.h").read_text(encoding="utf-8")
    functions = _parse_c_functions(tileset_anims)

    frame_sources: dict[str, str] = {}
    for source_text in (tileset_anims, graphics_c):
        frame_sources.update(
            dict(
                re.findall(
                    r'const\s+u16\s+([A-Za-z0-9_]+)\[]\s*=\s*INCBIN_U16\("([^"]+)"(?:\s*,\s*"[^"]+")?\);',
                    source_text,
                )
            )
        )

    frame_arrays: dict[str, list[str]] = {}
    for array_name, array_body in re.findall(
        r"const\s+u16\s+\*const\s+([A-Za-z0-9_]+)\[]\s*=\s*\{(.*?)\};",
        tileset_anims,
        re.S,
    ):
        items = [item.strip() for item in array_body.split(",") if item.strip()]
        frame_arrays[array_name] = items

    vdest_arrays: dict[str, list[int]] = {}
    for array_name, array_body in re.findall(
        r"u16\s+\*const\s+([A-Za-z0-9_]+)\[]\s*=\s*\{(.*?)\};",
        tileset_anims,
        re.S,
    ):
        tile_indices: list[int] = []
        for offset_expr in re.findall(r"TILE_OFFSET_4BPP\(([^)]+)\)", array_body):
            tile_index = _parse_tile_offset_expr(offset_expr)
            if tile_index is not None:
                tile_indices.append(tile_index)
        vdest_arrays[array_name] = tile_indices

    tileset_to_callback: dict[str, str | None] = {}
    for tileset_name, block_body in re.findall(
        r"const\s+struct\s+Tileset\s+(gTileset_[A-Za-z0-9_]+)\s*=\s*\{(.*?)\};",
        headers_h,
        re.S,
    ):
        callback_match = re.search(r"\.callback\s*=\s*([A-Za-z0-9_]+|NULL)", block_body)
        tileset_to_callback[tileset_name] = None if not callback_match or callback_match.group(1) == "NULL" else callback_match.group(1)

    init_defs: dict[str, dict[str, Any]] = {}
    for func_name, body in functions.items():
        if not func_name.startswith("InitTilesetAnim_"):
            continue
        role_match = re.search(r"s(Primary|Secondary)TilesetAnimCallback\s*=\s*([A-Za-z0-9_]+|NULL)\s*;", body)
        max_match = re.search(r"s(?:Primary|Secondary)TilesetAnimCounterMax\s*=\s*([^;]+);", body)
        if role_match:
            init_defs[func_name] = {
                "role": role_match.group(1).lower(),
                "program": None if role_match.group(2) == "NULL" else role_match.group(2),
                "counter_max_expr": max_match.group(1).strip() if max_match else None,
            }

    queue_ops: dict[str, dict[str, Any]] = {}
    for func_name, body in functions.items():
        copy_ops: list[dict[str, Any]] = []
        for src_expr, dest_expr, size_expr in re.findall(
            r"AppendTilesetAnimToBuffer\((.+?),\s*(.+?),\s*(.+?)\);",
            body,
        ):
            array_match = re.match(r"([A-Za-z0-9_]+)\[[^]]+\]", src_expr.strip())
            size_tiles_match = re.match(r"\s*(\d+)\s*\*\s*TILE_SIZE_4BPP\s*$", size_expr.strip())
            copy_ops.append(
                {
                    "source_expr": src_expr.strip(),
                    "frame_array": array_match.group(1) if array_match else None,
                    "dest_expr": dest_expr.strip(),
                    "dest_tile_indices": _parse_tile_destinations(dest_expr, vdest_arrays),
                    "size_expr": size_expr.strip(),
                    "size_tiles": int(size_tiles_match.group(1)) if size_tiles_match else None,
                }
            )

        palette_ops: list[dict[str, Any]] = []
        for src_expr, palette_slot in re.findall(
            r"CpuCopy16\((.+?),\s*&gPlttBufferUnfaded\[BG_PLTT_ID\((\d+)\)\],\s*PLTT_SIZE_4BPP\);",
            body,
        ):
            array_match = re.match(r"([A-Za-z0-9_]+)\[[^]]+\]", src_expr.strip())
            palette_ops.append(
                {
                    "source_expr": src_expr.strip(),
                    "palette_slot": int(palette_slot),
                    "frame_array": array_match.group(1) if array_match else None,
                }
            )

        if copy_ops or palette_ops:
            queue_ops[func_name] = {"copy_ops": copy_ops, "palette_ops": palette_ops}

    schedules: dict[str, list[dict[str, Any]]] = {}
    for func_name, body in functions.items():
        if not func_name.startswith("TilesetAnim_"):
            continue
        events: list[dict[str, Any]] = []
        for mod_str, eq_str, block_body, single_stmt in re.findall(
            r"if\s*\(\s*timer\s*%\s*(\d+)\s*==\s*(\d+)\s*\)\s*(?:\{(.*?)\}|([^\n;]+;))",
            body,
            re.S,
        ):
            action_body = block_body if block_body else single_stmt
            calls = re.findall(r"([A-Za-z0-9_]+)\(([^)]*)\);", action_body)
            actions: list[dict[str, Any]] = []
            for action_name, action_args in calls:
                op = queue_ops.get(action_name, {"copy_ops": [], "palette_ops": []})
                actions.append(
                    {
                        "function": action_name,
                        "args": action_args.strip(),
                        "copy_ops": op["copy_ops"],
                        "palette_ops": op["palette_ops"],
                    }
                )
            events.append({"gate": {"mod": int(mod_str), "eq": int(eq_str)}, "actions": actions})
        if events:
            schedules[func_name] = events

    return {
        "frame_sources": frame_sources,
        "frame_arrays": frame_arrays,
        "vdest_arrays": vdest_arrays,
        "tileset_to_callback": tileset_to_callback,
        "init_defs": init_defs,
        "schedules": schedules,
    }


def _paeth_predictor(a: int, b: int, c: int) -> int:
    p = a + b - c
    pa = abs(p - a)
    pb = abs(p - b)
    pc = abs(p - c)
    if pa <= pb and pa <= pc:
        return a
    if pb <= pc:
        return b
    return c


def _read_png_indexed_pixels(path: Path) -> tuple[int, int, list[int]]:
    raw = path.read_bytes()
    if raw[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError(f"Invalid PNG signature: {path}")

    pos = 8
    width: int | None = None
    height: int | None = None
    bit_depth: int | None = None
    color_type: int | None = None
    interlace: int | None = None
    idat_parts: list[bytes] = []
    plte: bytes | None = None

    while pos + 8 <= len(raw):
        length = int.from_bytes(raw[pos : pos + 4], "big")
        chunk_type = raw[pos + 4 : pos + 8]
        chunk_data = raw[pos + 8 : pos + 8 + length]
        pos += 12 + length
        if chunk_type == b"IHDR":
            width = int.from_bytes(chunk_data[0:4], "big")
            height = int.from_bytes(chunk_data[4:8], "big")
            bit_depth = chunk_data[8]
            color_type = chunk_data[9]
            interlace = chunk_data[12]
        elif chunk_type == b"PLTE":
            plte = chunk_data
        elif chunk_type == b"IDAT":
            idat_parts.append(chunk_data)
        elif chunk_type == b"IEND":
            break

    if width is None or height is None or bit_depth is None or color_type is None or interlace is None:
        raise ValueError(f"Missing IHDR in PNG: {path}")
    if color_type != 3:
        raise ValueError(f"PNG fallback requires indexed-color PNG (color type 3): {path}")
    if bit_depth not in {1, 2, 4, 8}:
        raise ValueError(f"Unsupported indexed PNG bit depth {bit_depth}: {path}")
    if interlace != 0:
        raise ValueError(f"Unsupported interlaced PNG for animation fallback: {path}")
    if plte is None:
        raise ValueError(f"Indexed PNG missing PLTE chunk: {path}")
    if not idat_parts:
        raise ValueError(f"PNG missing IDAT chunk(s): {path}")

    packed = zlib.decompress(b"".join(idat_parts))
    bits_per_row = width * bit_depth
    stride = (bits_per_row + 7) // 8
    expected_len = height * (1 + stride)
    if len(packed) != expected_len:
        raise ValueError(f"Unexpected PNG scanline size in {path}: got {len(packed)}, expected {expected_len}")

    rows: list[bytearray] = []
    i = 0
    for _ in range(height):
        filter_type = packed[i]
        i += 1
        row = bytearray(packed[i : i + stride])
        i += stride
        prev = rows[-1] if rows else bytearray(stride)
        if filter_type == 0:
            pass
        elif filter_type == 1:
            for x in range(stride):
                left = row[x - 1] if x > 0 else 0
                row[x] = (row[x] + left) & 0xFF
        elif filter_type == 2:
            for x in range(stride):
                row[x] = (row[x] + prev[x]) & 0xFF
        elif filter_type == 3:
            for x in range(stride):
                left = row[x - 1] if x > 0 else 0
                up = prev[x]
                row[x] = (row[x] + ((left + up) // 2)) & 0xFF
        elif filter_type == 4:
            for x in range(stride):
                left = row[x - 1] if x > 0 else 0
                up = prev[x]
                up_left = prev[x - 1] if x > 0 else 0
                row[x] = (row[x] + _paeth_predictor(left, up, up_left)) & 0xFF
        else:
            raise ValueError(f"Unsupported PNG filter type {filter_type} in {path}")
        rows.append(row)

    pixels: list[int] = []
    if bit_depth == 8:
        for row in rows:
            pixels.extend(row[:width])
    else:
        mask = (1 << bit_depth) - 1
        per_byte = 8 // bit_depth
        for row in rows:
            row_pixels: list[int] = []
            for byte in row:
                for p in range(per_byte):
                    shift = 8 - bit_depth * (p + 1)
                    row_pixels.append((byte >> shift) & mask)
            pixels.extend(row_pixels[:width])

    return width, height, pixels


def _encode_indexed_png_to_4bpp_tiles(path: Path) -> tuple[bytes, int, int, int]:
    width, height, pixels = _read_png_indexed_pixels(path)
    if width % 8 != 0 or height % 8 != 0:
        raise ValueError(f"PNG fallback dimensions must be multiples of 8: {path} ({width}x{height})")

    out = bytearray()
    for tile_y in range(0, height, 8):
        for tile_x in range(0, width, 8):
            for y in range(8):
                row_start = (tile_y + y) * width + tile_x
                for x in range(0, 8, 2):
                    lo = pixels[row_start + x]
                    hi = pixels[row_start + x + 1]
                    if lo > 0xF or hi > 0xF:
                        raise ValueError(
                            f"PNG fallback contains palette index > 15 in {path} at pixel ({tile_x + x}, {tile_y + y})"
                        )
                    out.append(lo | (hi << 4))

    tile_count = (width // 8) * (height // 8)
    return bytes(out), width, height, tile_count


def _resolve_anim_frame_source(symbol: str, rel: str) -> ResolvedAnimFrameSource:
    bin_path = ROOT / rel
    if bin_path.exists():
        return ResolvedAnimFrameSource(
            symbol=symbol,
            source_path=rel,
            render_extension=bin_path.suffix or ".bin",
            data=bin_path.read_bytes(),
            width=None,
            height=None,
            tile_count=None,
        )

    png_path = bin_path.with_suffix(".png")
    if png_path.exists():
        data, width, height, tile_count = _encode_indexed_png_to_4bpp_tiles(png_path)
        return ResolvedAnimFrameSource(
            symbol=symbol,
            source_path=png_path.relative_to(ROOT).as_posix(),
            render_extension=".4bpp",
            data=data,
            width=width,
            height=height,
            tile_count=tile_count,
        )

    if bin_path.suffix == ".gbapal":
        pal_path = bin_path.with_suffix(".pal")
        if pal_path.exists():
            lines = [line.strip() for line in pal_path.read_text(encoding="utf-8").splitlines() if line.strip()]
            if len(lines) < 4 or lines[0] != "JASC-PAL":
                raise ValueError(f"Unsupported palette format for animation frame source: {pal_path}")
            color_count = int(lines[2], 10)
            color_lines = lines[3 : 3 + color_count]
            out = bytearray()
            for color_line in color_lines:
                r_str, g_str, b_str = color_line.split()
                r = int(r_str, 10)
                g = int(g_str, 10)
                b = int(b_str, 10)
                gba = ((r >> 3) & 0x1F) | (((g >> 3) & 0x1F) << 5) | (((b >> 3) & 0x1F) << 10)
                out.extend(struct.pack("<H", gba))
            return ResolvedAnimFrameSource(
                symbol=symbol,
                source_path=pal_path.relative_to(ROOT).as_posix(),
                render_extension=".gbapal",
                data=bytes(out),
                width=None,
                height=None,
                tile_count=None,
            )

    raise ValueError(
        f"Unable to resolve animation frame symbol {symbol}: neither {bin_path.relative_to(ROOT)} nor "
        f"{png_path.relative_to(ROOT)} exists"
    )


def _infer_tile_count_from_payload_byte_length(byte_length: int) -> int | None:
    tile_size = 32
    if byte_length <= 0 or byte_length % tile_size != 0:
        return None
    return byte_length // tile_size


def validate_render_data(output_dir: Path) -> dict[str, int]:
    layouts_index = read_json(output_dir / "layouts_index.json")
    maps_index = read_json(output_dir / "maps_index.json")
    referenced_layout_ids = {
        str(entry.get("layout_id"))
        for entry in maps_index.get("maps", [])
        if isinstance(entry, dict) and entry.get("layout_id")
    }
    unresolved: list[str] = []
    metatiles_resolved = 0

    for summary in layouts_index["layouts"]:
        layout_id = summary["id"]
        if layout_id not in referenced_layout_ids:
            continue
        layout_path = output_dir / summary["decoded_path"]
        layout_json = read_json(layout_path)
        render_assets = layout_json.get("render_assets")
        if not isinstance(render_assets, dict):
            unresolved.append(f"{layout_id}: missing render_assets in {summary['decoded_path']}")
            continue

        pair_id_value = str(render_assets.get("pair_id", "<unknown>"))
        metatiles_json = read_json(output_dir / str(render_assets["metatiles"]))
        palettes_json = read_json(output_dir / str(render_assets["palettes"]))
        atlas_json = read_json(output_dir / str(render_assets["atlas"]))

        atlas_tile_counts_by_page: dict[int, int] = {}
        for page in atlas_json.get("pages", []):
            page_id = int(page["page"])
            atlas_path = output_dir / str(page["path"])
            width, height = read_png_dimensions(atlas_path)
            fallback_tile_count = (width // 8) * (height // 8)
            atlas_tile_counts_by_page[page_id] = int(page.get("logical_tile_count", fallback_tile_count))

        primary_tile_count = atlas_tile_counts_by_page.get(0, 0)
        secondary_tile_count = atlas_tile_counts_by_page.get(1, 0)
        total_tile_capacity = primary_tile_count + secondary_tile_count

        palette_counts = {
            str(tileset_block["source_tileset"]): len(tileset_block.get("palettes", []))
            for tileset_block in palettes_json.get("tilesets", [])
        }

        metatile_lookup = {
            str(tileset_block["source_tileset"]): tileset_block.get("metatiles", [])
            for tileset_block in metatiles_json.get("tilesets", [])
        }

        primary_name = str(layout_json["primary_tileset"])
        secondary_name = str(layout_json["secondary_tileset"])
        primary_metatiles = metatile_lookup.get(primary_name, [])
        secondary_metatiles = metatile_lookup.get(secondary_name, [])

        for tile in [*layout_json.get("tiles", []), *layout_json.get("border_tiles", [])]:
            metatile_id = int(tile.get("metatile_id", -1))
            if metatile_id < 0:
                unresolved.append(
                    f"{layout_id}: invalid metatile_id={metatile_id} "
                    f"(pair={pair_id_value}, tilesets={primary_name}/{secondary_name})"
                )
                continue
            if metatile_id < PRIMARY_METATILE_COUNT:
                source_tileset = primary_name
                source_index = metatile_id
                metatile_entry = primary_metatiles[source_index] if source_index < len(primary_metatiles) else None
            else:
                source_tileset = secondary_name
                source_index = metatile_id - PRIMARY_METATILE_COUNT
                metatile_entry = secondary_metatiles[source_index] if source_index < len(secondary_metatiles) else None

            if metatile_entry is None:
                unresolved.append(
                    f"{layout_id}: unresolved metatile_id={metatile_id} (tileset={source_tileset}, "
                    f"source_index={source_index}, pair={pair_id_value}, file={summary['decoded_path']})"
                )
                continue

            palette_count = palette_counts.get(source_tileset)
            if palette_count is None:
                unresolved.append(
                    f"{layout_id}: missing palette set for tileset={source_tileset} "
                    f"(pair={pair_id_value}, file={summary['decoded_path']})"
                )
                continue

            for subtile in metatile_entry.get("subtiles", []):
                tile_index = int(subtile["tile_index"])
                palette_index = int(subtile["palette_index"])
                source_page = 1 if tile_index >= primary_tile_count else 0
                local_tile_index = tile_index if source_page == 0 else tile_index - primary_tile_count
                local_page_tile_count = primary_tile_count if source_page == 0 else secondary_tile_count
                if (
                    tile_index < 0
                    or local_tile_index < 0
                    or local_page_tile_count <= 0
                    or local_tile_index >= local_page_tile_count
                ):
                    unresolved.append(
                        f"{layout_id}: out-of-bounds tile index {tile_index} in metatile_id={metatile_id} "
                        f"(tileset={source_tileset}, source_page={source_page}, "
                        f"local_page_tile_count={local_page_tile_count}, pair={pair_id_value}, "
                        f"file={summary['decoded_path']})"
                    )
                    break
                if palette_index < 0 or palette_index >= palette_count:
                    unresolved.append(
                        f"{layout_id}: out-of-bounds palette index {palette_index} in metatile_id={metatile_id} "
                        f"(tileset={source_tileset}, palette_count={palette_count}, pair={pair_id_value}, "
                        f"file={summary['decoded_path']})"
                    )
                    break
            else:
                metatiles_resolved += 1

        tile_anims_rel = render_assets.get("tile_anims")
        if tile_anims_rel:
            tile_anims_json = read_json(output_dir / str(tile_anims_rel))
            for program in tile_anims_json.get("programs", {}).values():
                for event in program.get("events", []):
                    for action in event.get("actions", []):
                        for copy_op in action.get("copy_ops", []):
                            for tile_index in copy_op.get("dest_tile_indices", []):
                                if tile_index < 0 or tile_index >= total_tile_capacity:
                                    unresolved.append(
                                        f"{layout_id}: animation destination tile index {tile_index} out of bounds "
                                        f"(pair={pair_id_value}, total_tile_capacity={total_tile_capacity}, "
                                        f"program={program.get('program')}, action={action.get('function')})"
                                    )

    if unresolved:
        print("Render data parity validation failed:")
        for issue in unresolved[:50]:
            print(f"  - {issue}")
        if len(unresolved) > 50:
            print(f"  - ... {len(unresolved) - 50} more issue(s)")
        raise SystemExit(1)

    report = {
        "layouts_checked": len(referenced_layout_ids),
        "metatiles_resolved": metatiles_resolved,
        "unresolved_count": 0,
    }
    print("Render data parity validation report")
    print(f"layouts checked: {report['layouts_checked']}")
    print(f"metatiles resolved: {report['metatiles_resolved']}")
    print(f"unresolved count: {report['unresolved_count']}")
    return report


def run_extract_render(output_dir: Path, clean: bool) -> None:
    run_extract(output_dir, clean=clean)
    render_root = output_dir / "render"
    render_root.mkdir(parents=True, exist_ok=True)

    layout_root = output_dir / "layouts"
    layout_index = read_json(output_dir / "layouts_index.json")
    tileset_attr_paths = parse_tileset_attr_file_map()
    tileset_metatile_paths = parse_tileset_metatile_file_map()
    tileset_anim_data = _parse_tileset_anim_data()

    pair_to_layouts: dict[str, list[str]] = defaultdict(list)
    for layout_summary in layout_index["layouts"]:
        pair_key = pair_id(layout_summary["primary_tileset"], layout_summary["secondary_tileset"])
        pair_to_layouts[pair_key].append(layout_summary["id"])

    render_index: dict[str, Any] = {"pairs": []}
    for pair_key, layout_ids in sorted(pair_to_layouts.items()):
        layout_data = read_json(layout_root / f"{layout_ids[0]}.json")
        primary_tileset = layout_data["primary_tileset"]
        secondary_tileset = layout_data["secondary_tileset"]

        pair_dir = render_root / pair_key
        pair_dir.mkdir(parents=True, exist_ok=True)

        tileset_names = [name for name in (primary_tileset, secondary_tileset) if name in tileset_metatile_paths]
        atlas_pages: list[dict[str, Any]] = []
        metatile_sets: list[dict[str, Any]] = []
        palette_sets: list[dict[str, Any]] = []

        for page_index, tileset_name in enumerate(tileset_names):
            metatile_path = ROOT / tileset_metatile_paths[tileset_name]
            tileset_dir = metatile_path.parent
            tiles_png = resolve_tiles_png_for_tileset(tileset_name, tileset_dir)
            raw_metatiles = read_u16_le(metatile_path)
            decoded_metatiles = decode_metatile_entries(raw_metatiles)
            logical_tile_count = (
                max((subtile["tile_index"] for item in decoded_metatiles for subtile in item["subtiles"]), default=-1) + 1
            )
            page_name = "tileset_atlas.png" if page_index == 0 else f"tileset_atlas_{page_index}.png"
            page_out = pair_dir / page_name
            shutil.copy2(tiles_png, page_out)
            atlas_pages.append(
                {
                    "page": page_index,
                    "source_tileset": tileset_name,
                    "path": page_out.relative_to(output_dir).as_posix(),
                    "logical_tile_count": logical_tile_count,
                }
            )

            palette_entries: list[dict[str, Any]] = []
            palette_dir = tileset_dir / "palettes"
            if not palette_dir.exists():
                palette_dir = tiles_png.parent / "palettes"
            for palette_path in sorted(palette_dir.glob("*.pal")):
                palette_entries.append(
                    {
                        "palette_id": palette_path.stem,
                        "source": str(palette_path.relative_to(ROOT)),
                        "colors": decode_jasc_palette(palette_path),
                    }
                )
            palette_sets.append(
                {
                    "source_tileset": tileset_name,
                    "palettes": palette_entries,
                }
            )

            attr_rel = tileset_attr_paths.get(tileset_name)
            attrs = read_u16_le(ROOT / attr_rel) if attr_rel else []
            for item in decoded_metatiles:
                idx = item["metatile_index"]
                if idx < len(attrs):
                    decoded_attr = decode_metatile_attr(attrs[idx])
                    item["behavior_id"] = decoded_attr["behavior_id"]
                    item["layer_type"] = decoded_attr["layer_type"]
            metatile_sets.append(
                {
                    "source_tileset": tileset_name,
                    "metatiles": decoded_metatiles,
                }
            )

        (pair_dir / "palettes.json").write_text(json.dumps({"tilesets": palette_sets}, indent=2) + "\n", encoding="utf-8")
        (pair_dir / "metatiles.json").write_text(
            json.dumps({"tilesets": metatile_sets}, indent=2) + "\n",
            encoding="utf-8",
        )
        (pair_dir / "atlas.json").write_text(json.dumps({"pages": atlas_pages}, indent=2) + "\n", encoding="utf-8")

        tileset_programs: dict[str, Any] = {}
        for role, tileset_name in (("primary", primary_tileset), ("secondary", secondary_tileset)):
            callback_name = tileset_anim_data["tileset_to_callback"].get(tileset_name)
            init_def = tileset_anim_data["init_defs"].get(callback_name) if callback_name else None
            program_name = init_def["program"] if init_def else None
            events = tileset_anim_data["schedules"].get(program_name, []) if program_name else []
            tileset_programs[role] = {
                "source_tileset": tileset_name,
                "callback": callback_name,
                "program": program_name,
                "counter_max_expr": init_def["counter_max_expr"] if init_def else None,
                "events": events,
            }

        referenced_frame_arrays: set[str] = set()
        frame_array_expected_copy_sizes: dict[str, set[int]] = defaultdict(set)
        for role_data in tileset_programs.values():
            for event in role_data["events"]:
                for action in event["actions"]:
                    for copy_op in action.get("copy_ops", []):
                        if copy_op.get("frame_array"):
                            frame_array_name = str(copy_op["frame_array"])
                            referenced_frame_arrays.add(frame_array_name)
                            size_tiles = copy_op.get("size_tiles")
                            if isinstance(size_tiles, int) and size_tiles > 0:
                                frame_array_expected_copy_sizes[frame_array_name].add(size_tiles)
                    for palette_op in action.get("palette_ops", []):
                        if palette_op.get("frame_array"):
                            referenced_frame_arrays.add(str(palette_op["frame_array"]))

        referenced_symbols: set[str] = set()
        for array_name in referenced_frame_arrays:
            referenced_symbols.update(tileset_anim_data["frame_arrays"].get(array_name, []))

        source_records: list[dict[str, Any]] = []
        symbol_to_payload_id: dict[str, int] = {}
        symbol_expected_copy_sizes: dict[str, set[int]] = defaultdict(set)
        for array_name, expected_sizes in frame_array_expected_copy_sizes.items():
            for symbol in tileset_anim_data["frame_arrays"].get(array_name, []):
                symbol_expected_copy_sizes[symbol].update(expected_sizes)
        source_dir = pair_dir / "tile_anim_sources"
        source_dir.mkdir(parents=True, exist_ok=True)
        payload_blob = bytearray()
        payload_records: list[dict[str, Any]] = []
        for symbol in sorted(referenced_symbols):
            rel = tileset_anim_data["frame_sources"].get(symbol)
            if not rel:
                raise ValueError(f"Missing frame source mapping for animation symbol {symbol}")
            resolved = _resolve_anim_frame_source(symbol, rel)
            index = len(source_records)
            extension = resolved.render_extension
            out_name = f"{index:04d}_{symbol}{extension}"
            out_path = source_dir / out_name
            out_path.write_bytes(resolved.data)
            source_index = len(source_records)
            source_records.append(
                {
                    "source_index": source_index,
                    "symbol_name": symbol,
                    "source_path": resolved.source_path,
                    "render_path": out_path.relative_to(output_dir).as_posix(),
                    "width": resolved.width,
                    "height": resolved.height,
                    "tile_count": resolved.tile_count,
                    "byte_count": len(resolved.data),
                }
            )
            payload_id = len(payload_records)
            payload_offset = len(payload_blob)
            payload_blob.extend(resolved.data)
            payload_tile_count = resolved.tile_count
            if payload_tile_count is None:
                payload_tile_count = _infer_tile_count_from_payload_byte_length(len(resolved.data))
            payload_records.append(
                {
                    "payload_id": payload_id,
                    "symbol_name": symbol,
                    "payload_offset": payload_offset,
                    "tile_count": payload_tile_count,
                    "byte_count": len(resolved.data),
                    "expected_copy_size_tiles": sorted(symbol_expected_copy_sizes.get(symbol, set())),
                }
            )
            symbol_to_payload_id[symbol] = payload_id

        frame_arrays_json: dict[str, list[int]] = {}
        for array_name in sorted(referenced_frame_arrays):
            payload_ids: list[int] = []
            for symbol in tileset_anim_data["frame_arrays"].get(array_name, []):
                if symbol not in symbol_to_payload_id:
                    raise ValueError(f"Missing payload id for frame symbol {symbol} in {array_name}")
                payload_ids.append(symbol_to_payload_id[symbol])
            frame_arrays_json[array_name] = payload_ids

        frame_blob_path = pair_dir / "tile_anim_frames.bin"
        frame_blob_path.write_bytes(bytes(payload_blob))

        tile_anims_path = pair_dir / "tile_anims.json"
        tile_anims_payload = {
            "tile_anims_version": TILE_ANIMS_VERSION,
            "pair_id": pair_key,
            "programs": tileset_programs,
            "frame_arrays": frame_arrays_json,
            "frame_payloads": payload_records,
            "frame_payload_blob": frame_blob_path.name,
            "frame_sources": source_records,
        }
        tile_anims_path.write_text(json.dumps(tile_anims_payload, indent=2) + "\n", encoding="utf-8")

        render_ref = {
            "pair_id": pair_key,
            "atlas": f"render/{pair_key}/atlas.json",
            "palettes": f"render/{pair_key}/palettes.json",
            "metatiles": f"render/{pair_key}/metatiles.json",
            "tile_anims": f"render/{pair_key}/tile_anims.json",
        }
        for layout_id in layout_ids:
            layout_path = layout_root / f"{layout_id}.json"
            layout_json = read_json(layout_path)
            layout_json["render_assets"] = render_ref
            layout_path.write_text(json.dumps(layout_json), encoding="utf-8")

        render_index["pairs"].append(
            {
                "pair_id": pair_key,
                "primary_tileset": primary_tileset,
                "secondary_tileset": secondary_tileset,
                "layout_ids": sorted(layout_ids),
                "assets": render_ref,
            }
        )

    (render_root / "index.json").write_text(json.dumps(render_index, indent=2) + "\n", encoding="utf-8")
    print(f"Extracted render assets for {len(render_index['pairs'])} tileset pairs to {render_root}")
    validate_render_data(output_dir)


def run_validate_render(output_dir: Path) -> None:
    validate_render_data(output_dir)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Rebuild map data extractor and validator")
    sub = parser.add_subparsers(dest="command", required=True)

    extract = sub.add_parser("extract", help="Extract rebuild-native map artifacts")
    extract.add_argument(
        "--output-dir",
        default=str(ROOT / "rebuild/assets"),
        help="Artifact output directory",
    )
    extract.add_argument("--clean", action="store_true", help="Delete output directory before extraction")

    extract_render = sub.add_parser(
        "extract-render",
        help="Extract render-ready artifacts (atlas, palettes, metatiles) and annotate layout assets",
    )
    extract_render.add_argument(
        "--output-dir",
        default=str(ROOT / "rebuild/assets"),
        help="Artifact output directory",
    )
    extract_render.add_argument("--clean", action="store_true", help="Delete output directory before extraction")

    sub.add_parser("validate", help="Validate references and print load counts")
    validate_render = sub.add_parser(
        "validate-render",
        help="Validate extracted render data against layout metatile and atlas/palette bounds",
    )
    validate_render.add_argument(
        "--output-dir",
        default=str(ROOT / "rebuild/assets"),
        help="Artifact output directory",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    if args.command == "extract":
        run_extract(Path(args.output_dir), clean=args.clean)
    elif args.command == "extract-render":
        run_extract_render(Path(args.output_dir), clean=args.clean)
    elif args.command == "validate":
        run_validate()
    elif args.command == "validate-render":
        run_validate_render(Path(args.output_dir))


if __name__ == "__main__":
    main()

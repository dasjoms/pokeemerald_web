#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import re
import shutil
import struct
from dataclasses import dataclass
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[3]
PLAYER_ASSETS_VERSION = 2
TILE_SIZE_PX = 8


@dataclass(frozen=True)
class AvatarSpec:
    avatar_id: str
    normal_pic_symbol: str
    running_pic_symbol: str
    mach_bike_pic_symbol: str
    acro_bike_pic_symbol: str
    normal_pic_table_symbol: str
    mach_bike_pic_table_symbol: str
    acro_bike_pic_table_symbol: str
    graphics_info_symbol: str
    mach_bike_graphics_info_symbol: str
    acro_bike_graphics_info_symbol: str
    normal_palette_symbol: str


AVATARS: tuple[AvatarSpec, ...] = (
    AvatarSpec(
        avatar_id="brendan",
        normal_pic_symbol="gObjectEventPic_BrendanNormal",
        running_pic_symbol="gObjectEventPic_BrendanRunning",
        mach_bike_pic_symbol="gObjectEventPic_BrendanMachBike",
        acro_bike_pic_symbol="gObjectEventPic_BrendanAcroBike",
        normal_pic_table_symbol="sPicTable_BrendanNormal",
        mach_bike_pic_table_symbol="sPicTable_BrendanMachBike",
        acro_bike_pic_table_symbol="sPicTable_BrendanAcroBike",
        graphics_info_symbol="gObjectEventGraphicsInfo_BrendanNormal",
        mach_bike_graphics_info_symbol="gObjectEventGraphicsInfo_BrendanMachBike",
        acro_bike_graphics_info_symbol="gObjectEventGraphicsInfo_BrendanAcroBike",
        normal_palette_symbol="gObjectEventPal_Brendan",
    ),
    AvatarSpec(
        avatar_id="may",
        normal_pic_symbol="gObjectEventPic_MayNormal",
        running_pic_symbol="gObjectEventPic_MayRunning",
        mach_bike_pic_symbol="gObjectEventPic_MayMachBike",
        acro_bike_pic_symbol="gObjectEventPic_MayAcroBike",
        normal_pic_table_symbol="sPicTable_MayNormal",
        mach_bike_pic_table_symbol="sPicTable_MayMachBike",
        acro_bike_pic_table_symbol="sPicTable_MayAcroBike",
        graphics_info_symbol="gObjectEventGraphicsInfo_MayNormal",
        mach_bike_graphics_info_symbol="gObjectEventGraphicsInfo_MayMachBike",
        acro_bike_graphics_info_symbol="gObjectEventGraphicsInfo_MayAcroBike",
        normal_palette_symbol="gObjectEventPal_May",
    ),
)

ON_FOOT_ACTIONS = {
    "face": {
        "south": "ANIM_STD_FACE_SOUTH",
        "north": "ANIM_STD_FACE_NORTH",
        "west": "ANIM_STD_FACE_WEST",
        "east": "ANIM_STD_FACE_EAST",
    },
    "walk": {
        "south": "ANIM_STD_GO_SOUTH",
        "north": "ANIM_STD_GO_NORTH",
        "west": "ANIM_STD_GO_WEST",
        "east": "ANIM_STD_GO_EAST",
    },
    "run": {
        "south": "ANIM_RUN_SOUTH",
        "north": "ANIM_RUN_NORTH",
        "west": "ANIM_RUN_WEST",
        "east": "ANIM_RUN_EAST",
    },
}

MACH_BIKE_ACTIONS = {
    "face": ON_FOOT_ACTIONS["face"],
    "bike_walk": ON_FOOT_ACTIONS["walk"],
    "bike_fast": {
        "south": "ANIM_STD_GO_FAST_SOUTH",
        "north": "ANIM_STD_GO_FAST_NORTH",
        "west": "ANIM_STD_GO_FAST_WEST",
        "east": "ANIM_STD_GO_FAST_EAST",
    },
    "bike_faster": {
        "south": "ANIM_STD_GO_FASTER_SOUTH",
        "north": "ANIM_STD_GO_FASTER_NORTH",
        "west": "ANIM_STD_GO_FASTER_WEST",
        "east": "ANIM_STD_GO_FASTER_EAST",
    },
    "bike_fastest": {
        "south": "ANIM_STD_GO_FASTEST_SOUTH",
        "north": "ANIM_STD_GO_FASTEST_NORTH",
        "west": "ANIM_STD_GO_FASTEST_WEST",
        "east": "ANIM_STD_GO_FASTEST_EAST",
    },
}

ACRO_BIKE_ACTIONS = {
    "face": ON_FOOT_ACTIONS["face"],
    "bike_walk": ON_FOOT_ACTIONS["walk"],
    "bike_fast": MACH_BIKE_ACTIONS["bike_fast"],
    "bike_faster": MACH_BIKE_ACTIONS["bike_faster"],
    "bike_fastest": MACH_BIKE_ACTIONS["bike_fastest"],
    "acro_bunny_hop_back_wheel": {
        "south": "ANIM_BUNNY_HOP_BACK_WHEEL_SOUTH",
        "north": "ANIM_BUNNY_HOP_BACK_WHEEL_NORTH",
        "west": "ANIM_BUNNY_HOP_BACK_WHEEL_WEST",
        "east": "ANIM_BUNNY_HOP_BACK_WHEEL_EAST",
    },
    "acro_bunny_hop_front_wheel": {
        "south": "ANIM_BUNNY_HOP_FRONT_WHEEL_SOUTH",
        "north": "ANIM_BUNNY_HOP_FRONT_WHEEL_NORTH",
        "west": "ANIM_BUNNY_HOP_FRONT_WHEEL_WEST",
        "east": "ANIM_BUNNY_HOP_FRONT_WHEEL_EAST",
    },
    "acro_side_jump_front_wheel": {
        "south": "ANIM_BUNNY_HOP_FRONT_WHEEL_SOUTH",
        "north": "ANIM_BUNNY_HOP_FRONT_WHEEL_NORTH",
        "west": "ANIM_BUNNY_HOP_FRONT_WHEEL_WEST",
        "east": "ANIM_BUNNY_HOP_FRONT_WHEEL_EAST",
    },
    "acro_turn_jump_front_wheel": {
        "south": "ANIM_BUNNY_HOP_FRONT_WHEEL_SOUTH",
        "north": "ANIM_BUNNY_HOP_FRONT_WHEEL_NORTH",
        "west": "ANIM_BUNNY_HOP_FRONT_WHEEL_WEST",
        "east": "ANIM_BUNNY_HOP_FRONT_WHEEL_EAST",
    },
    "acro_ledge_hop_front_wheel": {
        "south": "ANIM_BUNNY_HOP_FRONT_WHEEL_SOUTH",
        "north": "ANIM_BUNNY_HOP_FRONT_WHEEL_NORTH",
        "west": "ANIM_BUNNY_HOP_FRONT_WHEEL_WEST",
        "east": "ANIM_BUNNY_HOP_FRONT_WHEEL_EAST",
    },
    "acro_ledge_hop_back_wheel": {
        "south": "ANIM_BUNNY_HOP_BACK_WHEEL_SOUTH",
        "north": "ANIM_BUNNY_HOP_BACK_WHEEL_NORTH",
        "west": "ANIM_BUNNY_HOP_BACK_WHEEL_WEST",
        "east": "ANIM_BUNNY_HOP_BACK_WHEEL_EAST",
    },
    "acro_standing_wheelie_back_wheel": {
        "south": "ANIM_STANDING_WHEELIE_BACK_WHEEL_SOUTH",
        "north": "ANIM_STANDING_WHEELIE_BACK_WHEEL_NORTH",
        "west": "ANIM_STANDING_WHEELIE_BACK_WHEEL_WEST",
        "east": "ANIM_STANDING_WHEELIE_BACK_WHEEL_EAST",
    },
    "acro_standing_wheelie_front_wheel": {
        "south": "ANIM_STANDING_WHEELIE_FRONT_WHEEL_SOUTH",
        "north": "ANIM_STANDING_WHEELIE_FRONT_WHEEL_NORTH",
        "west": "ANIM_STANDING_WHEELIE_FRONT_WHEEL_WEST",
        "east": "ANIM_STANDING_WHEELIE_FRONT_WHEEL_EAST",
    },
    "acro_moving_wheelie": {
        "south": "ANIM_MOVING_WHEELIE_SOUTH",
        "north": "ANIM_MOVING_WHEELIE_NORTH",
        "west": "ANIM_MOVING_WHEELIE_WEST",
        "east": "ANIM_MOVING_WHEELIE_EAST",
    },
    "acro_wheelie_in_place": {
        "south": "ANIM_STANDING_WHEELIE_BACK_WHEEL_SOUTH",
        "north": "ANIM_STANDING_WHEELIE_BACK_WHEEL_NORTH",
        "west": "ANIM_STANDING_WHEELIE_BACK_WHEEL_WEST",
        "east": "ANIM_STANDING_WHEELIE_BACK_WHEEL_EAST",
    },
    "acro_pop_wheelie_stationary": {
        "south": "ANIM_STANDING_WHEELIE_FRONT_WHEEL_SOUTH",
        "north": "ANIM_STANDING_WHEELIE_FRONT_WHEEL_NORTH",
        "west": "ANIM_STANDING_WHEELIE_FRONT_WHEEL_WEST",
        "east": "ANIM_STANDING_WHEELIE_FRONT_WHEEL_EAST",
    },
    "acro_pop_wheelie_moving": {
        "south": "ANIM_STANDING_WHEELIE_FRONT_WHEEL_SOUTH",
        "north": "ANIM_STANDING_WHEELIE_FRONT_WHEEL_NORTH",
        "west": "ANIM_STANDING_WHEELIE_FRONT_WHEEL_WEST",
        "east": "ANIM_STANDING_WHEELIE_FRONT_WHEEL_EAST",
    },
    "acro_end_wheelie_stationary": {
        "south": "ANIM_STANDING_WHEELIE_BACK_WHEEL_SOUTH",
        "north": "ANIM_STANDING_WHEELIE_BACK_WHEEL_NORTH",
        "west": "ANIM_STANDING_WHEELIE_BACK_WHEEL_WEST",
        "east": "ANIM_STANDING_WHEELIE_BACK_WHEEL_EAST",
    },
    "acro_end_wheelie_moving": {
        "south": "ANIM_STANDING_WHEELIE_BACK_WHEEL_SOUTH",
        "north": "ANIM_STANDING_WHEELIE_BACK_WHEEL_NORTH",
        "west": "ANIM_STANDING_WHEELIE_BACK_WHEEL_WEST",
        "east": "ANIM_STANDING_WHEELIE_BACK_WHEEL_EAST",
    },
}


def read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def parse_incbin_paths() -> dict[str, str]:
    text = read_text(ROOT / "src/data/object_events/object_event_graphics.h")
    matches = re.findall(
        r"const\s+u(?:16|32)\s+(gObjectEvent(?:Pic|Pal)_[A-Za-z0-9_]+)\[\]\s*=\s*INCBIN_U(?:16|32)\(\"([^\"]+)\"\);",
        text,
    )
    return {symbol: rel_path for symbol, rel_path in matches}


def parse_pic_table_entries(pic_table_symbol: str) -> list[dict[str, Any]]:
    text = read_text(ROOT / "src/data/object_events/object_event_pic_tables.h")
    block_match = re.search(
        rf"static\s+const\s+struct\s+SpriteFrameImage\s+{re.escape(pic_table_symbol)}\[\]\s*=\s*\{{(.*?)\}};",
        text,
        re.S,
    )
    if not block_match:
        raise ValueError(f"Missing pic table: {pic_table_symbol}")

    entries: list[dict[str, Any]] = []
    for pic_symbol, tile_w, tile_h, frame_idx in re.findall(
        r"overworld_frame\((gObjectEventPic_[A-Za-z0-9_]+),\s*(\d+),\s*(\d+),\s*(\d+)\)",
        block_match.group(1),
    ):
        entries.append(
            {
                "pic_symbol": pic_symbol,
                "tile_width": int(tile_w),
                "tile_height": int(tile_h),
                "source_frame_index": int(frame_idx),
            }
        )
    if not entries:
        raise ValueError(f"No overworld_frame entries in {pic_table_symbol}")
    return entries


def parse_graphics_info(graphics_info_symbol: str) -> dict[str, Any]:
    text = read_text(ROOT / "src/data/object_events/object_event_graphics_info.h")
    block_match = re.search(
        rf"const\s+struct\s+ObjectEventGraphicsInfo\s+{re.escape(graphics_info_symbol)}\s*=\s*\{{(.*?)\}};",
        text,
        re.S,
    )
    if not block_match:
        raise ValueError(f"Missing graphics info: {graphics_info_symbol}")

    fields: dict[str, Any] = {}
    for key, value in re.findall(r"\.(\w+)\s*=\s*([^,]+),", block_match.group(1)):
        fields[key] = value.strip().lstrip("&")

    required = ("width", "height", "size", "paletteTag", "reflectionPaletteTag", "anims", "images")
    for key in required:
        if key not in fields:
            raise ValueError(f"Missing .{key} in {graphics_info_symbol}")
    return fields


def parse_anim_cmds(cmd_symbols: set[str]) -> dict[str, list[dict[str, Any]]]:
    text = read_text(ROOT / "src/data/object_events/object_event_anims.h")
    parsed: dict[str, list[dict[str, Any]]] = {}
    for cmd_symbol in sorted(cmd_symbols):
        block_match = re.search(
            rf"static\s+const\s+union\s+AnimCmd\s+{re.escape(cmd_symbol)}\[\]\s*=\s*\{{(.*?)\}};",
            text,
            re.S,
        )
        if not block_match:
            raise ValueError(f"Missing animation cmd definition: {cmd_symbol}")

        frames: list[dict[str, Any]] = []
        for frame_idx, duration, attrs in re.findall(
            r"ANIMCMD_FRAME\(\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([^\)]*))?\)",
            block_match.group(1),
        ):
            frame = {
                "frame": int(frame_idx),
                "duration": int(duration),
                "h_flip": bool(attrs and ".hFlip = TRUE" in attrs),
            }
            frames.append(frame)

        if not frames:
            raise ValueError(f"No ANIMCMD_FRAME entries in {cmd_symbol}")
        parsed[cmd_symbol] = frames
    return parsed


def parse_anim_table_bindings(anim_table_symbol: str) -> dict[str, str]:
    text = read_text(ROOT / "src/data/object_events/object_event_anims.h")
    table_match = re.search(
        rf"static\s+const\s+union\s+AnimCmd\s*\*const\s+{re.escape(anim_table_symbol)}\[\]\s*=\s*\{{(.*?)\}};",
        text,
        re.S,
    )
    if not table_match:
        raise ValueError(f"Missing {anim_table_symbol}")

    return dict(
        re.findall(r"\[(ANIM_[A-Z0-9_]+)\]\s*=\s*(sAnim_[A-Za-z0-9_]+)", table_match.group(1))
    )


def select_directional_action_bindings(
    anim_table_bindings: dict[str, str],
    desired: dict[str, dict[str, str]],
    anim_table_symbol: str,
) -> dict[str, dict[str, str]]:
    bindings: dict[str, dict[str, str]] = {}
    for action_id, by_dir in desired.items():
        bindings[action_id] = {}
        for direction, const_name in by_dir.items():
            cmd_symbol = anim_table_bindings.get(const_name)
            if cmd_symbol is None:
                raise ValueError(f"Missing {const_name} in {anim_table_symbol}")
            bindings[action_id][direction] = cmd_symbol
    return bindings


def decode_palette(path: Path) -> list[str]:
    raw = path.read_bytes()
    if raw.startswith(b"JASC-PAL"):
        lines = path.read_text(encoding="utf-8").splitlines()
        if len(lines) < 4:
            raise ValueError(f"Invalid JASC palette format: {path}")
        color_count = int(lines[2].strip())
        colors: list[str] = []
        for line in lines[3 : 3 + color_count]:
            r_s, g_s, b_s = line.strip().split()
            colors.append(f"#{int(r_s):02x}{int(g_s):02x}{int(b_s):02x}")
        return colors

    if len(raw) % 2 != 0:
        raise ValueError(f"Palette file has odd byte length: {path}")

    colors: list[str] = []
    for i in range(0, len(raw), 2):
        value = int.from_bytes(raw[i : i + 2], "little")
        r = (value & 0x1F) << 3
        g = ((value >> 5) & 0x1F) << 3
        b = ((value >> 10) & 0x1F) << 3
        colors.append(f"#{r:02x}{g:02x}{b:02x}")
    return colors


def resolve_existing_source_path(rel_path: str) -> Path:
    candidates = [ROOT / rel_path]
    if rel_path.endswith(".4bpp"):
        candidates.append(ROOT / f"{rel_path[:-5]}.png")
    if rel_path.endswith(".gbapal"):
        candidates.append(ROOT / f"{rel_path[:-7]}.pal")

    for candidate in candidates:
        if candidate.exists():
            return candidate

    raise FileNotFoundError(f"Could not resolve source asset for {rel_path}; tried: {candidates}")


def png_dimensions(path: Path) -> tuple[int, int]:
    with path.open("rb") as handle:
        header = handle.read(24)

    if len(header) < 24 or header[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError(f"Expected PNG source for atlas bounds, got: {path}")

    width, height = struct.unpack(">II", header[16:24])
    return width, height


def sheet_rect(frame_index: int, tile_w: int, tile_h: int, sheet_width: int) -> dict[str, int]:
    frame_width = tile_w * TILE_SIZE_PX
    frame_height = tile_h * TILE_SIZE_PX
    if frame_width <= 0 or frame_height <= 0:
        raise ValueError("Frame tile dimensions must be positive")

    columns = sheet_width // frame_width
    if columns <= 0:
        raise ValueError(
            f"Sheet width {sheet_width}px is smaller than frame width {frame_width}px"
        )

    x = (frame_index % columns) * frame_width
    y = (frame_index // columns) * frame_height
    return {
        "x": x,
        "y": y,
        "w": frame_width,
        "h": frame_height,
    }


def validate_frame_atlas_bounds(avatar_id: str, frame_atlas: dict[str, Any], sheet_dimensions: dict[str, tuple[int, int]]) -> None:
    for frame_key, atlas in frame_atlas.items():
        sheet_symbol = atlas["sheet_symbol"]
        if sheet_symbol not in sheet_dimensions:
            raise ValueError(f"Missing dimensions for sheet symbol {sheet_symbol} ({avatar_id})")

        sheet_width, sheet_height = sheet_dimensions[sheet_symbol]
        rect = atlas["rect"]
        x, y, w, h = rect["x"], rect["y"], rect["w"], rect["h"]
        if x < 0 or y < 0 or w <= 0 or h <= 0:
            raise ValueError(f"Invalid rect for {avatar_id} frame {frame_key}: {rect}")
        if x + w > sheet_width or y + h > sheet_height:
            raise ValueError(
                f"Frame atlas out of bounds for {avatar_id} frame {frame_key} "
                f"on {sheet_symbol}: rect={rect}, sheet={sheet_width}x{sheet_height}"
            )


def traversal_mode_pic_entries(
    traversal_mode: str,
    normal_pic_entries: list[dict[str, Any]],
    mach_pic_entries: list[dict[str, Any]],
    acro_pic_entries: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    if traversal_mode == "on_foot":
        return normal_pic_entries
    if traversal_mode == "mach_bike":
        return mach_pic_entries
    if traversal_mode == "acro_bike":
        return acro_pic_entries
    raise ValueError(f"Unknown traversal mode: {traversal_mode}")


def resolve_assets() -> list[dict[str, Any]]:
    incbins = parse_incbin_paths()
    animation_table_specs = {
        "on_foot": ("sAnimTable_BrendanMayNormal", ON_FOOT_ACTIONS),
        "mach_bike": ("sAnimTable_Standard", MACH_BIKE_ACTIONS),
        "acro_bike": ("sAnimTable_AcroBike", ACRO_BIKE_ACTIONS),
    }
    animation_sets: dict[str, dict[str, Any]] = {}
    cmd_symbols: set[str] = set()
    for traversal_mode, (anim_table_symbol, action_specs) in animation_table_specs.items():
        action_bindings = select_directional_action_bindings(
            parse_anim_table_bindings(anim_table_symbol),
            action_specs,
            anim_table_symbol,
        )
        animation_sets[traversal_mode] = {
            "anim_table_symbol": anim_table_symbol,
            "actions": action_bindings,
        }
        for by_dir in action_bindings.values():
            cmd_symbols.update(by_dir.values())

    anim_cmds = parse_anim_cmds(cmd_symbols)

    if "gObjectEventPal_BridgeReflection" not in incbins:
        raise ValueError("Missing gObjectEventPal_BridgeReflection incbin path")

    avatars: list[dict[str, Any]] = []
    for avatar in AVATARS:
        normal_pic_entries = parse_pic_table_entries(avatar.normal_pic_table_symbol)
        mach_pic_entries = parse_pic_table_entries(avatar.mach_bike_pic_table_symbol)
        acro_pic_entries = parse_pic_table_entries(avatar.acro_bike_pic_table_symbol)
        pic_entries = normal_pic_entries + mach_pic_entries + acro_pic_entries
        info = parse_graphics_info(avatar.graphics_info_symbol)
        mach_info = parse_graphics_info(avatar.mach_bike_graphics_info_symbol)
        acro_info = parse_graphics_info(avatar.acro_bike_graphics_info_symbol)

        for required in (
            avatar.normal_pic_symbol,
            avatar.running_pic_symbol,
            avatar.mach_bike_pic_symbol,
            avatar.acro_bike_pic_symbol,
            avatar.normal_palette_symbol,
        ):
            if required not in incbins:
                raise ValueError(f"Missing source path for {required}")

        frame_by_sheet: dict[str, int] = {}
        frame_atlas: dict[str, Any] = {}
        global_frame_index_by_source: dict[tuple[str, int], int] = {}
        sheet_dimensions: dict[str, tuple[int, int]] = {}
        for output_frame_idx, entry in enumerate(pic_entries):
            sheet_symbol = entry["pic_symbol"]
            local_frame = frame_by_sheet.get(sheet_symbol, 0)
            frame_by_sheet[sheet_symbol] = local_frame + 1
            source_frame_key = (sheet_symbol, entry["source_frame_index"])
            global_frame_index_by_source[source_frame_key] = output_frame_idx

            sheet_path = resolve_existing_source_path(incbins[sheet_symbol])
            if sheet_symbol not in sheet_dimensions:
                sheet_dimensions[sheet_symbol] = png_dimensions(sheet_path)
            sheet_width, _sheet_height = sheet_dimensions[sheet_symbol]

            rect = sheet_rect(
                frame_index=entry["source_frame_index"],
                tile_w=entry["tile_width"],
                tile_h=entry["tile_height"],
                sheet_width=sheet_width,
            )
            frame_atlas[str(output_frame_idx)] = {
                "sheet_symbol": sheet_symbol,
                "sheet_frame_index": entry["source_frame_index"],
                "sheet_order_index": local_frame,
                "rect": rect,
            }

        validate_frame_atlas_bounds(avatar.avatar_id, frame_atlas, sheet_dimensions)

        normal_palette_path = resolve_existing_source_path(incbins[avatar.normal_palette_symbol])
        reflection_palette_path = resolve_existing_source_path(incbins["gObjectEventPal_BridgeReflection"])
        avatar_animation_sets: dict[str, Any] = {}
        for traversal_mode, set_spec in animation_sets.items():
            mode_pic_entries = traversal_mode_pic_entries(
                traversal_mode,
                normal_pic_entries,
                mach_pic_entries,
                acro_pic_entries,
            )
            mode_source_key_by_local_frame = {
                local_frame_idx: (entry["pic_symbol"], entry["source_frame_index"])
                for local_frame_idx, entry in enumerate(mode_pic_entries)
            }
            actions: dict[str, Any] = {}
            for action_id, by_dir in set_spec["actions"].items():
                directional_bindings: dict[str, Any] = {}
                for direction, cmd_symbol in by_dir.items():
                    remapped_frames: list[dict[str, Any]] = []
                    for frame in anim_cmds[cmd_symbol]:
                        source_key = mode_source_key_by_local_frame.get(frame["frame"])
                        if source_key is None:
                            raise ValueError(
                                f"Unknown local frame index {frame['frame']} for {avatar.avatar_id} "
                                f"{traversal_mode}/{action_id}/{direction}"
                            )
                        output_frame_idx = global_frame_index_by_source.get(source_key)
                        if output_frame_idx is None:
                            raise ValueError(
                                f"Missing frame mapping for {avatar.avatar_id} "
                                f"{traversal_mode}/{action_id}/{direction}: {source_key}"
                            )
                        remapped_frames.append({**frame, "frame": output_frame_idx})
                    directional_bindings[direction] = {
                        "action_id": action_id,
                        "anim_cmd_symbol": cmd_symbol,
                        "frames": remapped_frames,
                    }
                actions[action_id] = directional_bindings

            avatar_animation_sets[traversal_mode] = {
                "anim_table_symbol": set_spec["anim_table_symbol"],
                "actions": actions,
            }

        avatars.append(
            {
                "avatar_id": avatar.avatar_id,
                "graphics": {
                    "size": int(info["size"]),
                    "width": int(info["width"]),
                    "height": int(info["height"]),
                    "anchor": {
                        "x": int(info["width"]) // 2,
                        "y": int(info["height"]),
                        "mode": "bottom_center",
                    },
                    "frame_count": len(pic_entries),
                },
                "sheet_sources": {
                    "normal": {
                        "symbol": avatar.normal_pic_symbol,
                        "source_path": incbins[avatar.normal_pic_symbol],
                        "tile_width": 2,
                        "tile_height": 4,
                        "frame_count": len(normal_pic_entries),
                    },
                    "running": {
                        "symbol": avatar.running_pic_symbol,
                        "source_path": incbins[avatar.running_pic_symbol],
                        "tile_width": 2,
                        "tile_height": 4,
                        "frame_count": len(normal_pic_entries),
                    },
                    "mach_bike": {
                        "symbol": avatar.mach_bike_pic_symbol,
                        "source_path": incbins[avatar.mach_bike_pic_symbol],
                        "tile_width": int(mach_info["width"]),
                        "tile_height": int(mach_info["height"]),
                        "frame_count": len(mach_pic_entries),
                    },
                    "acro_bike": {
                        "symbol": avatar.acro_bike_pic_symbol,
                        "source_path": incbins[avatar.acro_bike_pic_symbol],
                        "tile_width": int(acro_info["width"]),
                        "tile_height": int(acro_info["height"]),
                        "frame_count": len(acro_pic_entries),
                    },
                },
                "frame_atlas": frame_atlas,
                "palettes": {
                    "normal": {
                        "symbol": avatar.normal_palette_symbol,
                        "source_path": incbins[avatar.normal_palette_symbol],
                        "colors": decode_palette(normal_palette_path),
                    },
                    "reflection": {
                        "symbol": "gObjectEventPal_BridgeReflection",
                        "source_path": incbins["gObjectEventPal_BridgeReflection"],
                        "colors": decode_palette(reflection_palette_path),
                    },
                },
                "animation_sets": avatar_animation_sets,
                "reference": {
                    "graphics_info_symbol": avatar.graphics_info_symbol,
                    "pic_table_symbol": avatar.normal_pic_table_symbol,
                    "mach_bike_graphics_info_symbol": avatar.mach_bike_graphics_info_symbol,
                    "acro_bike_graphics_info_symbol": avatar.acro_bike_graphics_info_symbol,
                    "mach_bike_pic_table_symbol": avatar.mach_bike_pic_table_symbol,
                    "acro_bike_pic_table_symbol": avatar.acro_bike_pic_table_symbol,
                    "anim_table_symbols": {
                        key: spec["anim_table_symbol"] for key, spec in animation_sets.items()
                    },
                    "palette_tag": info["paletteTag"],
                    "reflection_palette_tag": info["reflectionPaletteTag"],
                    "images_symbol": info["images"],
                    "anims_symbol": info["anims"],
                },
            }
        )

    avatars.sort(key=lambda entry: entry["avatar_id"])
    return avatars


def extract(output_dir: Path, clean: bool) -> None:
    target_root = output_dir / "players"
    if clean and target_root.exists():
        shutil.rmtree(target_root)
    target_root.mkdir(parents=True, exist_ok=True)

    avatars = resolve_assets()

    manifest = {
        "player_assets_version": PLAYER_ASSETS_VERSION,
        "avatars": avatars,
    }
    (target_root / "players_manifest.json").write_text(
        json.dumps(manifest, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )

    incbins = parse_incbin_paths()
    for avatar in AVATARS:
        avatar_dir = target_root / avatar.avatar_id
        avatar_dir.mkdir(parents=True, exist_ok=True)

        for symbol in (
            avatar.normal_pic_symbol,
            avatar.running_pic_symbol,
            avatar.mach_bike_pic_symbol,
            avatar.acro_bike_pic_symbol,
            avatar.normal_palette_symbol,
        ):
            src_path = resolve_existing_source_path(incbins[symbol])
            shutil.copy2(src_path, avatar_dir / src_path.name)

    reflection_src = resolve_existing_source_path(incbins["gObjectEventPal_BridgeReflection"])
    shutil.copy2(reflection_src, target_root / reflection_src.name)

    print(f"Extracted player assets manifest and binaries to {target_root}")


def validate() -> None:
    avatars = resolve_assets()
    print(f"Validated player asset references for {len(avatars)} avatar(s).")
    for avatar in avatars:
        print(
            f" - {avatar['avatar_id']}: {avatar['graphics']['frame_count']} frames, "
            f"{avatar['graphics']['width']}x{avatar['graphics']['height']}"
        )


def main() -> None:
    parser = argparse.ArgumentParser(description="Player asset extractor for rebuild assets.")
    subparsers = parser.add_subparsers(dest="command", required=True)

    validate_parser = subparsers.add_parser("validate", help="Validate referenced player asset definitions")
    validate_parser.set_defaults(func=lambda _args: validate())

    extract_parser = subparsers.add_parser("extract", help="Extract player asset manifest and source binaries")
    extract_parser.add_argument("--output-dir", type=Path, default=ROOT / "rebuild/assets")
    extract_parser.add_argument("--clean", action="store_true", help="Remove rebuild/assets/players before extraction")
    extract_parser.set_defaults(func=lambda args: extract(args.output_dir, args.clean))

    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()

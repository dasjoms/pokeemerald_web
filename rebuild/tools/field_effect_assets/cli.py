#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import re
import shutil
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[3]
FIELD_EFFECT_ASSETS_VERSION = 1


def read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def parse_graphics_incbin_paths() -> dict[str, str]:
    text = read_text(ROOT / "src/data/object_events/object_event_graphics.h")
    matches = re.findall(
        r"const\s+u(?:16|32|8)\s+([A-Za-z0-9_]+)\[\]\s*=\s*INCBIN_U(?:16|32|8)\(\"([^\"]+)\"\);",
        text,
    )
    return {symbol: rel_path for symbol, rel_path in matches}


def parse_define_ints(path: Path, names: list[str]) -> dict[str, int]:
    text = read_text(path)
    parsed: dict[str, int] = {}
    for name in names:
        match = re.search(rf"#define\s+{re.escape(name)}\s+(0x[0-9A-Fa-f]+|\d+)", text)
        if not match:
            raise ValueError(f"Missing #define for {name} in {path}")
        parsed[name] = int(match.group(1), 0)
    return parsed


def parse_numeric_array(path: Path, array_symbol: str) -> list[int]:
    text = read_text(path)
    block_match = re.search(
        rf"(?:static\s+)?const\s+u(?:8|16|32)\s+{re.escape(array_symbol)}\[\]\s*=\s*\{{(.*?)\}};",
        text,
        re.S,
    )
    if not block_match:
        raise ValueError(f"Missing numeric array {array_symbol} in {path}")

    block = block_match.group(1)
    values: list[int] = []
    for raw in block.split(","):
        token = raw.split("//", 1)[0].strip()
        if not token:
            continue
        if re.fullmatch(r"0x[0-9A-Fa-f]+|\d+", token):
            values.append(int(token, 0))
    if not values:
        raise ValueError(f"No numeric values in {array_symbol}")
    return values


def parse_u8_macro_array(path: Path, array_symbol: str, macro_values: dict[str, int]) -> list[int]:
    text = read_text(path)
    block_match = re.search(
        rf"(?:static\s+)?const\s+u8\s+{re.escape(array_symbol)}\[\]\s*=\s*\{{(.*?)\}};",
        text,
        re.S,
    )
    if not block_match:
        raise ValueError(f"Missing u8 array {array_symbol} in {path}")

    block = block_match.group(1)
    values: list[int] = []
    for raw in block.split(","):
        token = raw.split("//", 1)[0].strip()
        if not token:
            continue
        if token in macro_values:
            values.append(macro_values[token])
            continue
        if re.fullmatch(r"0x[0-9A-Fa-f]+|\d+", token):
            values.append(int(token, 0))
            continue
        raise ValueError(f"Unsupported token {token!r} in {array_symbol}")
    if not values:
        raise ValueError(f"No values in {array_symbol}")
    return values


def parse_pic_table(field_effect_objects_text: str, table_symbol: str) -> list[dict[str, Any]]:
    block_match = re.search(
        rf"static\s+const\s+struct\s+SpriteFrameImage\s+{re.escape(table_symbol)}\[\]\s*=\s*\{{(.*?)\}};",
        field_effect_objects_text,
        re.S,
    )
    if not block_match:
        raise ValueError(f"Missing pic table {table_symbol}")

    entries: list[dict[str, Any]] = []
    block = block_match.group(1)
    for symbol in re.findall(r"obj_frame_tiles\((gFieldEffectObjectPic_[A-Za-z0-9_]+)\)", block):
        entries.append(
            {
                "source_symbol": symbol,
                "layout": "obj_frame_tiles",
            }
        )
    for symbol, tile_w, tile_h, frame_idx in re.findall(
        r"overworld_frame\((gFieldEffectObjectPic_[A-Za-z0-9_]+),\s*(\d+),\s*(\d+),\s*(\d+)\)",
        block,
    ):
        entries.append(
            {
                "source_symbol": symbol,
                "layout": "overworld_frame",
                "tile_width": int(tile_w),
                "tile_height": int(tile_h),
                "frame_index": int(frame_idx),
            }
        )

    if not entries:
        raise ValueError(f"No entries parsed for pic table {table_symbol}")
    return entries


def parse_anim_table(field_effect_objects_text: str, table_symbol: str) -> dict[str, Any]:
    table_block_match = re.search(
        rf"static\s+const\s+union\s+AnimCmd\s+\*const\s+{re.escape(table_symbol)}\[\]\s*=\s*\{{(.*?)\}};",
        field_effect_objects_text,
        re.S,
    )
    if not table_block_match:
        raise ValueError(f"Missing anim table {table_symbol}")

    table_entries = [
        token.strip()
        for token in table_block_match.group(1).split(",")
        if token.strip() and not token.strip().startswith("//")
    ]

    sequences: dict[str, list[dict[str, int]]] = {}
    for anim_symbol in table_entries:
        anim_block_match = re.search(
            rf"static\s+const\s+union\s+AnimCmd\s+{re.escape(anim_symbol)}\[\]\s*=\s*\{{(.*?)\}};",
            field_effect_objects_text,
            re.S,
        )
        if not anim_block_match:
            raise ValueError(f"Missing anim cmd block {anim_symbol}")

        frames: list[dict[str, int]] = []
        for frame_idx, duration in re.findall(
            r"ANIMCMD_FRAME\((\d+),\s*(\d+)(?:,\s*\.hFlip\s*=\s*(?:TRUE|FALSE))?\)",
            anim_block_match.group(1),
        ):
            frames.append({"frame": int(frame_idx), "duration": int(duration)})

        sequences[anim_symbol] = frames

    return {
        "anim_cmd_symbols": table_entries,
        "sequences": sequences,
    }


def parse_sprite_template(field_effect_objects_text: str, template_symbol: str) -> dict[str, Any]:
    block_match = re.search(
        rf"const\s+struct\s+SpriteTemplate\s+{re.escape(template_symbol)}\s*=\s*\{{(.*?)\}};",
        field_effect_objects_text,
        re.S,
    )
    if not block_match:
        raise ValueError(f"Missing sprite template {template_symbol}")

    fields: dict[str, str] = {}
    for key, value in re.findall(r"\.(\w+)\s*=\s*([^,]+),", block_match.group(1)):
        fields[key] = value.strip().lstrip("&")

    for key in ("oam", "anims", "images", "paletteTag", "callback"):
        if key not in fields:
            raise ValueError(f"Missing .{key} in {template_symbol}")
    return fields


def resolve_assets() -> dict[str, Any]:
    graphics_paths = parse_graphics_incbin_paths()
    object_templates_text = read_text(ROOT / "src/data/field_effects/field_effect_objects.h")

    effect_obj_defines = parse_define_ints(
        ROOT / "include/constants/field_effects.h",
        ["FLDEFFOBJ_SHADOW_S", "FLDEFFOBJ_SHADOW_M", "FLDEFFOBJ_SHADOW_L", "FLDEFFOBJ_SHADOW_XL"],
    )

    shadow_template_ids = parse_u8_macro_array(
        ROOT / "src/field_effect_helpers.c",
        "sShadowEffectTemplateIds",
        effect_obj_defines,
    )
    shadow_vertical_offsets = parse_numeric_array(ROOT / "src/field_effect_helpers.c", "gShadowVerticalOffsets")

    shadow_templates = [
        "gFieldEffectObjectTemplate_ShadowSmall",
        "gFieldEffectObjectTemplate_ShadowMedium",
        "gFieldEffectObjectTemplate_ShadowLarge",
        "gFieldEffectObjectTemplate_ShadowExtraLarge",
    ]

    shadow_template_payload: list[dict[str, Any]] = []
    for template_symbol in shadow_templates:
        template = parse_sprite_template(object_templates_text, template_symbol)
        pic_entries = parse_pic_table(object_templates_text, template["images"])
        anim_table = parse_anim_table(object_templates_text, template["anims"])
        sources = []
        for entry in pic_entries:
            src_symbol = entry["source_symbol"]
            if src_symbol not in graphics_paths:
                raise ValueError(f"Missing graphics source path for {src_symbol}")
            sources.append(
                {
                    "symbol": src_symbol,
                    "source_path": graphics_paths[src_symbol],
                }
            )

        shadow_template_payload.append(
            {
                "template_symbol": template_symbol,
                "palette_tag": template["paletteTag"],
                "oam_symbol": template["oam"],
                "callback": template["callback"],
                "pic_table_symbol": template["images"],
                "anim_table_symbol": template["anims"],
                "pic_table_entries": pic_entries,
                "anim_table": anim_table,
                "sources": sources,
            }
        )

    dust_template_symbol = "gFieldEffectObjectTemplate_GroundImpactDust"
    dust_template = parse_sprite_template(object_templates_text, dust_template_symbol)
    dust_pic_entries = parse_pic_table(object_templates_text, dust_template["images"])
    dust_anim_table = parse_anim_table(object_templates_text, dust_template["anims"])
    dust_sources_map: dict[str, str] = {}
    for entry in dust_pic_entries:
        src_symbol = entry["source_symbol"]
        if src_symbol not in graphics_paths:
            raise ValueError(f"Missing graphics source path for {src_symbol}")
        dust_sources_map[src_symbol] = graphics_paths[src_symbol]
    dust_sources = [
        {"symbol": symbol, "source_path": source_path}
        for symbol, source_path in sorted(dust_sources_map.items())
    ]

    palette_symbols = ["gFieldEffectObjectPalette0", "gFieldEffectObjectPalette1"]
    palettes = []
    for symbol in palette_symbols:
        if symbol not in graphics_paths:
            raise ValueError(f"Missing palette source path for {symbol}")
        palettes.append({"symbol": symbol, "source_path": graphics_paths[symbol]})

    return {
        "version": FIELD_EFFECT_ASSETS_VERSION,
        "effects": {
            "shadow": {
                "field_effect_id": "FLDEFF_SHADOW",
                "helper_function": "FldEff_Shadow",
                "helper_update_callback": "UpdateShadowFieldEffect",
                "shadow_template_ids": shadow_template_ids,
                "shadow_vertical_offsets": shadow_vertical_offsets,
                "templates": shadow_template_payload,
            },
            "ground_impact_dust": {
                "field_effect_id": "FLDEFF_DUST",
                "helper_function": "FldEff_Dust",
                "helper_update_callback": "UpdateJumpImpactEffect",
                "template": {
                    "template_symbol": dust_template_symbol,
                    "palette_tag": dust_template["paletteTag"],
                    "oam_symbol": dust_template["oam"],
                    "callback": dust_template["callback"],
                    "pic_table_symbol": dust_template["images"],
                    "anim_table_symbol": dust_template["anims"],
                    "pic_table_entries": dust_pic_entries,
                    "anim_table": dust_anim_table,
                    "sources": dust_sources,
                },
            },
        },
        "palettes": palettes,
        "source_files": [
            "include/constants/field_effects.h",
            "src/field_effect_helpers.c",
            "src/data/object_events/object_event_graphics.h",
            "src/data/field_effects/field_effect_objects.h",
        ],
    }


def validate_assets(payload: dict[str, Any]) -> None:
    shadow_templates = payload["effects"]["shadow"]["templates"]
    if len(shadow_templates) != 4:
        raise ValueError("Expected exactly 4 shadow templates")

    shadow_offsets = payload["effects"]["shadow"]["shadow_vertical_offsets"]
    shadow_template_ids = payload["effects"]["shadow"]["shadow_template_ids"]
    if len(shadow_offsets) != 4:
        raise ValueError("Expected 4 shadow vertical offsets")
    if len(shadow_template_ids) != 4:
        raise ValueError("Expected 4 shadow template ids")

    for template in shadow_templates:
        if template["callback"] != "UpdateShadowFieldEffect":
            raise ValueError(f"Unexpected shadow callback: {template['callback']}")

    dust = payload["effects"]["ground_impact_dust"]["template"]
    if dust["callback"] != "UpdateJumpImpactEffect":
        raise ValueError(f"Unexpected dust callback: {dust['callback']}")

    dust_anim_symbols = dust["anim_table"]["anim_cmd_symbols"]
    if len(dust_anim_symbols) != 1:
        raise ValueError("Expected one dust anim cmd symbol")

    frames = dust["anim_table"]["sequences"][dust_anim_symbols[0]]
    expected = [8, 8, 8]
    durations = [frame["duration"] for frame in frames]
    if durations != expected:
        raise ValueError(f"Unexpected dust frame durations: {durations} != {expected}")


def write_manifest(output_dir: Path, payload: dict[str, Any]) -> Path:
    target_dir = output_dir / "field_effects"
    target_dir.mkdir(parents=True, exist_ok=True)
    manifest_path = target_dir / "acro_bike_effects_manifest.json"
    manifest_path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    return manifest_path


def command_validate() -> int:
    payload = resolve_assets()
    validate_assets(payload)
    shadow_sources = {
        source["source_path"]
        for template in payload["effects"]["shadow"]["templates"]
        for source in template["sources"]
    }
    dust_sources = {source["source_path"] for source in payload["effects"]["ground_impact_dust"]["template"]["sources"]}
    print(
        "Validated acro bike field effects extraction inputs: "
        f"shadow_templates={len(payload['effects']['shadow']['templates'])} "
        f"shadow_sources={len(shadow_sources)} "
        f"dust_sources={len(dust_sources)}"
    )
    return 0


def command_extract(output_dir: Path, clean: bool) -> int:
    if clean:
        target_dir = output_dir / "field_effects"
        if target_dir.exists():
            shutil.rmtree(target_dir)

    payload = resolve_assets()
    validate_assets(payload)
    path = write_manifest(output_dir, payload)
    print(f"Wrote acro bike field effects manifest: {path.relative_to(ROOT)}")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python3 -m rebuild.tools.field_effect_assets.cli",
        description=(
            "Extract ROM-reference acro-bike hop field-effect metadata into rebuild assets "
            "(shadow + ground impact dust)."
        ),
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    subparsers.add_parser("validate", help="validate source references and decoded metadata")

    extract = subparsers.add_parser("extract", help="write rebuild-owned effect manifest")
    extract.add_argument("--output-dir", type=Path, default=ROOT / "rebuild/assets")
    extract.add_argument("--clean", action="store_true")

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)

    if args.command == "validate":
        return command_validate()
    if args.command == "extract":
        return command_extract(args.output_dir.resolve(), bool(args.clean))

    parser.error(f"unsupported command: {args.command}")
    return 2


if __name__ == "__main__":
    raise SystemExit(main())

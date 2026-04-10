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


def format_path_for_log(path: Path) -> str:
    try:
        return str(path.relative_to(ROOT))
    except ValueError:
        return str(path)


def resolve_existing_source_path(source_path: str) -> Path:
    requested = ROOT / source_path
    if requested.exists():
        return requested

    if requested.suffix.lower() == ".4bpp":
        png_candidate = requested.with_suffix(".png")
        if png_candidate.exists():
            return png_candidate
    if requested.suffix.lower() == ".gbapal":
        pal_candidate = requested.with_suffix(".pal")
        if pal_candidate.exists():
            return pal_candidate

    raise FileNotFoundError(f"Missing source asset for {source_path} (also checked known extension fallbacks)")


def resolve_existing_source_path_optional(source_path: str) -> Path | None:
    try:
        return resolve_existing_source_path(source_path)
    except FileNotFoundError:
        return None


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


def build_effect_template_payload(
    *,
    effect_id: str,
    helper_function: str,
    template_symbol: str,
    graphics_paths: dict[str, str],
    field_effect_objects_text: str,
) -> dict[str, Any]:
    template = parse_sprite_template(field_effect_objects_text, template_symbol)
    pic_entries = parse_pic_table(field_effect_objects_text, template["images"])
    anim_table = parse_anim_table(field_effect_objects_text, template["anims"])
    sources_map: dict[str, str] = {}
    for entry in pic_entries:
        src_symbol = entry["source_symbol"]
        if src_symbol not in graphics_paths:
            raise ValueError(f"Missing graphics source path for {src_symbol}")
        sources_map[src_symbol] = graphics_paths[src_symbol]
    sources = [
        {"symbol": symbol, "source_path": source_path}
        for symbol, source_path in sorted(sources_map.items())
    ]

    return {
        "field_effect_id": effect_id,
        "helper_function": helper_function,
        "helper_update_callback": "UpdateJumpImpactEffect",
        "template": {
            "template_symbol": template_symbol,
            "palette_tag": template["paletteTag"],
            "oam_symbol": template["oam"],
            "callback": template["callback"],
            "pic_table_symbol": template["images"],
            "anim_table_symbol": template["anims"],
            "pic_table_entries": pic_entries,
            "anim_table": anim_table,
            "sources": sources,
        },
    }


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
        sources_map: dict[str, str] = {}
        for entry in pic_entries:
            src_symbol = entry["source_symbol"]
            if src_symbol not in graphics_paths:
                raise ValueError(f"Missing graphics source path for {src_symbol}")
            sources_map[src_symbol] = graphics_paths[src_symbol]
        sources = [
            {"symbol": symbol, "source_path": source_path}
            for symbol, source_path in sorted(sources_map.items())
        ]

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

    jump_impact_effect_configs = [
        ("ground_impact_dust", "FLDEFF_DUST", "FldEff_Dust", "gFieldEffectObjectTemplate_GroundImpactDust"),
        ("jump_tall_grass", "FLDEFF_JUMP_TALL_GRASS", "FldEff_JumpTallGrass", "gFieldEffectObjectTemplate_JumpTallGrass"),
        ("jump_long_grass", "FLDEFF_JUMP_LONG_GRASS", "FldEff_JumpLongGrass", "gFieldEffectObjectTemplate_JumpLongGrass"),
        ("jump_small_splash", "FLDEFF_JUMP_SMALL_SPLASH", "FldEff_JumpSmallSplash", "gFieldEffectObjectTemplate_JumpSmallSplash"),
        ("jump_big_splash", "FLDEFF_JUMP_BIG_SPLASH", "FldEff_JumpBigSplash", "gFieldEffectObjectTemplate_JumpBigSplash"),
    ]
    jump_impact_effects = {
        effect_key: build_effect_template_payload(
            effect_id=effect_id,
            helper_function=helper_function,
            template_symbol=template_symbol,
            graphics_paths=graphics_paths,
            field_effect_objects_text=object_templates_text,
        )
        for effect_key, effect_id, helper_function, template_symbol in jump_impact_effect_configs
    }

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
            **jump_impact_effects,
        },
        "palettes": palettes,
        "source_files": [
            "include/constants/field_effects.h",
            "src/field_effect_helpers.c",
            "src/data/object_events/object_event_graphics.h",
            "src/data/field_effects/field_effect_objects.h",
        ],
    }


def collect_required_symbols(payload: dict[str, Any]) -> dict[str, str]:
    required: dict[str, str] = {}
    for template in payload["effects"]["shadow"]["templates"]:
        for source in template["sources"]:
            required[source["symbol"]] = source["source_path"]
    for effect in payload["effects"].values():
        if "template" not in effect:
            continue
        for source in effect["template"]["sources"]:
            required[source["symbol"]] = source["source_path"]
    for palette in payload["palettes"]:
        required[palette["symbol"]] = palette["source_path"]
    return required


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

    expected_durations = {
        "ground_impact_dust": [8, 8, 8],
        "jump_tall_grass": [8, 8, 8, 8],
        "jump_long_grass": [4, 4, 8, 8, 8, 8],
        "jump_small_splash": [4, 4, 4],
        "jump_big_splash": [8, 8, 8, 8],
    }
    for effect_key, expected in expected_durations.items():
        effect_template = payload["effects"][effect_key]["template"]
        if effect_template["callback"] != "UpdateJumpImpactEffect":
            raise ValueError(f"Unexpected {effect_key} callback: {effect_template['callback']}")

        anim_symbols = effect_template["anim_table"]["anim_cmd_symbols"]
        if len(anim_symbols) != 1:
            raise ValueError(f"Expected one anim cmd symbol for {effect_key}")

        frames = effect_template["anim_table"]["sequences"][anim_symbols[0]]
        durations = [frame["duration"] for frame in frames]
        if durations != expected:
            raise ValueError(f"Unexpected {effect_key} frame durations: {durations} != {expected}")


def write_manifest(output_dir: Path, payload: dict[str, Any]) -> Path:
    target_dir = output_dir / "field_effects"
    target_dir.mkdir(parents=True, exist_ok=True)
    manifest_path = target_dir / "acro_bike_effects_manifest.json"
    manifest_path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    return manifest_path


def write_runtime_assets(output_dir: Path, payload: dict[str, Any]) -> Path:
    target_dir = output_dir / "field_effects" / "acro_bike"
    pics_dir = target_dir / "pics"
    palettes_dir = target_dir / "palettes"
    pics_dir.mkdir(parents=True, exist_ok=True)
    palettes_dir.mkdir(parents=True, exist_ok=True)

    symbols = collect_required_symbols(payload)
    extracted: list[dict[str, str]] = []
    unresolved: list[dict[str, str]] = []
    for symbol, source_path in sorted(symbols.items()):
        source_abs = resolve_existing_source_path_optional(source_path)
        if source_abs is None:
            unresolved.append({"symbol": symbol, "source_path": source_path})
            continue
        is_palette = "palette" in symbol.lower() or source_abs.suffix.lower() in {".gbapal", ".pal"}
        destination_dir = palettes_dir if is_palette else pics_dir
        destination_path = destination_dir / source_abs.name
        shutil.copy2(source_abs, destination_path)
        extracted.append(
            {
                "symbol": symbol,
                "declared_source_path": source_path,
                "resolved_source_path": str(source_abs.relative_to(ROOT)),
                "output_path": str(destination_path.relative_to(output_dir)),
            }
        )

    runtime_index = {
        "version": FIELD_EFFECT_ASSETS_VERSION,
        "artifact_group": "acro_bike_field_effects",
        "files": extracted,
        "unresolved_sources": unresolved,
    }
    index_path = target_dir / "runtime_asset_index.json"
    index_path.write_text(json.dumps(runtime_index, indent=2) + "\n", encoding="utf-8")
    return index_path


def command_validate() -> int:
    payload = resolve_assets()
    validate_assets(payload)
    shadow_sources = {
        source["source_path"]
        for template in payload["effects"]["shadow"]["templates"]
        for source in template["sources"]
    }
    jump_impact_sources = {
        source["source_path"]
        for effect in payload["effects"].values()
        if "template" in effect
        for source in effect["template"]["sources"]
    }

    required = collect_required_symbols(payload)
    unresolved: list[tuple[str, str]] = []
    for symbol, source_path in required.items():
        if resolve_existing_source_path_optional(source_path) is None:
            unresolved.append((symbol, source_path))
    if unresolved:
        unresolved_csv = ", ".join(f"{symbol} -> {source_path}" for symbol, source_path in sorted(set(unresolved)))
        raise ValueError(f"Missing source assets required for extraction: {unresolved_csv}")

    print(
        "Validated acro bike field effects extraction inputs: "
        f"shadow_templates={len(payload['effects']['shadow']['templates'])} "
        f"shadow_sources={len(shadow_sources)} "
        f"jump_impact_sources={len(jump_impact_sources)} "
        f"extractable_files={len(required)}"
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
    runtime_index_path = write_runtime_assets(output_dir, payload)
    runtime_index = json.loads(runtime_index_path.read_text(encoding="utf-8"))
    print(f"Wrote acro bike field effects manifest: {format_path_for_log(path)}")
    print(f"Wrote runtime field-effect assets index: {format_path_for_log(runtime_index_path)}")
    for missing in runtime_index.get("unresolved_sources", []):
        print(
            "Unresolved field-effect source (missing art/palette): "
            f"{missing['symbol']} -> {missing['source_path']}"
        )
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python3 -m rebuild.tools.field_effect_assets.cli",
        description=(
            "Extract ROM-reference acro-bike hop field-effect metadata into rebuild assets "
            "(shadow + jump-landing effects)."
        ),
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    subparsers.add_parser("validate", help="validate source references and decoded metadata")

    extract = subparsers.add_parser("extract", help="write rebuild-owned effect manifest + runtime assets")
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

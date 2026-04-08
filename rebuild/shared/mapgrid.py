"""Shared map-grid and metatile decoding helpers for the rebuild."""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class MapGridMasks:
    metatile_id_mask: int
    collision_mask: int
    elevation_mask: int
    metatile_id_shift: int
    collision_shift: int
    elevation_shift: int


@dataclass(frozen=True)
class MetatileAttrMasks:
    behavior_mask: int
    layer_mask: int
    behavior_shift: int
    layer_shift: int


DEFAULT_MAPGRID_MASKS = MapGridMasks(
    metatile_id_mask=0x03FF,
    collision_mask=0x0C00,
    elevation_mask=0xF000,
    metatile_id_shift=0,
    collision_shift=10,
    elevation_shift=12,
)

DEFAULT_METATILE_ATTR_MASKS = MetatileAttrMasks(
    behavior_mask=0x00FF,
    layer_mask=0xF000,
    behavior_shift=0,
    layer_shift=12,
)


def decode_map_block(raw_block: int, masks: MapGridMasks = DEFAULT_MAPGRID_MASKS) -> dict[str, int]:
    return {
        "raw": raw_block,
        "metatile_id": (raw_block & masks.metatile_id_mask) >> masks.metatile_id_shift,
        "collision": (raw_block & masks.collision_mask) >> masks.collision_shift,
        "elevation": (raw_block & masks.elevation_mask) >> masks.elevation_shift,
    }


def decode_metatile_attr(raw_attr: int, masks: MetatileAttrMasks = DEFAULT_METATILE_ATTR_MASKS) -> dict[str, int]:
    return {
        "raw": raw_attr,
        "behavior_id": (raw_attr & masks.behavior_mask) >> masks.behavior_shift,
        "layer_type": (raw_attr & masks.layer_mask) >> masks.layer_shift,
    }

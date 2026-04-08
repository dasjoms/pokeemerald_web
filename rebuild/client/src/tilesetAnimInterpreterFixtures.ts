import type { TileAnimsFile } from './tilesetAnimation';

export const GENERAL_FIXTURE: TileAnimsFile = {
  tile_anims_version: 2,
  pair_id: 'gTileset_General__gTileset_Petalburg',
  programs: {
    primary: {
      source_tileset: 'gTileset_General',
      counter_max_expr: '256',
      events: [
        { gate: { mod: 16, eq: 0 }, actions: [{ args: 'timer / 16', copy_ops: [{ source_expr: 'gTilesetAnims_General_Flower[i]', frame_array: 'gTilesetAnims_General_Flower', dest_tile_indices: [508], size_tiles: 4 }], palette_ops: [] }] },
      ],
    },
    secondary: { source_tileset: 'gTileset_Petalburg', counter_max_expr: 'sPrimaryTilesetAnimCounterMax', events: [] },
  },
  frame_arrays: {
    gTilesetAnims_General_Flower: [0, 1, 0, 2],
  },
  frame_payloads: [
    { payload_id: 0, symbol_name: 'gTilesetAnims_General_Flower_Frame0', payload_offset: 0, tile_count: 4, byte_count: 128, expected_copy_size_tiles: [4] },
    { payload_id: 1, symbol_name: 'gTilesetAnims_General_Flower_Frame1', payload_offset: 128, tile_count: 4, byte_count: 128, expected_copy_size_tiles: [4] },
    { payload_id: 2, symbol_name: 'gTilesetAnims_General_Flower_Frame2', payload_offset: 256, tile_count: 4, byte_count: 128, expected_copy_size_tiles: [4] },
  ],
  frame_payload_blob: 'fixture_general.bin',
};

export const MAUVILLE_FIXTURE: TileAnimsFile = {
  tile_anims_version: 2,
  pair_id: 'gTileset_General__gTileset_Mauville',
  programs: {
    primary: { source_tileset: 'gTileset_General', counter_max_expr: '256', events: [] },
    secondary: {
      source_tileset: 'gTileset_Mauville',
      counter_max_expr: 'sPrimaryTilesetAnimCounterMax',
      events: [
        { gate: { mod: 8, eq: 0 }, actions: [{ args: 'timer / 8, 0', copy_ops: [{ source_expr: 'gTilesetAnims_Mauville_Flower1[timer_div]', frame_array: 'gTilesetAnims_Mauville_Flower1', dest_tile_indices: [608, 612, 616], size_tiles: 4 }], palette_ops: [] }] },
        { gate: { mod: 8, eq: 1 }, actions: [{ args: 'timer / 8, 1', copy_ops: [{ source_expr: 'gTilesetAnims_Mauville_Flower1[timer_div]', frame_array: 'gTilesetAnims_Mauville_Flower1', dest_tile_indices: [608, 612, 616], size_tiles: 4 }], palette_ops: [] }] },
      ],
    },
  },
  frame_arrays: { gTilesetAnims_Mauville_Flower1: [0, 1, 2, 3] },
  frame_payloads: [
    { payload_id: 0, symbol_name: 'gTilesetAnims_Mauville_Flower1_Frame0', payload_offset: 0, tile_count: 4, byte_count: 128, expected_copy_size_tiles: [4] },
    { payload_id: 1, symbol_name: 'gTilesetAnims_Mauville_Flower1_Frame1', payload_offset: 128, tile_count: 4, byte_count: 128, expected_copy_size_tiles: [4] },
    { payload_id: 2, symbol_name: 'gTilesetAnims_Mauville_Flower1_Frame2', payload_offset: 256, tile_count: 4, byte_count: 128, expected_copy_size_tiles: [4] },
    { payload_id: 3, symbol_name: 'gTilesetAnims_Mauville_Flower1_Frame3', payload_offset: 384, tile_count: 4, byte_count: 128, expected_copy_size_tiles: [4] },
  ],
  frame_payload_blob: 'fixture_mauville.bin',
};

export const SOOTOPOLIS_GYM_FIXTURE: TileAnimsFile = {
  tile_anims_version: 2,
  pair_id: 'gTileset_General__gTileset_SootopolisGym',
  programs: {
    primary: { source_tileset: 'gTileset_General', counter_max_expr: '256', events: [] },
    secondary: {
      source_tileset: 'gTileset_SootopolisGym',
      counter_max_expr: '240',
      events: [
        { gate: { mod: 8, eq: 0 }, actions: [{ args: 'timer / 8', copy_ops: [{ source_expr: 'gTilesetAnims_SootopolisGym_0[i]', frame_array: 'gTilesetAnims_SootopolisGym_0', dest_tile_indices: [976], size_tiles: 20 }], palette_ops: [] }] },
      ],
    },
  },
  frame_arrays: { gTilesetAnims_SootopolisGym_0: [0, 1, 2] },
  frame_payloads: [
    { payload_id: 0, symbol_name: 'gTilesetAnims_SootopolisGym_0_Frame0', payload_offset: 0, tile_count: 20, byte_count: 640, expected_copy_size_tiles: [20] },
    { payload_id: 1, symbol_name: 'gTilesetAnims_SootopolisGym_0_Frame1', payload_offset: 640, tile_count: 20, byte_count: 640, expected_copy_size_tiles: [20] },
    { payload_id: 2, symbol_name: 'gTilesetAnims_SootopolisGym_0_Frame2', payload_offset: 1280, tile_count: 20, byte_count: 640, expected_copy_size_tiles: [20] },
  ],
  frame_payload_blob: 'fixture_sootopolis.bin',
};

export const BATTLE_DOME_FIXTURE: TileAnimsFile = {
  tile_anims_version: 2,
  pair_id: 'gTileset_Building__gTileset_BattleDome',
  programs: {
    primary: { source_tileset: 'gTileset_Building', counter_max_expr: '256', events: [] },
    secondary: {
      source_tileset: 'gTileset_BattleDome',
      counter_max_expr: 'sPrimaryTilesetAnimCounterMax',
      events: [
        { gate: { mod: 4, eq: 0 }, actions: [{ args: 'timer / 4', copy_ops: [], palette_ops: [{ source_expr: 'sTilesetAnims_BattleDomeFloorLightPals[timer % ARRAY_COUNT(sTilesetAnims_BattleDomeFloorLightPals)]', palette_slot: 8, frame_array: 'sTilesetAnims_BattleDomeFloorLightPals' }] }] },
      ],
    },
  },
  frame_arrays: { sTilesetAnims_BattleDomeFloorLightPals: [0, 1, 2, 3] },
};

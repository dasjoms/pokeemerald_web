// Deterministic parity fixtures derived from src/tileset_anims.c for selected tilesets.

export type ExpectedCopyOp = {
  dest_tile_offset: number;
  byte_count: number;
  frame_id: number;
};

export const FIXED_TIMER_SEQUENCE = [0, 1, 2, 3, 4, 8, 16, 24, 32] as const;

export const GENERAL_PRIMARY_FIXTURE: Record<number, ExpectedCopyOp[]> = {
  0: [{ dest_tile_offset: 508, byte_count: 4 * 32, frame_id: 0 }],
  1: [{ dest_tile_offset: 432, byte_count: 30 * 32, frame_id: 0 }],
  2: [{ dest_tile_offset: 464, byte_count: 10 * 32, frame_id: 0 }],
  3: [{ dest_tile_offset: 496, byte_count: 6 * 32, frame_id: 0 }],
  4: [{ dest_tile_offset: 480, byte_count: 10 * 32, frame_id: 0 }],
  8: [],
  16: [{ dest_tile_offset: 508, byte_count: 4 * 32, frame_id: 1 }],
  24: [],
  32: [{ dest_tile_offset: 508, byte_count: 4 * 32, frame_id: 0 }],
};

export const RUSTBORO_SECONDARY_FIXTURE: Record<number, ExpectedCopyOp[]> = {
  0: [
    { dest_tile_offset: 384, byte_count: 4 * 32, frame_id: 0 },
    { dest_tile_offset: 448, byte_count: 4 * 32, frame_id: 0 },
  ],
  1: [{ dest_tile_offset: 388, byte_count: 4 * 32, frame_id: 0 }],
  2: [{ dest_tile_offset: 392, byte_count: 4 * 32, frame_id: 0 }],
  3: [{ dest_tile_offset: 396, byte_count: 4 * 32, frame_id: 0 }],
  4: [{ dest_tile_offset: 400, byte_count: 4 * 32, frame_id: 0 }],
  8: [
    { dest_tile_offset: 384, byte_count: 4 * 32, frame_id: 1 },
    { dest_tile_offset: 448, byte_count: 4 * 32, frame_id: 1 },
  ],
};

export const LAVARIDGE_SECONDARY_FIXTURE: Record<number, ExpectedCopyOp[]> = {
  0: [
    { dest_tile_offset: 288, byte_count: 4 * 32, frame_id: 0 },
    { dest_tile_offset: 292, byte_count: 4 * 32, frame_id: 2 },
  ],
  1: [{ dest_tile_offset: 160, byte_count: 4 * 32, frame_id: 0 }],
  16: [
    { dest_tile_offset: 288, byte_count: 4 * 32, frame_id: 1 },
    { dest_tile_offset: 292, byte_count: 4 * 32, frame_id: 3 },
  ],
};

export const SOOTOPOLIS_GYM_SECONDARY_FIXTURE: Record<number, ExpectedCopyOp[]> = {
  0: [
    { dest_tile_offset: 464, byte_count: 20 * 32, frame_id: 0 },
    { dest_tile_offset: 496, byte_count: 12 * 32, frame_id: 0 },
  ],
  8: [
    { dest_tile_offset: 464, byte_count: 20 * 32, frame_id: 1 },
    { dest_tile_offset: 496, byte_count: 12 * 32, frame_id: 1 },
  ],
};

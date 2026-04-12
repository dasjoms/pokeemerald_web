export const CAMERA_TILEMAP_SIZE_TILES = 32;
export const CAMERA_METATILE_BUFFER_DIM = CAMERA_TILEMAP_SIZE_TILES / 2;

export type FieldCameraOffset = {
  xTileOffset: number;
  yTileOffset: number;
  xPixelOffset: number;
  yPixelOffset: number;
};

export function createInitialFieldCameraOffset(): FieldCameraOffset {
  return {
    xTileOffset: 0,
    yTileOffset: 0,
    xPixelOffset: 0,
    yPixelOffset: 0,
  };
}

export function advanceFieldCameraByMetatile(
  offset: FieldCameraOffset,
  stepX: number,
  stepY: number,
): void {
  // Field camera tile offsets track 8x8 tile units in a 32x32 ring tilemap.
  offset.xTileOffset = mod(offset.xTileOffset + stepX * 2, CAMERA_TILEMAP_SIZE_TILES);
  offset.yTileOffset = mod(offset.yTileOffset + stepY * 2, CAMERA_TILEMAP_SIZE_TILES);
}

export function updateFieldCameraPixelOffset(
  offset: FieldCameraOffset,
  pixelOffsetX: number,
  pixelOffsetY: number,
  tileSizePx: number,
): void {
  const minOffset = -(tileSizePx - 1);
  const maxOffset = tileSizePx - 1;
  offset.xPixelOffset = Math.max(minOffset, Math.min(maxOffset, Math.round(pixelOffsetX)));
  offset.yPixelOffset = Math.max(minOffset, Math.min(maxOffset, Math.round(pixelOffsetY)));
}

export function toMetatileRingOffset(tileOffset: number): number {
  return mod(Math.floor(tileOffset / 2), CAMERA_METATILE_BUFFER_DIM);
}

export function mod(value: number, size: number): number {
  return ((value % size) + size) % size;
}

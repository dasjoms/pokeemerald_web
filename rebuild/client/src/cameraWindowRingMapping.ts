export type EnteringCameraSliceInput = {
  stepX: number;
  stepY: number;
  windowOriginTileX: number;
  windowOriginTileY: number;
  bufferDim: number;
};

export type EnteringCameraSlot = {
  slotX: number;
  slotY: number;
  worldTileX: number;
  worldTileY: number;
};

export function computeEnteringCameraSliceSlots(
  input: EnteringCameraSliceInput,
): EnteringCameraSlot[] {
  const {
    stepX,
    stepY,
    windowOriginTileX,
    windowOriginTileY,
    bufferDim,
  } = input;
  if (stepX > 0) {
    const slotX = bufferDim - 1;
    const worldTileX = windowOriginTileX + bufferDim - 1;
    return Array.from({ length: bufferDim }, (_, slotY) => ({
      slotX,
      slotY,
      worldTileX,
      worldTileY: windowOriginTileY + slotY,
    }));
  }
  if (stepX < 0) {
    const slotX = 0;
    const worldTileX = windowOriginTileX;
    return Array.from({ length: bufferDim }, (_, slotY) => ({
      slotX,
      slotY,
      worldTileX,
      worldTileY: windowOriginTileY + slotY,
    }));
  }
  if (stepY > 0) {
    const slotY = bufferDim - 1;
    const worldTileY = windowOriginTileY + bufferDim - 1;
    return Array.from({ length: bufferDim }, (_, slotX) => ({
      slotX,
      slotY,
      worldTileX: windowOriginTileX + slotX,
      worldTileY,
    }));
  }
  const slotY = 0;
  const worldTileY = windowOriginTileY;
  return Array.from({ length: bufferDim }, (_, slotX) => ({
    slotX,
    slotY,
    worldTileX: windowOriginTileX + slotX,
    worldTileY,
  }));
}

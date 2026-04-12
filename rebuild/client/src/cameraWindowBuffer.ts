import {
  CAMERA_METATILE_BUFFER_DIM,
  createInitialFieldCameraOffset,
  mod as cameraMod,
  toMetatileRingOffset,
  type FieldCameraOffset,
} from './cameraTilemap';
import { VIEWPORT_PLAYER_ANCHOR_TILE_X } from './cameraViewport';

export type CameraWindowOrigin = {
  originTileX: number;
  originTileY: number;
};

export type CameraWindowTileRedraw = {
  bufferX: number;
  bufferY: number;
  worldTileX: number;
  worldTileY: number;
};

export function initializeCameraWindowOriginFromPlayerTile(
  playerTileX: number,
  playerTileY: number,
): CameraWindowOrigin {
  return {
    originTileX: playerTileX - VIEWPORT_PLAYER_ANCHOR_TILE_X,
    originTileY: playerTileY - Math.floor(CAMERA_METATILE_BUFFER_DIM / 2),
  };
}

export function createInitialCameraWindowOffset(): FieldCameraOffset {
  return createInitialFieldCameraOffset();
}

export function resolveEnteringCameraSlice(
  origin: CameraWindowOrigin,
  offset: FieldCameraOffset,
  stepX: number,
  stepY: number,
): CameraWindowTileRedraw[] {
  const ringOffsetX = toMetatileRingOffset(offset.xTileOffset);
  const ringOffsetY = toMetatileRingOffset(offset.yTileOffset);
  const redraws: CameraWindowTileRedraw[] = [];

  if (stepX > 0) {
    const bufferX = cameraMod(ringOffsetX + CAMERA_METATILE_BUFFER_DIM - 1, CAMERA_METATILE_BUFFER_DIM);
    const worldTileX = origin.originTileX + CAMERA_METATILE_BUFFER_DIM - 1;
    for (let logicalY = 0; logicalY < CAMERA_METATILE_BUFFER_DIM; logicalY += 1) {
      redraws.push({
        bufferX,
        bufferY: cameraMod(logicalY + ringOffsetY, CAMERA_METATILE_BUFFER_DIM),
        worldTileX,
        worldTileY: origin.originTileY + logicalY,
      });
    }
    return redraws;
  }

  if (stepX < 0) {
    const bufferX = ringOffsetX;
    const worldTileX = origin.originTileX;
    for (let logicalY = 0; logicalY < CAMERA_METATILE_BUFFER_DIM; logicalY += 1) {
      redraws.push({
        bufferX,
        bufferY: cameraMod(logicalY + ringOffsetY, CAMERA_METATILE_BUFFER_DIM),
        worldTileX,
        worldTileY: origin.originTileY + logicalY,
      });
    }
    return redraws;
  }

  if (stepY > 0) {
    const bufferY = cameraMod(ringOffsetY + CAMERA_METATILE_BUFFER_DIM - 1, CAMERA_METATILE_BUFFER_DIM);
    const worldTileY = origin.originTileY + CAMERA_METATILE_BUFFER_DIM - 1;
    for (let logicalX = 0; logicalX < CAMERA_METATILE_BUFFER_DIM; logicalX += 1) {
      redraws.push({
        bufferX: cameraMod(logicalX + ringOffsetX, CAMERA_METATILE_BUFFER_DIM),
        bufferY,
        worldTileX: origin.originTileX + logicalX,
        worldTileY,
      });
    }
    return redraws;
  }

  const bufferY = ringOffsetY;
  const worldTileY = origin.originTileY;
  for (let logicalX = 0; logicalX < CAMERA_METATILE_BUFFER_DIM; logicalX += 1) {
    redraws.push({
      bufferX: cameraMod(logicalX + ringOffsetX, CAMERA_METATILE_BUFFER_DIM),
      bufferY,
      worldTileX: origin.originTileX + logicalX,
      worldTileY,
    });
  }
  return redraws;
}

export function resolvePreloadEnteringCameraSlice(
  origin: CameraWindowOrigin,
  offset: FieldCameraOffset,
  stepX: number,
  stepY: number,
): CameraWindowTileRedraw[] {
  const ringOffsetX = toMetatileRingOffset(offset.xTileOffset);
  const ringOffsetY = toMetatileRingOffset(offset.yTileOffset);
  const redraws: CameraWindowTileRedraw[] = [];

  if (stepX > 0) {
    const bufferX = cameraMod(ringOffsetX + CAMERA_METATILE_BUFFER_DIM - 1, CAMERA_METATILE_BUFFER_DIM);
    const worldTileX = origin.originTileX + CAMERA_METATILE_BUFFER_DIM;
    for (let logicalY = 0; logicalY < CAMERA_METATILE_BUFFER_DIM; logicalY += 1) {
      redraws.push({
        bufferX,
        bufferY: cameraMod(logicalY + ringOffsetY, CAMERA_METATILE_BUFFER_DIM),
        worldTileX,
        worldTileY: origin.originTileY + logicalY,
      });
    }
    return redraws;
  }

  if (stepX < 0) {
    const bufferX = ringOffsetX;
    const worldTileX = origin.originTileX - 1;
    for (let logicalY = 0; logicalY < CAMERA_METATILE_BUFFER_DIM; logicalY += 1) {
      redraws.push({
        bufferX,
        bufferY: cameraMod(logicalY + ringOffsetY, CAMERA_METATILE_BUFFER_DIM),
        worldTileX,
        worldTileY: origin.originTileY + logicalY,
      });
    }
    return redraws;
  }

  if (stepY > 0) {
    const bufferY = cameraMod(ringOffsetY + CAMERA_METATILE_BUFFER_DIM - 1, CAMERA_METATILE_BUFFER_DIM);
    const worldTileY = origin.originTileY + CAMERA_METATILE_BUFFER_DIM;
    for (let logicalX = 0; logicalX < CAMERA_METATILE_BUFFER_DIM; logicalX += 1) {
      redraws.push({
        bufferX: cameraMod(logicalX + ringOffsetX, CAMERA_METATILE_BUFFER_DIM),
        bufferY,
        worldTileX: origin.originTileX + logicalX,
        worldTileY,
      });
    }
    return redraws;
  }

  const bufferY = ringOffsetY;
  const worldTileY = origin.originTileY - 1;
  for (let logicalX = 0; logicalX < CAMERA_METATILE_BUFFER_DIM; logicalX += 1) {
    redraws.push({
      bufferX: cameraMod(logicalX + ringOffsetX, CAMERA_METATILE_BUFFER_DIM),
      bufferY,
      worldTileX: origin.originTileX + logicalX,
      worldTileY,
    });
  }
  return redraws;
}

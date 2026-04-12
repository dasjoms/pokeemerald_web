const METATILE_SIZE_PX = 16;
const BG_TILE_WRAP = 32;
const BG_TILES_PER_METATILE = 2;

type CameraDirection = 'north' | 'south' | 'west' | 'east';

export type FieldCameraParityState = {
  cameraPxX: number;
  cameraPxY: number;
  xPixelOffset: number;
  yPixelOffset: number;
  xTileOffset: number;
  yTileOffset: number;
  anchorMetatileX: number;
  anchorMetatileY: number;
  lastRenderTileX: number;
  lastRenderTileY: number;
};

export type CameraBoundaryEvent = {
  kind: 'metatile-cross';
  dir: CameraDirection;
  count: number;
};

export type FieldCameraParityUpdateResult = {
  state: FieldCameraParityState;
  boundaryEvents: CameraBoundaryEvent[];
  pixelDeltaX: number;
  pixelDeltaY: number;
};

/**
 * Initializes camera parity state from the current authoritative render tile.
 *
 * Anchor rule (shadow mode, current implementation):
 * - `anchorMetatileX/Y` start at the integer tile position passed in here.
 * - They then move by +/- 1 for each metatile boundary crossing event.
 *
 * This intentionally mirrors camera-center metatile tracking only; later renderer
 * integration can derive top-left ring-buffer anchors from this stable center anchor.
 */
export function initFieldCameraParityFromTile(
  tileX: number,
  tileY: number,
): FieldCameraParityState {
  const cameraPxX = Math.round(tileX * METATILE_SIZE_PX);
  const cameraPxY = Math.round(tileY * METATILE_SIZE_PX);

  const state: FieldCameraParityState = {
    cameraPxX,
    cameraPxY,
    xPixelOffset: modNonNegative(cameraPxX, METATILE_SIZE_PX),
    yPixelOffset: modNonNegative(cameraPxY, METATILE_SIZE_PX),
    xTileOffset: 0,
    yTileOffset: 0,
    anchorMetatileX: Math.floor(tileX),
    anchorMetatileY: Math.floor(tileY),
    lastRenderTileX: tileX,
    lastRenderTileY: tileY,
  };
  assertParityInvariants(state);
  return state;
}

/**
 * Shadow parity update that computes ROM-style camera counters/offsets.
 *
 * @example
 * // Eastward metatile crossing (+16 px): xPixelOffset wraps and xTileOffset +2.
 * const start = initFieldCameraParityFromTile(10, 5);
 * const east = updateFieldCameraParity(start, 11, 5);
 * // east.state.xPixelOffset === 0
 * // east.state.xTileOffset === 2
 * // east.boundaryEvents[0] === { kind: 'metatile-cross', dir: 'east', count: 1 }
 *
 * @example
 * // Westward metatile crossing (-16 px): xPixelOffset wraps and xTileOffset -2 mod 32.
 * const start = initFieldCameraParityFromTile(10, 5);
 * const west = updateFieldCameraParity(start, 9, 5);
 * // west.state.xPixelOffset === 0
 * // west.state.xTileOffset === 30
 * // west.boundaryEvents[0] === { kind: 'metatile-cross', dir: 'west', count: 1 }
 */
export function updateFieldCameraParity(
  state: FieldCameraParityState,
  renderTileX: number,
  renderTileY: number,
): FieldCameraParityUpdateResult {
  const nextCameraPxX = Math.round(renderTileX * METATILE_SIZE_PX);
  const nextCameraPxY = Math.round(renderTileY * METATILE_SIZE_PX);

  const pixelDeltaX = nextCameraPxX - state.cameraPxX;
  const pixelDeltaY = nextCameraPxY - state.cameraPxY;

  const crossX =
    floorDiv(state.cameraPxX + pixelDeltaX, METATILE_SIZE_PX) -
    floorDiv(state.cameraPxX, METATILE_SIZE_PX);
  const crossY =
    floorDiv(state.cameraPxY + pixelDeltaY, METATILE_SIZE_PX) -
    floorDiv(state.cameraPxY, METATILE_SIZE_PX);

  const boundaryEvents: CameraBoundaryEvent[] = [];
  if (crossX > 0) {
    boundaryEvents.push({ kind: 'metatile-cross', dir: 'east', count: crossX });
  } else if (crossX < 0) {
    boundaryEvents.push({ kind: 'metatile-cross', dir: 'west', count: -crossX });
  }

  if (crossY > 0) {
    boundaryEvents.push({ kind: 'metatile-cross', dir: 'south', count: crossY });
  } else if (crossY < 0) {
    boundaryEvents.push({ kind: 'metatile-cross', dir: 'north', count: -crossY });
  }

  const nextState: FieldCameraParityState = {
    cameraPxX: nextCameraPxX,
    cameraPxY: nextCameraPxY,
    xPixelOffset: modNonNegative(nextCameraPxX, METATILE_SIZE_PX),
    yPixelOffset: modNonNegative(nextCameraPxY, METATILE_SIZE_PX),
    xTileOffset: modNonNegative(
      state.xTileOffset + crossX * BG_TILES_PER_METATILE,
      BG_TILE_WRAP,
    ),
    yTileOffset: modNonNegative(
      state.yTileOffset + crossY * BG_TILES_PER_METATILE,
      BG_TILE_WRAP,
    ),
    anchorMetatileX: state.anchorMetatileX + crossX,
    anchorMetatileY: state.anchorMetatileY + crossY,
    lastRenderTileX: renderTileX,
    lastRenderTileY: renderTileY,
  };

  assertParityInvariants(nextState);

  return {
    state: nextState,
    boundaryEvents,
    pixelDeltaX,
    pixelDeltaY,
  };
}

function modNonNegative(value: number, modulo: number): number {
  return ((value % modulo) + modulo) % modulo;
}

function floorDiv(value: number, divisor: number): number {
  return Math.floor(value / divisor);
}

function assertParityInvariants(state: FieldCameraParityState): void {
  if (!import.meta.env.DEV) {
    return;
  }

  if (!Number.isInteger(state.cameraPxX) || !Number.isInteger(state.cameraPxY)) {
    throw new Error('fieldCameraParity invariant violated: cameraPx must be integer');
  }
  if (!Number.isInteger(state.xPixelOffset) || state.xPixelOffset < 0 || state.xPixelOffset > 15) {
    throw new Error('fieldCameraParity invariant violated: xPixelOffset out of range [0, 15]');
  }
  if (!Number.isInteger(state.yPixelOffset) || state.yPixelOffset < 0 || state.yPixelOffset > 15) {
    throw new Error('fieldCameraParity invariant violated: yPixelOffset out of range [0, 15]');
  }
  if (!Number.isInteger(state.xTileOffset) || state.xTileOffset < 0 || state.xTileOffset > 31) {
    throw new Error('fieldCameraParity invariant violated: xTileOffset out of range [0, 31]');
  }
  if (!Number.isInteger(state.yTileOffset) || state.yTileOffset < 0 || state.yTileOffset > 31) {
    throw new Error('fieldCameraParity invariant violated: yTileOffset out of range [0, 31]');
  }
  if (state.xTileOffset % 2 !== 0) {
    throw new Error('fieldCameraParity invariant violated: xTileOffset must be even');
  }
  if (state.yTileOffset % 2 !== 0) {
    throw new Error('fieldCameraParity invariant violated: yTileOffset must be even');
  }
}

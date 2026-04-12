import { describe, expect, it } from 'vitest';
import { CAMERA_METATILE_BUFFER_DIM } from './cameraTilemap';
import {
  createInitialCameraWindowOffset,
  initializeCameraWindowOriginFromPlayerTile,
  resolveEnteringCameraSlice,
} from './cameraWindowBuffer';
import { resolveRenderedCameraAxisTile } from './cameraWindowTiming';
import { VIEWPORT_VISIBLE_METATILE_COLUMNS } from './cameraViewport';

type WorldCoord = { x: number; y: number };

type BufferState = {
  originX: number;
  originY: number;
  xTileOffset: number;
  yTileOffset: number;
  slots: WorldCoord[];
  lastRenderedCameraTileX: number;
};

function initializeBufferState(playerX: number, playerY: number): BufferState {
  const origin = initializeCameraWindowOriginFromPlayerTile(playerX, playerY);
  const slots: WorldCoord[] = [];
  for (let y = 0; y < CAMERA_METATILE_BUFFER_DIM; y += 1) {
    for (let x = 0; x < CAMERA_METATILE_BUFFER_DIM; x += 1) {
      slots.push({ x: origin.originTileX + x, y: origin.originTileY + y });
    }
  }
  return {
    originX: origin.originTileX,
    originY: origin.originTileY,
    xTileOffset: 0,
    yTileOffset: 0,
    slots,
    lastRenderedCameraTileX: playerX,
  };
}

function applyStep(state: BufferState, stepX: number): void {
  state.originX += stepX;
  state.xTileOffset = ((state.xTileOffset + stepX * 2) % 32 + 32) % 32;
  const redraws = resolveEnteringCameraSlice(
    { originTileX: state.originX, originTileY: state.originY },
    {
      ...createInitialCameraWindowOffset(),
      xTileOffset: state.xTileOffset,
      yTileOffset: state.yTileOffset,
    },
    stepX,
    0,
  );

  for (const redraw of redraws) {
    state.slots[redraw.bufferY * CAMERA_METATILE_BUFFER_DIM + redraw.bufferX] = {
      x: redraw.worldTileX,
      y: redraw.worldTileY,
    };
  }
}

function updateCameraWindowForRenderedTileStep(
  state: BufferState,
  renderTileX: number,
  authoritativeTileX: number,
): void {
  const renderedCameraTileX = resolveRenderedCameraAxisTile(renderTileX, authoritativeTileX);
  let diffX = renderedCameraTileX - state.lastRenderedCameraTileX;
  while (diffX !== 0) {
    if (diffX > 0) {
      applyStep(state, 1);
      diffX -= 1;
      continue;
    }
    applyStep(state, -1);
    diffX += 1;
  }
  state.lastRenderedCameraTileX = renderedCameraTileX;
}

function visibleRangeForCamera(authoritativeTileX: number, xPixelOffset: number): { minX: number; maxX: number } {
  const tileSize = 16;
  const viewportWidthPx = VIEWPORT_VISIBLE_METATILE_COLUMNS * tileSize;
  const centerX = authoritativeTileX * tileSize + tileSize / 2 + xPixelOffset;
  const minX = Math.floor((centerX - viewportWidthPx / 2) / tileSize);
  const maxX = Math.floor((centerX + viewportWidthPx / 2 - 1) / tileSize);
  return { minX, maxX };
}

describe('camera window rendered-phase step parity', () => {
  it('right movement keeps outgoing left edge backed until interpolation pans it offscreen', () => {
    const playerX = 40;
    const playerY = 30;
    const authoritativeTileX = playerX + 1;
    const state = initializeBufferState(playerX, playerY);
    const initialOriginX = state.originX;
    const outgoingLeftEdgeX = initialOriginX;

    for (const progress of [0, 0.25, 0.5, 0.75, 0.99]) {
      const renderTileX = playerX + progress;
      updateCameraWindowForRenderedTileStep(state, renderTileX, authoritativeTileX);
      expect(state.originX).toBe(initialOriginX);
      const xPixelOffset = (renderTileX - authoritativeTileX) * 16;
      const visible = visibleRangeForCamera(authoritativeTileX, xPixelOffset);
      expect(visible.minX).toBeGreaterThanOrEqual(outgoingLeftEdgeX);
      if (visible.minX === outgoingLeftEdgeX) {
        const leftEdgeBackedTiles = state.slots.filter((slot) => slot.x === outgoingLeftEdgeX);
        expect(leftEdgeBackedTiles.length).toBeGreaterThan(0);
      }
    }

    updateCameraWindowForRenderedTileStep(state, authoritativeTileX, authoritativeTileX);
    expect(state.originX).toBe(initialOriginX + 1);
  });

  it('left movement keeps outgoing right edge backed until interpolation pans it offscreen', () => {
    const playerX = 40;
    const playerY = 30;
    const authoritativeTileX = playerX - 1;
    const state = initializeBufferState(playerX, playerY);
    const initialOriginX = state.originX;
    const outgoingRightEdgeX = initialOriginX + CAMERA_METATILE_BUFFER_DIM - 1;

    for (const progress of [0, 0.25, 0.5, 0.75, 0.99]) {
      const renderTileX = playerX - progress;
      updateCameraWindowForRenderedTileStep(state, renderTileX, authoritativeTileX);
      expect(state.originX).toBe(initialOriginX);
      const xPixelOffset = (renderTileX - authoritativeTileX) * 16;
      const visible = visibleRangeForCamera(authoritativeTileX, xPixelOffset);
      expect(visible.maxX).toBeLessThanOrEqual(outgoingRightEdgeX);
      if (visible.maxX === outgoingRightEdgeX) {
        const rightEdgeBackedTiles = state.slots.filter((slot) => slot.x === outgoingRightEdgeX);
        expect(rightEdgeBackedTiles.length).toBeGreaterThan(0);
      }
    }

    updateCameraWindowForRenderedTileStep(state, authoritativeTileX, authoritativeTileX);
    expect(state.originX).toBe(initialOriginX - 1);
  });
});

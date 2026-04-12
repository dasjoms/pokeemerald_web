import { describe, expect, it } from 'vitest';
import { CAMERA_METATILE_BUFFER_DIM } from './cameraTilemap';
import {
  createInitialCameraWindowOffset,
  initializeCameraWindowOriginFromPlayerTile,
  resolveEnteringCameraSlice,
} from './cameraWindowBuffer';
import { VIEWPORT_PLAYER_ANCHOR_TILE_X, VIEWPORT_VISIBLE_METATILE_COLUMNS } from './cameraViewport';

type WorldCoord = { x: number; y: number };

type BufferState = {
  originX: number;
  originY: number;
  xTileOffset: number;
  yTileOffset: number;
  slots: WorldCoord[];
};

function worldId(x: number, y: number): number {
  return y * 10_000 + x;
}

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
  };
}

function applyStep(state: BufferState, stepX: number, stepY: number): ReturnType<typeof resolveEnteringCameraSlice> {
  state.originX += stepX;
  state.originY += stepY;
  state.xTileOffset = ((state.xTileOffset + stepX * 2) % 32 + 32) % 32;
  state.yTileOffset = ((state.yTileOffset + stepY * 2) % 32 + 32) % 32;

  const redraws = resolveEnteringCameraSlice(
    { originTileX: state.originX, originTileY: state.originY },
    {
      ...createInitialCameraWindowOffset(),
      xTileOffset: state.xTileOffset,
      yTileOffset: state.yTileOffset,
    },
    stepX,
    stepY,
  );

  for (const redraw of redraws) {
    state.slots[redraw.bufferY * CAMERA_METATILE_BUFFER_DIM + redraw.bufferX] = {
      x: redraw.worldTileX,
      y: redraw.worldTileY,
    };
  }

  return redraws;
}

function assertWindowCoverage(state: BufferState): void {
  const expected = new Set<string>();
  for (let y = 0; y < CAMERA_METATILE_BUFFER_DIM; y += 1) {
    for (let x = 0; x < CAMERA_METATILE_BUFFER_DIM; x += 1) {
      expected.add(`${state.originX + x},${state.originY + y}`);
    }
  }

  const actual = new Set<string>(state.slots.map((slot) => `${slot.x},${slot.y}`));
  expect(actual).toEqual(expected);
}

function visibleRangeForCamera(playerTileX: number, xPixelOffset: number): { minX: number; maxX: number } {
  const tileSize = 16;
  const viewportWidthPx = VIEWPORT_VISIBLE_METATILE_COLUMNS * tileSize;
  const centerX = playerTileX * tileSize + tileSize / 2 + xPixelOffset;
  const minX = Math.floor((centerX - viewportWidthPx / 2) / tileSize);
  const maxX = Math.floor((centerX + viewportWidthPx / 2 - 1) / tileSize);
  return { minX, maxX };
}

describe('camera window incoming-side redraw parity', () => {
  it('anchors horizontal origin from viewport player anchor', () => {
    const playerX = 64;
    const playerY = 32;
    const origin = initializeCameraWindowOriginFromPlayerTile(playerX, playerY);
    expect(origin.originTileX).toBe(playerX - VIEWPORT_PLAYER_ANCHOR_TILE_X);
    expect(origin.originTileY).toBe(playerY - Math.floor(CAMERA_METATILE_BUFFER_DIM / 2));
  });

  it('redraws the entering edge for right/left and bottom/top metatile steps', () => {
    const state = initializeBufferState(40, 40);

    const right = applyStep(state, 1, 0);
    expect(new Set(right.map((entry) => entry.worldTileX))).toEqual(new Set([state.originX + CAMERA_METATILE_BUFFER_DIM - 1]));

    const left = applyStep(state, -1, 0);
    expect(new Set(left.map((entry) => entry.worldTileX))).toEqual(new Set([state.originX]));

    const down = applyStep(state, 0, 1);
    expect(new Set(down.map((entry) => entry.worldTileY))).toEqual(new Set([state.originY + CAMERA_METATILE_BUFFER_DIM - 1]));

    const up = applyStep(state, 0, -1);
    expect(new Set(up.map((entry) => entry.worldTileY))).toEqual(new Set([state.originY]));
  });

  it('maintains full 16x16 window coverage across repeated right then left and left then right steps', () => {
    const state = initializeBufferState(80, 50);

    for (let index = 0; index < 6; index += 1) {
      applyStep(state, 1, 0);
      assertWindowCoverage(state);
    }
    for (let index = 0; index < 6; index += 1) {
      applyStep(state, -1, 0);
      assertWindowCoverage(state);
    }
    for (let index = 0; index < 6; index += 1) {
      applyStep(state, -1, 0);
      assertWindowCoverage(state);
    }
    for (let index = 0; index < 6; index += 1) {
      applyStep(state, 1, 0);
      assertWindowCoverage(state);
    }
  });

  it('keeps right-edge backing available while panning left after prior right progression', () => {
    const playerX = 40;
    const playerY = 30;
    const state = initializeBufferState(playerX, playerY);

    for (let index = 0; index < 5; index += 1) {
      applyStep(state, 1, 0);
    }

    applyStep(state, -1, 0);
    const authoritativePlayerX = playerX + 4;

    for (let xPixelOffset = 15; xPixelOffset >= 0; xPixelOffset -= 1) {
      const visible = visibleRangeForCamera(authoritativePlayerX, xPixelOffset);
      expect(visible.minX).toBeGreaterThanOrEqual(state.originX);
      expect(visible.maxX).toBeLessThanOrEqual(state.originX + CAMERA_METATILE_BUFFER_DIM - 1);
      const rightEdgeWorldIds = state.slots
        .filter((slot) => slot.x === visible.maxX)
        .map((slot) => worldId(slot.x, slot.y));
      expect(rightEdgeWorldIds.length).toBeGreaterThan(0);
    }
  });
});

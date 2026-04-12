import { describe, expect, it } from 'vitest';

import {
  computeCameraViewportLayout,
  VIEWPORT_PLAYER_ANCHOR_TILE_X,
  VIEWPORT_VISIBLE_METATILE_COLUMNS,
  VIEWPORT_VISIBLE_METATILE_ROWS,
} from './cameraViewport';
import { CAMERA_METATILE_BUFFER_DIM } from './cameraTilemap';

describe('camera viewport masking', () => {
  it.each([
    { label: '720p', screenWidth: 1280, screenHeight: 720, renderScale: 4 },
    { label: '1080p', screenWidth: 1920, screenHeight: 1080, renderScale: 4 },
    { label: '1440p low scale', screenWidth: 2560, screenHeight: 1440, renderScale: 3 },
    { label: 'mobile-ish', screenWidth: 854, screenHeight: 480, renderScale: 2 },
  ])('keeps exactly 15x10 visible metatiles at $label', ({ screenWidth, screenHeight, renderScale }) => {
    const layout = computeCameraViewportLayout({
      screenWidth,
      screenHeight,
      tileSize: 16,
      renderScale,
    });

    expect(layout.visibleMetatileColumns).toBe(VIEWPORT_VISIBLE_METATILE_COLUMNS);
    expect(layout.visibleMetatileRows).toBe(VIEWPORT_VISIBLE_METATILE_ROWS);
  });

  it('keeps viewport tile counts deterministic even when HUD layout would vary', () => {
    const hudHeights = [0, 56, 128];
    for (const _hudHeight of hudHeights) {
      const layout = computeCameraViewportLayout({
        screenWidth: 1366,
        screenHeight: 768,
        tileSize: 16,
        renderScale: 4,
      });
      expect(layout.visibleMetatileColumns).toBe(15);
      expect(layout.visibleMetatileRows).toBe(10);
    }
  });
});

describe('camera window parity against viewport anchor', () => {
  it('keeps left/right entering slice preload symmetric for a 15-column viewport', () => {
    const playerTileX = 100;
    const cameraWindowOriginTileX = playerTileX - VIEWPORT_PLAYER_ANCHOR_TILE_X;
    const initialWindowMinX = cameraWindowOriginTileX;
    const initialWindowMaxX = initialWindowMinX + CAMERA_METATILE_BUFFER_DIM - 1;

    const rightPlayerTileX = playerTileX + 1;
    const rightOrigin = rightPlayerTileX - VIEWPORT_PLAYER_ANCHOR_TILE_X;
    const rightEnteringSliceX = rightOrigin + CAMERA_METATILE_BUFFER_DIM - 1;

    const leftPlayerTileX = playerTileX - 1;
    const leftOrigin = leftPlayerTileX - VIEWPORT_PLAYER_ANCHOR_TILE_X;
    const leftEnteringSliceX = leftOrigin;

    expect(cameraWindowOriginTileX).toBe(playerTileX - VIEWPORT_PLAYER_ANCHOR_TILE_X);
    expect(initialWindowMaxX - initialWindowMinX + 1).toBe(CAMERA_METATILE_BUFFER_DIM);
    expect(rightEnteringSliceX).toBe(initialWindowMaxX + 1);
    expect(leftEnteringSliceX).toBe(initialWindowMinX - 1);
    expect(rightEnteringSliceX - initialWindowMaxX).toBe(1);
    expect(initialWindowMinX - leftEnteringSliceX).toBe(1);
  });
});

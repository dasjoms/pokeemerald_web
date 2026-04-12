import { describe, expect, it } from 'vitest';

import {
  computeCameraViewportLayout,
  VIEWPORT_VISIBLE_METATILE_COLUMNS,
  VIEWPORT_VISIBLE_METATILE_ROWS,
} from './cameraViewport';

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


import { describe, expect, it } from 'vitest';

import { computeObjectDepth, ELEVATION_TO_SUBPRIORITY } from './objectDepth';

describe('computeObjectDepth', () => {
  it('matches ROM tile-row phase math for object path (+1 subpriority base)', () => {
    const depth = computeObjectDepth({
      screenY: 48,
      halfHeightPx: 8,
      elevation: 0,
      baseSubpriority: 1,
    });

    // (48 + 8 + 8) >> 4 = 4, so (16 - 4) * 2 = 24.
    expect(depth).toBe(24 + ELEVATION_TO_SUBPRIORITY[0] + 1);
  });

  it('uses the jump-impact base path (+0) and supports elevation offsets', () => {
    const depth = computeObjectDepth({
      screenY: 48,
      halfHeightPx: 8,
      elevation: 2,
      baseSubpriority: 0,
    });

    expect(depth).toBe(24 + ELEVATION_TO_SUBPRIORITY[2]);
  });

  it('wraps tile-row phase to 8-bit like ROM', () => {
    const depth = computeObjectDepth({
      screenY: 255,
      halfHeightPx: 8,
      elevation: 0,
      baseSubpriority: 1,
    });

    // (255 + 8 + 8) = 271 => 0x10f, low byte 0x0f, phase=0, component=32.
    expect(depth).toBe(32 + ELEVATION_TO_SUBPRIORITY[0] + 1);
  });
});

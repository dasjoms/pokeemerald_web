import { describe, expect, it } from 'vitest';

import { computeObjectDepth, ELEVATION_TO_SUBPRIORITY } from './objectDepth';

describe('computeObjectDepth', () => {
  it('matches ROM top-edge tile-row phase math for object path (+1 subpriority base)', () => {
    const depth = computeObjectDepth({
      screenY: 48,
      halfHeightPx: 8,
      elevation: 0,
      baseSubpriority: 1,
    });

    // (48 - 8 + 8) >> 4 = 3, so (16 - 3) * 2 = 26.
    expect(depth).toBe(26 + ELEVATION_TO_SUBPRIORITY[0] + 1);
  });

  it('uses the jump-impact base path (+0) and supports elevation offsets', () => {
    const depth = computeObjectDepth({
      screenY: 48,
      halfHeightPx: 8,
      elevation: 2,
      baseSubpriority: 0,
    });

    expect(depth).toBe(26 + ELEVATION_TO_SUBPRIORITY[2]);
  });

  it('wraps tile-row phase to 8-bit like ROM', () => {
    const depth = computeObjectDepth({
      screenY: 255,
      halfHeightPx: 8,
      elevation: 0,
      baseSubpriority: 1,
    });

    // (255 - 8) + 8 = 255 => 0xff, low byte 0xff, phase=15, component=2.
    expect(depth).toBe(2 + ELEVATION_TO_SUBPRIORITY[0] + 1);
  });
});

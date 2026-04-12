import { describe, expect, it } from 'vitest';
import {
  initFieldCameraParityFromTile,
  updateFieldCameraParity,
} from './fieldCameraParity';

describe('fieldCameraParity', () => {
  it('quantizes fractional render tile positions to integer camera pixels', () => {
    const state = initFieldCameraParityFromTile(10, 4);

    const result = updateFieldCameraParity(state, 10.25, 4.75);

    expect(Number.isInteger(result.state.cameraPxX)).toBe(true);
    expect(Number.isInteger(result.state.cameraPxY)).toBe(true);
    expect(result.state.cameraPxX).toBe(164);
    expect(result.state.cameraPxY).toBe(76);
  });

  it('emits no boundary events when there is no movement', () => {
    const state = initFieldCameraParityFromTile(5, 6);

    const result = updateFieldCameraParity(state, 5, 6);

    expect(result.pixelDeltaX).toBe(0);
    expect(result.pixelDeltaY).toBe(0);
    expect(result.boundaryEvents).toEqual([]);
    expect(result.state.xPixelOffset).toBe(state.xPixelOffset);
    expect(result.state.yPixelOffset).toBe(state.yPixelOffset);
    expect(result.state.xTileOffset).toBe(state.xTileOffset);
    expect(result.state.yTileOffset).toBe(state.yTileOffset);
  });

  it('emits a single eastward metatile crossing and advances xTileOffset by two', () => {
    const start = initFieldCameraParityFromTile(10, 2);

    const result = updateFieldCameraParity(start, 11, 2);

    expect(result.boundaryEvents).toEqual([{ kind: 'metatile-cross', dir: 'east', count: 1 }]);
    expect(result.state.xTileOffset).toBe(2);
    expect(result.state.anchorMetatileX).toBe(11);
  });

  it('emits a single westward metatile crossing and wraps xTileOffset', () => {
    const start = {
      ...initFieldCameraParityFromTile(10, 2),
      xTileOffset: 0,
    };

    const result = updateFieldCameraParity(start, 9, 2);

    expect(result.boundaryEvents).toEqual([{ kind: 'metatile-cross', dir: 'west', count: 1 }]);
    expect(result.state.xTileOffset).toBe(30);
    expect(result.state.anchorMetatileX).toBe(9);
  });

  it('emits a single northward metatile crossing and wraps yTileOffset', () => {
    const start = {
      ...initFieldCameraParityFromTile(4, 7),
      yTileOffset: 0,
    };

    const result = updateFieldCameraParity(start, 4, 6);

    expect(result.boundaryEvents).toEqual([{ kind: 'metatile-cross', dir: 'north', count: 1 }]);
    expect(result.state.yTileOffset).toBe(30);
    expect(result.state.anchorMetatileY).toBe(6);
  });

  it('emits a single southward metatile crossing and advances yTileOffset by two', () => {
    const start = initFieldCameraParityFromTile(4, 7);

    const result = updateFieldCameraParity(start, 4, 8);

    expect(result.boundaryEvents).toEqual([{ kind: 'metatile-cross', dir: 'south', count: 1 }]);
    expect(result.state.yTileOffset).toBe(2);
    expect(result.state.anchorMetatileY).toBe(8);
  });

  it('emits multi-cross events in one update with correct counts and final offsets', () => {
    const start = initFieldCameraParityFromTile(3, 3);

    const result = updateFieldCameraParity(start, 6, 1);

    expect(result.boundaryEvents).toEqual([
      { kind: 'metatile-cross', dir: 'east', count: 3 },
      { kind: 'metatile-cross', dir: 'north', count: 2 },
    ]);
    expect(result.state.xTileOffset).toBe(6);
    expect(result.state.yTileOffset).toBe(28);
    expect(result.state.anchorMetatileX).toBe(6);
    expect(result.state.anchorMetatileY).toBe(1);
  });

  it('emits a crossing event when cumulative per-frame motion passes a 16px boundary', () => {
    let state = initFieldCameraParityFromTile(10, 4);

    for (let i = 1; i <= 15; i += 1) {
      const partial = updateFieldCameraParity(state, 10 + i / 16, 4);
      expect(partial.boundaryEvents).toEqual([]);
      state = partial.state;
    }

    const crossing = updateFieldCameraParity(state, 11, 4);

    expect(crossing.boundaryEvents).toEqual([{ kind: 'metatile-cross', dir: 'east', count: 1 }]);
    expect(crossing.state.xTileOffset).toBe(2);
    expect(crossing.state.anchorMetatileX).toBe(11);
  });

  it('wraps tile offsets correctly at 0/31 boundaries', () => {
    const start = {
      ...initFieldCameraParityFromTile(8, 8),
      xTileOffset: 30,
      yTileOffset: 30,
    };

    const result = updateFieldCameraParity(start, 9, 9);

    expect(result.state.xTileOffset).toBe(0);
    expect(result.state.yTileOffset).toBe(0);
  });

  it('keeps modulo offsets non-negative for negative deltas', () => {
    const start = initFieldCameraParityFromTile(0, 0);

    const result = updateFieldCameraParity(start, -0.3, -0.1);

    expect(result.pixelDeltaX).toBe(-5);
    expect(result.pixelDeltaY).toBe(-2);
    expect(result.state.xPixelOffset).toBeGreaterThanOrEqual(0);
    expect(result.state.yPixelOffset).toBeGreaterThanOrEqual(0);
    expect(result.state.xPixelOffset).toBeLessThan(16);
    expect(result.state.yPixelOffset).toBeLessThan(16);
    expect(result.boundaryEvents).toEqual([
      { kind: 'metatile-cross', dir: 'west', count: 1 },
      { kind: 'metatile-cross', dir: 'north', count: 1 },
    ]);
  });
});

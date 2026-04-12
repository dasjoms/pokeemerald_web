import { describe, expect, it } from 'vitest';
import { OverworldWindowRenderer } from './overworldWindowRenderer';

type TestTile = { id: number };

describe('OverworldWindowRenderer slice redraws', () => {
  it('redraws only the entering east strip when advancing by one metatile', () => {
    const calls: { worldTileX: number; worldTileY: number; slotTileX: number; slotTileY: number }[] = [];
    const mapWidth = 96;
    const mapHeight = 96;
    const tiles = Array.from({ length: mapWidth * mapHeight }, (_, id) => ({ id }));
    const renderer = new OverworldWindowRenderer<TestTile>({
      tileSize: 16,
      renderSlot: ({ worldTileX, worldTileY, slotTileX, slotTileY }) => {
        calls.push({ worldTileX, worldTileY, slotTileX, slotTileY });
      },
    });

    renderer.initWindow(40, 40, { width: mapWidth, height: mapHeight, sampleTileAt: (x, y) => tiles[y * mapWidth + x] });
    renderer.commitScheduledTileWrites();
    calls.length = 0;

    renderer.redrawEdgeSlices(1, 0);
    renderer.commitScheduledTileWrites();

    expect(calls).toHaveLength(32);
    expect(new Set(calls.map((call) => call.worldTileX))).toEqual(new Set([72]));
    const ys = calls.map((call) => call.worldTileY).sort((a, b) => a - b);
    expect(ys[0]).toBe(40);
    expect(ys[31]).toBe(71);
    expect(new Set(calls.map((call) => call.slotTileX))).toEqual(new Set([0]));
    expect(new Set(calls.map((call) => call.slotTileY))).toEqual(
      new Set(Array.from({ length: 32 }, (_, index) => index)),
    );
  });

  it('supports diagonal movement via two ROM-style entering strips', () => {
    const calls: { worldTileX: number; worldTileY: number; slotTileX: number; slotTileY: number }[] = [];
    const mapWidth = 96;
    const mapHeight = 96;
    const tiles = Array.from({ length: mapWidth * mapHeight }, (_, id) => ({ id }));
    const renderer = new OverworldWindowRenderer<TestTile>({
      tileSize: 16,
      renderSlot: ({ worldTileX, worldTileY, slotTileX, slotTileY }) => {
        calls.push({ worldTileX, worldTileY, slotTileX, slotTileY });
      },
    });

    renderer.initWindow(40, 40, { width: mapWidth, height: mapHeight, sampleTileAt: (x, y) => tiles[y * mapWidth + x] });
    renderer.commitScheduledTileWrites();
    calls.length = 0;

    renderer.redrawEdgeSlices(1, 1);
    renderer.commitScheduledTileWrites();

    expect(calls).toHaveLength(63);
    const eastSliceUniqueYs = new Set(
      calls.filter((call) => call.worldTileX === 72).map((call) => call.worldTileY),
    );
    const southSliceUniqueXs = new Set(
      calls.filter((call) => call.worldTileY === 72).map((call) => call.worldTileX),
    );
    expect(eastSliceUniqueYs.size).toBe(32);
    expect(southSliceUniqueXs.size).toBe(32);
    expect(
      calls
        .filter((call) => call.worldTileX === 72)
        .every((call) => call.slotTileX === 0),
    ).toBe(true);
    expect(
      calls
        .filter((call) => call.worldTileY === 72)
        .every((call) => call.slotTileY === 0),
    ).toBe(true);
  });
});

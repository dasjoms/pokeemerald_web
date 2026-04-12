import { describe, expect, it } from 'vitest';
import { OverworldWindowRenderer } from './overworldWindowRenderer';

type TestTile = { id: number };

describe('OverworldWindowRenderer slice redraws', () => {
  it('redraws only the entering east strip when advancing by one metatile', () => {
    const calls: { worldTileX: number; worldTileY: number }[] = [];
    const mapWidth = 96;
    const mapHeight = 96;
    const tiles = Array.from({ length: mapWidth * mapHeight }, (_, id) => ({ id }));
    const renderer = new OverworldWindowRenderer<TestTile>({
      tileSize: 16,
      renderSlot: ({ worldTileX, worldTileY }) => {
        calls.push({ worldTileX, worldTileY });
      },
    });

    renderer.initWindow(40, 40, { width: mapWidth, height: mapHeight, sampleTileAt: (x, y) => tiles[y * mapWidth + x] });
    renderer.commitScheduledTileWrites();
    calls.length = 0;

    renderer.redrawEdgeSlices(1, 0);
    renderer.commitScheduledTileWrites();

    expect(calls).toHaveLength(32);
    expect(new Set(calls.map((call) => call.worldTileX))).toEqual(new Set([56]));
    const ys = calls.map((call) => call.worldTileY).sort((a, b) => a - b);
    expect(ys[0]).toBe(24);
    expect(ys[31]).toBe(55);
  });

  it('supports diagonal movement via two ROM-style entering strips', () => {
    const calls: { worldTileX: number; worldTileY: number }[] = [];
    const mapWidth = 96;
    const mapHeight = 96;
    const tiles = Array.from({ length: mapWidth * mapHeight }, (_, id) => ({ id }));
    const renderer = new OverworldWindowRenderer<TestTile>({
      tileSize: 16,
      renderSlot: ({ worldTileX, worldTileY }) => {
        calls.push({ worldTileX, worldTileY });
      },
    });

    renderer.initWindow(40, 40, { width: mapWidth, height: mapHeight, sampleTileAt: (x, y) => tiles[y * mapWidth + x] });
    renderer.commitScheduledTileWrites();
    calls.length = 0;

    renderer.redrawEdgeSlices(1, 1);
    renderer.commitScheduledTileWrites();

    expect(calls).toHaveLength(63);
    const eastSliceUniqueYs = new Set(
      calls.filter((call) => call.worldTileX === 56).map((call) => call.worldTileY),
    );
    const southSliceUniqueXs = new Set(
      calls.filter((call) => call.worldTileY === 56).map((call) => call.worldTileX),
    );
    expect(eastSliceUniqueYs.size).toBe(32);
    expect(southSliceUniqueXs.size).toBe(32);
  });
});

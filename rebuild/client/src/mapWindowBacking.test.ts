import { describe, expect, it } from 'vitest';
import { MAP_OFFSET, createMapWindowBacking } from './mapWindowBacking';

type TestTile = { id: number };

describe('mapWindowBacking', () => {
  it('returns core map tiles when sampling within map bounds', () => {
    const tiles: TestTile[] = [
      { id: 11 },
      { id: 12 },
      { id: 13 },
      { id: 14 },
    ];
    const backing = createMapWindowBacking({
      chunk: {
        width: 2,
        height: 2,
        tiles,
      },
      borderTiles: [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }],
    });

    expect(backing.sampleTileAt(0, 0)?.id).toBe(11);
    expect(backing.sampleTileAt(1, 0)?.id).toBe(12);
    expect(backing.sampleTileAt(0, 1)?.id).toBe(13);
    expect(backing.sampleTileAt(1, 1)?.id).toBe(14);
  });

  it('uses 2x2 border fallback for out-of-bounds sampling using MAP_OFFSET parity', () => {
    const borderTiles: TestTile[] = [{ id: 101 }, { id: 102 }, { id: 103 }, { id: 104 }];
    const backing = createMapWindowBacking({
      chunk: {
        width: 1,
        height: 1,
        tiles: [{ id: 7 }],
      },
      borderTiles,
    });

    expect(backing.sampleTileAt(-MAP_OFFSET, -MAP_OFFSET)?.id).toBe(101);
    expect(backing.sampleTileAt(1 - MAP_OFFSET, -MAP_OFFSET)?.id).toBe(102);
    expect(backing.sampleTileAt(-MAP_OFFSET, 1 - MAP_OFFSET)?.id).toBe(103);
    expect(backing.sampleTileAt(1 - MAP_OFFSET, 1 - MAP_OFFSET)?.id).toBe(104);
  });
});

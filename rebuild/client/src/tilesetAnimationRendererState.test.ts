import { describe, expect, it } from 'vitest';

import { applyCopyTilesOpsToActiveSwaps, type CopyTilesOpLike } from './tilesetAnimationRendererState';

function asCopyMap(ops: CopyTilesOpLike[]): Map<string, CopyTilesOpLike> {
  const mapped = new Map<string, CopyTilesOpLike>();
  for (const op of ops) {
    mapped.set(`${op.pageId}:${op.destLocalTileIndex}`, op);
  }
  return mapped;
}

describe('applyCopyTilesOpsToActiveSwaps', () => {
  it('persists previous rendered tile swaps when tick has sparse updates', () => {
    const activeTileSwaps = new Map<string, { sourcePayloadTileIndex: number }>();

    applyCopyTilesOpsToActiveSwaps(
      asCopyMap([
        { pageId: 0, destLocalTileIndex: 508, sourcePayloadOffsetTiles: 509, tileCount: 1 },
      ]),
      activeTileSwaps,
    );

    applyCopyTilesOpsToActiveSwaps(new Map(), activeTileSwaps);

    expect(activeTileSwaps.get('0:508')?.sourcePayloadTileIndex).toBe(509);
  });

  it('marks dirty keys only when effective source tile changes', () => {
    const activeTileSwaps = new Map<string, { sourcePayloadTileIndex: number }>([
      ['1:384', { sourcePayloadTileIndex: 385 }],
      ['1:388', { sourcePayloadTileIndex: 388 }],
      ['1:448', { sourcePayloadTileIndex: 449 }],
    ]);

    const dirty = applyCopyTilesOpsToActiveSwaps(
      asCopyMap([
        { pageId: 1, destLocalTileIndex: 384, sourcePayloadOffsetTiles: 385, tileCount: 1 },
        { pageId: 1, destLocalTileIndex: 388, sourcePayloadOffsetTiles: 389, tileCount: 1 },
      ]),
      activeTileSwaps,
    );

    expect([...dirty].sort()).toEqual(['1:388']);
    expect(activeTileSwaps.get('1:384')?.sourcePayloadTileIndex).toBe(385);
    expect(activeTileSwaps.get('1:388')?.sourcePayloadTileIndex).toBe(389);
    expect(activeTileSwaps.get('1:448')?.sourcePayloadTileIndex).toBe(449);
  });
});

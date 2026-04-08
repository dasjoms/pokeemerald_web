export type CopyTilesOpLike = {
  pageId: number;
  destLocalTileIndex: number;
  sourceLocalTileIndex: number;
  tileCount: number;
};

export function applyCopyTilesOpsToActiveSwaps(
  nextTileSwaps: Map<string, CopyTilesOpLike>,
  activeTileSwaps: Map<string, number>,
): Set<string> {
  const dirtyTileKeys = new Set<string>();
  const nextExpandedTileSwaps = new Map<string, number>();

  for (const op of nextTileSwaps.values()) {
    for (let offset = 0; offset < op.tileCount; offset += 1) {
      const destLocalTileIndex = op.destLocalTileIndex + offset;
      const sourceLocalTileIndex = op.sourceLocalTileIndex + offset;
      nextExpandedTileSwaps.set(`${op.pageId}:${destLocalTileIndex}`, sourceLocalTileIndex);
    }
  }

  for (const [tileKey, nextSourceLocalTileIndex] of nextExpandedTileSwaps.entries()) {
    if (activeTileSwaps.get(tileKey) !== nextSourceLocalTileIndex) {
      dirtyTileKeys.add(tileKey);
    }
    activeTileSwaps.set(tileKey, nextSourceLocalTileIndex);
  }

  return dirtyTileKeys;
}

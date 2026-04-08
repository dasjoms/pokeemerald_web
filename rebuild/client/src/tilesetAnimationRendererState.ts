export type CopyTilesOpLike = {
  pageId: number;
  destLocalTileIndex: number;
  sourcePayloadOffsetTiles: number;
  tileCount: number;
};

export type ActiveTileSwapSource = {
  sourcePayloadTileIndex: number;
};

export function applyCopyTilesOpsToActiveSwaps(
  nextTileSwaps: Map<string, CopyTilesOpLike>,
  activeTileSwaps: Map<string, ActiveTileSwapSource>,
): Set<string> {
  const dirtyTileKeys = new Set<string>();
  const nextExpandedTileSwaps = new Map<string, ActiveTileSwapSource>();

  for (const op of nextTileSwaps.values()) {
    for (let offset = 0; offset < op.tileCount; offset += 1) {
      const destLocalTileIndex = op.destLocalTileIndex + offset;
      const sourcePayloadTileIndex = op.sourcePayloadOffsetTiles + offset;
      nextExpandedTileSwaps.set(`${op.pageId}:${destLocalTileIndex}`, { sourcePayloadTileIndex });
    }
  }

  for (const [tileKey, nextSource] of nextExpandedTileSwaps.entries()) {
    if (activeTileSwaps.get(tileKey)?.sourcePayloadTileIndex !== nextSource.sourcePayloadTileIndex) {
      dirtyTileKeys.add(tileKey);
    }
    activeTileSwaps.set(tileKey, nextSource);
  }

  return dirtyTileKeys;
}

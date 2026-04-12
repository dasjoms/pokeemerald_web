export const MAP_OFFSET = 7;

const BORDER_WIDTH = 2;
const BORDER_HEIGHT = 2;

export type MapWindowBackingTile = {
  metatile_id: number;
  collision: number;
  behavior_id: number;
};

export type MapWindowBackingChunk<TTile> = {
  width: number;
  height: number;
  tiles: TTile[];
};

export type MapWindowBackingOptions<TTile> = {
  chunk: MapWindowBackingChunk<TTile>;
  borderTiles?: TTile[];
};

export type MapWindowBacking<TTile> = {
  width: number;
  height: number;
  mapOffset: number;
  sampleMinX: number;
  sampleMinY: number;
  sampleMaxX: number;
  sampleMaxY: number;
  sampleTileAt: (worldTileX: number, worldTileY: number) => TTile | undefined;
};

export function createMapWindowBacking<TTile>(options: MapWindowBackingOptions<TTile>): MapWindowBacking<TTile> {
  const { chunk, borderTiles } = options;
  const sampleMinX = -MAP_OFFSET;
  const sampleMinY = -MAP_OFFSET;
  const sampleMaxX = chunk.width + MAP_OFFSET - 1;
  const sampleMaxY = chunk.height + MAP_OFFSET - 1;

  const effectiveBorderTiles = borderTiles?.length ? borderTiles : undefined;

  const sampleTileAt = (worldTileX: number, worldTileY: number): TTile | undefined => {
    if (worldTileX >= 0 && worldTileY >= 0 && worldTileX < chunk.width && worldTileY < chunk.height) {
      return chunk.tiles[worldTileY * chunk.width + worldTileX];
    }

    if (!effectiveBorderTiles) {
      return undefined;
    }

    const borderTileX = mod(worldTileX + MAP_OFFSET, BORDER_WIDTH);
    const borderTileY = mod(worldTileY + MAP_OFFSET, BORDER_HEIGHT);
    const borderIndex = borderTileY * BORDER_WIDTH + borderTileX;
    return effectiveBorderTiles[borderIndex] ?? effectiveBorderTiles[0];
  };

  return {
    width: chunk.width,
    height: chunk.height,
    mapOffset: MAP_OFFSET,
    sampleMinX,
    sampleMinY,
    sampleMaxX,
    sampleMaxY,
    sampleTileAt,
  };
}

function mod(value: number, divisor: number): number {
  return ((value % divisor) + divisor) % divisor;
}

export type WindowMapData<TTile> = {
  width: number;
  height: number;
  sampleTileAt: (worldTileX: number, worldTileY: number) => TTile | undefined;
};

type WindowRenderSlotArgs<TTile> = {
  slotIndex: number;
  slotTileX: number;
  slotTileY: number;
  worldTileX: number;
  worldTileY: number;
  tile: TTile | undefined;
};

type OverworldWindowRendererOptions<TTile> = {
  tileSize: number;
  renderSlot: (args: WindowRenderSlotArgs<TTile>) => void;
};

const WINDOW_SIZE_TILES = 32;

function mod32(value: number): number {
  return value & (WINDOW_SIZE_TILES - 1);
}

export class OverworldWindowRenderer<TTile> {
  private readonly tileSize: number;
  private readonly renderSlot: (args: WindowRenderSlotArgs<TTile>) => void;
  private cameraPosTileX = 0;
  private cameraPosTileY = 0;
  private xTileOffset = 0;
  private yTileOffset = 0;
  private mapData: WindowMapData<TTile> | null = null;

  // BG-equivalent 32x32 rolling buffers in metatile units.
  private readonly bg1Buffer = new Array<number>(WINDOW_SIZE_TILES * WINDOW_SIZE_TILES).fill(-1);
  private readonly bg2Buffer = new Array<number>(WINDOW_SIZE_TILES * WINDOW_SIZE_TILES).fill(-1);
  private readonly bg3Buffer = new Array<number>(WINDOW_SIZE_TILES * WINDOW_SIZE_TILES).fill(-1);
  private readonly pendingSlotWrites = new Map<number, WindowRenderSlotArgs<TTile>>();

  constructor(options: OverworldWindowRendererOptions<TTile>) {
    this.tileSize = options.tileSize;
    this.renderSlot = options.renderSlot;
  }

  initWindow(cameraPosTileX: number, cameraPosTileY: number, mapData: WindowMapData<TTile>): void {
    this.cameraPosTileX = cameraPosTileX;
    this.cameraPosTileY = cameraPosTileY;
    this.xTileOffset = 0;
    this.yTileOffset = 0;
    this.mapData = mapData;
    this.redrawWholeWindow();
  }

  redrawWholeWindow(): void {
    if (!this.mapData) {
      return;
    }
    const minTileX = this.cameraPosTileX;
    const minTileY = this.cameraPosTileY;
    for (let localY = 0; localY < WINDOW_SIZE_TILES; localY += 1) {
      for (let localX = 0; localX < WINDOW_SIZE_TILES; localX += 1) {
        const worldTileX = minTileX + localX;
        const worldTileY = minTileY + localY;
        this.drawWorldTile(worldTileX, worldTileY);
      }
    }
  }

  applyWindowScroll(pixelX: number, pixelY: number): { x: number; y: number } {
    const windowSizePx = WINDOW_SIZE_TILES * this.tileSize;
    const wrappedX = ((pixelX % windowSizePx) + windowSizePx) % windowSizePx;
    const wrappedY = ((pixelY % windowSizePx) + windowSizePx) % windowSizePx;
    return {
      x: -wrappedX,
      y: -wrappedY,
    };
  }

  redrawEdgeSlices(deltaTileX: number, deltaTileY: number): void {
    if (!this.mapData) {
      return;
    }

    const clampedDeltaX = Math.max(-WINDOW_SIZE_TILES, Math.min(WINDOW_SIZE_TILES, deltaTileX));
    const clampedDeltaY = Math.max(-WINDOW_SIZE_TILES, Math.min(WINDOW_SIZE_TILES, deltaTileY));
    if (clampedDeltaX === 0 && clampedDeltaY === 0) {
      return;
    }

    if (Math.abs(clampedDeltaX) >= WINDOW_SIZE_TILES || Math.abs(clampedDeltaY) >= WINDOW_SIZE_TILES) {
      this.cameraPosTileX += clampedDeltaX;
      this.cameraPosTileY += clampedDeltaY;
      this.xTileOffset = 0;
      this.yTileOffset = 0;
      this.redrawWholeWindow();
      return;
    }

    if (clampedDeltaX > 0) {
      for (let step = 0; step < clampedDeltaX; step += 1) {
        this.cameraPosTileX += 1;
        this.xTileOffset = mod32(this.xTileOffset + 1);
        this.redrawSliceEast();
      }
    } else if (clampedDeltaX < 0) {
      for (let step = 0; step < -clampedDeltaX; step += 1) {
        this.cameraPosTileX -= 1;
        this.xTileOffset = mod32(this.xTileOffset - 1);
        this.redrawSliceWest();
      }
    }

    if (clampedDeltaY > 0) {
      for (let step = 0; step < clampedDeltaY; step += 1) {
        this.cameraPosTileY += 1;
        this.yTileOffset = mod32(this.yTileOffset + 1);
        this.redrawSliceSouth();
      }
    } else if (clampedDeltaY < 0) {
      for (let step = 0; step < -clampedDeltaY; step += 1) {
        this.cameraPosTileY -= 1;
        this.yTileOffset = mod32(this.yTileOffset - 1);
        this.redrawSliceNorth();
      }
    }
  }

  redrawSliceNorth(): void {
    const minTileX = this.cameraPosTileX;
    const maxTileX = minTileX + WINDOW_SIZE_TILES - 1;
    const enteringTileY = this.cameraPosTileY;
    for (let worldTileX = minTileX; worldTileX <= maxTileX; worldTileX += 1) {
      this.drawWorldTile(worldTileX, enteringTileY);
    }
  }

  redrawSliceSouth(): void {
    const minTileX = this.cameraPosTileX;
    const maxTileX = minTileX + WINDOW_SIZE_TILES - 1;
    const enteringTileY = this.cameraPosTileY + WINDOW_SIZE_TILES - 1;
    for (let worldTileX = minTileX; worldTileX <= maxTileX; worldTileX += 1) {
      this.drawWorldTile(worldTileX, enteringTileY);
    }
  }

  redrawSliceEast(): void {
    const minTileY = this.cameraPosTileY;
    const maxTileY = minTileY + WINDOW_SIZE_TILES - 1;
    const enteringTileX = this.cameraPosTileX + WINDOW_SIZE_TILES - 1;
    for (let worldTileY = minTileY; worldTileY <= maxTileY; worldTileY += 1) {
      this.drawWorldTile(enteringTileX, worldTileY);
    }
  }

  redrawSliceWest(): void {
    const minTileY = this.cameraPosTileY;
    const maxTileY = minTileY + WINDOW_SIZE_TILES - 1;
    const enteringTileX = this.cameraPosTileX;
    for (let worldTileY = minTileY; worldTileY <= maxTileY; worldTileY += 1) {
      this.drawWorldTile(enteringTileX, worldTileY);
    }
  }

  redrawWorldTileAt(worldTileX: number, worldTileY: number): void {
    this.drawWorldTile(worldTileX, worldTileY);
  }

  commitScheduledTileWrites(): void {
    if (this.pendingSlotWrites.size === 0) {
      return;
    }

    const orderedSlotIndices = [...this.pendingSlotWrites.keys()].sort((a, b) => a - b);
    for (const slotIndex of orderedSlotIndices) {
      const write = this.pendingSlotWrites.get(slotIndex);
      if (write) {
        this.renderSlot(write);
      }
    }
    this.pendingSlotWrites.clear();
  }

  private drawWorldTile(worldTileX: number, worldTileY: number): void {
    if (!this.mapData) {
      return;
    }

    const localTileX = worldTileX - this.cameraPosTileX;
    const localTileY = worldTileY - this.cameraPosTileY;
    const slotTileX = mod32(localTileX + this.xTileOffset);
    const slotTileY = mod32(localTileY + this.yTileOffset);
    const slotIndex = mapPosToBgTilemapOffset(slotTileX, slotTileY);

    const tile = this.mapData.sampleTileAt(worldTileX, worldTileY);

    const tileToken = tile ? worldTileY * this.mapData.width + worldTileX : -1;
    this.bg1Buffer[slotIndex] = tileToken;
    this.bg2Buffer[slotIndex] = tileToken;
    this.bg3Buffer[slotIndex] = tileToken;

    this.pendingSlotWrites.set(slotIndex, {
      slotIndex,
      slotTileX,
      slotTileY,
      worldTileX,
      worldTileY,
      tile,
    });
  }
}

export function mapPosToBgTilemapOffset(tileX: number, tileY: number): number {
  return (mod32(tileY) << 5) | mod32(tileX);
}

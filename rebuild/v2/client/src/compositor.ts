import { Container, SCALE_MODES, Sprite, Texture } from "pixi.js";
import type { RenderStateV1Message, RenderSubtile } from "./protocol";
import { wheelIndex, WHEEL_SIZE } from "./tileWheel32";
import { TilesetTextureResolver } from "./assetLoader";

const TILE_SIZE = 8;
const METATILE_SIZE = 2;
const NORMAL_BOTTOM_FILL_TILE_INDEX = 0x14;
const NORMAL_BOTTOM_FILL_PALETTE_INDEX = 3;

export class OverworldCompositor {
  readonly root = new Container();

  private readonly bgBottom = new Container();
  private readonly bgMiddle = new Container();
  private readonly bgTop = new Container();
  private readonly bottomSprites: Sprite[] = [];
  private readonly middleSprites: Sprite[] = [];
  private readonly topSprites: Sprite[] = [];
  private resolver: TilesetTextureResolver | null = null;
  private loadedPairId: string | null = null;

  constructor() {
    this.root.addChild(this.bgBottom, this.bgMiddle, this.bgTop);
    this.seedLayer(this.bgBottom, this.bottomSprites);
    this.seedLayer(this.bgMiddle, this.middleSprites);
    this.seedLayer(this.bgTop, this.topSprites);
    this.root.position.set(64, 64);
  }

  async fullRedraw(message: RenderStateV1Message, assetRoot: string): Promise<void> {
    if (!this.resolver || this.loadedPairId !== message.tilesetPairId) {
      try {
        this.resolver = await TilesetTextureResolver.create(assetRoot, message.tilesetPairId);
        this.loadedPairId = message.tilesetPairId;
      } catch (error) {
        this.resolver = null;
        this.loadedPairId = null;
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(
          `Failed loading tileset assets for pair "${message.tilesetPairId}" from asset root "${assetRoot}": ${reason}`,
          { cause: error }
        );
      }
    }

    this.clearLayers();

    const width = message.window.width;
    const height = message.window.height;

    for (let my = 0; my < height; my += 1) {
      for (let mx = 0; mx < width; mx += 1) {
        const metatile = message.metatiles[mx + my * width];
        if (!metatile || metatile.subtiles.length < 8) {
          continue;
        }

        const subtileX = mx * METATILE_SIZE;
        const subtileY = my * METATILE_SIZE;
        this.drawMetatile(subtileX, subtileY, metatile.layerType, metatile.subtiles);
      }
    }
  }

  private drawMetatile(subtileX: number, subtileY: number, layerType: number, subtiles: RenderSubtile[]): void {
    const bottom = subtiles.slice(0, 4);
    const top = subtiles.slice(4, 8);

    switch (layerType) {
      case 2: // SPLIT
        this.paintLayer(this.bottomSprites, subtileX, subtileY, bottom);
        this.paintTransparent(this.middleSprites, subtileX, subtileY);
        this.paintLayer(this.topSprites, subtileX, subtileY, top);
        break;
      case 1: // COVERED
        this.paintLayer(this.bottomSprites, subtileX, subtileY, bottom);
        this.paintLayer(this.middleSprites, subtileX, subtileY, top);
        this.paintTransparent(this.topSprites, subtileX, subtileY);
        break;
      case 0: // NORMAL
      default:
        this.paintBottomFiller(this.bottomSprites, subtileX, subtileY);
        this.paintLayer(this.middleSprites, subtileX, subtileY, bottom);
        this.paintLayer(this.topSprites, subtileX, subtileY, top);
        break;
    }
  }

  private paintBottomFiller(layer: Sprite[], baseX: number, baseY: number): void {
    for (let i = 0; i < 4; i += 1) {
      const dx = i % 2;
      const dy = Math.floor(i / 2);
      const idx = wheelIndex(baseX + dx, baseY + dy);
      const sprite = layer[idx];
      sprite.texture = this.tileTexture(NORMAL_BOTTOM_FILL_TILE_INDEX);
      sprite.tint = this.tileTint(NORMAL_BOTTOM_FILL_TILE_INDEX, NORMAL_BOTTOM_FILL_PALETTE_INDEX);
      sprite.visible = true;
      sprite.scale.set(1, 1);
      sprite.anchor.set(0, 0);
    }
  }

  private paintLayer(layer: Sprite[], baseX: number, baseY: number, quad: RenderSubtile[]): void {
    for (let i = 0; i < 4; i += 1) {
      const dx = i % 2;
      const dy = Math.floor(i / 2);
      const subtile = quad[i];
      if (!subtile) {
        continue;
      }
      const idx = wheelIndex(baseX + dx, baseY + dy);
      const sprite = layer[idx];
      sprite.texture = this.tileTexture(subtile.tileIndex);
      sprite.tint = this.tileTint(subtile.tileIndex, subtile.paletteIndex);
      sprite.visible = true;
      sprite.scale.set(subtile.hflip ? -1 : 1, subtile.vflip ? -1 : 1);
      sprite.anchor.set(subtile.hflip ? 1 : 0, subtile.vflip ? 1 : 0);
    }
  }

  private paintTransparent(layer: Sprite[], baseX: number, baseY: number): void {
    for (let i = 0; i < 4; i += 1) {
      const dx = i % 2;
      const dy = Math.floor(i / 2);
      const idx = wheelIndex(baseX + dx, baseY + dy);
      layer[idx].visible = false;
    }
  }

  private tileTexture(tileIndex: number): Texture {
    const texture = this.resolver?.textureForTile(tileIndex) ?? Texture.WHITE;
    texture.source.scaleMode = SCALE_MODES.NEAREST;
    return texture;
  }

  private tileTint(tileIndex: number, paletteIndex: number): number {
    if (this.resolver) {
      return 0xffffff;
    }
    const r = (tileIndex * 37 + paletteIndex * 17) & 0xff;
    const g = (tileIndex * 53 + paletteIndex * 29) & 0xff;
    const b = (tileIndex * 71 + paletteIndex * 13) & 0xff;
    return (r << 16) | (g << 8) | b;
  }

  private clearLayers(): void {
    for (const sprite of [...this.bottomSprites, ...this.middleSprites, ...this.topSprites]) {
      sprite.visible = false;
    }
  }

  private seedLayer(container: Container, target: Sprite[]): void {
    for (let y = 0; y < WHEEL_SIZE; y += 1) {
      for (let x = 0; x < WHEEL_SIZE; x += 1) {
        const sprite = new Sprite(Texture.WHITE);
        sprite.width = TILE_SIZE;
        sprite.height = TILE_SIZE;
        sprite.x = x * TILE_SIZE;
        sprite.y = y * TILE_SIZE;
        sprite.visible = false;
        container.addChild(sprite);
        target.push(sprite);
      }
    }
  }
}

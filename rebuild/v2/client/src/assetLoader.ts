import { Assets, Rectangle, Texture } from "pixi.js";

export type AtlasPage = {
  page: number;
  source_tileset: string;
  path: string;
  logical_tile_count: number;
};

type AtlasJson = {
  pages: AtlasPage[];
};

type TilePage = {
  startTile: number;
  endTile: number;
  texture: Texture;
  tilesPerRow: number;
};

export class TilesetTextureResolver {
  private readonly pages: TilePage[];

  private constructor(pages: TilePage[]) {
    this.pages = pages;
  }

  static async create(assetRoot: string, tilesetPairId: string): Promise<TilesetTextureResolver> {
    const atlasUrl = `/${assetRoot}/render/${tilesetPairId}/atlas.json`;
    const atlasResponse = await fetch(atlasUrl);
    if (!atlasResponse.ok) {
      throw new Error(`Failed to load atlas json: ${atlasUrl}`);
    }

    const atlas = (await atlasResponse.json()) as AtlasJson;
    const pages: TilePage[] = [];
    let runningStart = 0;

    for (const page of atlas.pages) {
      const texture = await Assets.load<Texture>(`/${assetRoot}/${page.path}`);
      const tilesPerRow = Math.max(1, Math.floor(texture.width / 8));
      const startTile = runningStart;
      const endTile = runningStart + page.logical_tile_count;
      pages.push({
        startTile,
        endTile,
        texture,
        tilesPerRow,
      });
      runningStart = endTile;
    }

    return new TilesetTextureResolver(pages);
  }

  textureForTile(tileIndex: number): Texture {
    const page = this.pages.find((candidate) => tileIndex >= candidate.startTile && tileIndex < candidate.endTile);
    if (!page) {
      return Texture.WHITE;
    }

    const localTile = tileIndex - page.startTile;
    const srcX = (localTile % page.tilesPerRow) * 8;
    const srcY = Math.floor(localTile / page.tilesPerRow) * 8;
    return new Texture({
      source: page.texture.source,
      frame: new Rectangle(srcX, srcY, 8, 8),
    });
  }
}

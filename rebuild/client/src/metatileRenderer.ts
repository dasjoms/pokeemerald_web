import { Texture } from 'pixi.js';

const SUBTILE_SIZE = 8;

type PaletteColor = number[];

export type IndexedAtlasPage = {
  width: number;
  height: number;
  tileCount: number;
  tileIndices: Uint8Array;
};

export type IndexedAtlasPages = Map<number, IndexedAtlasPage>;

async function inflateZlib(payload: Uint8Array): Promise<Uint8Array> {
  const stream = new DecompressionStream('deflate');
  const buffer = payload.buffer.slice(
    payload.byteOffset,
    payload.byteOffset + payload.byteLength,
  ) as ArrayBuffer;
  const decompressed = await new Response(new Blob([buffer]).stream().pipeThrough(stream)).arrayBuffer();
  return new Uint8Array(decompressed);
}

function readU32Be(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset] << 24) |
    (bytes[offset + 1] << 16) |
    (bytes[offset + 2] << 8) |
    bytes[offset + 3]
  ) >>> 0;
}

function paethPredictor(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) {
    return a;
  }
  if (pb <= pc) {
    return b;
  }
  return c;
}

function unfilterScanline(filterType: number, row: Uint8Array, prevRow: Uint8Array): void {
  if (filterType === 0) {
    return;
  }

  for (let x = 0; x < row.length; x += 1) {
    const left = x > 0 ? row[x - 1] : 0;
    const up = prevRow[x] ?? 0;
    const upLeft = x > 0 ? prevRow[x - 1] ?? 0 : 0;

    switch (filterType) {
      case 1:
        row[x] = (row[x] + left) & 0xff;
        break;
      case 2:
        row[x] = (row[x] + up) & 0xff;
        break;
      case 3:
        row[x] = (row[x] + Math.floor((left + up) / 2)) & 0xff;
        break;
      case 4:
        row[x] = (row[x] + paethPredictor(left, up, upLeft)) & 0xff;
        break;
      default:
        throw new Error(`Unsupported PNG filter type ${filterType}`);
    }
  }
}

function unpackIndexed4bppScanline(scanline: Uint8Array, out: Uint8Array, outOffset: number, width: number): void {
  for (let x = 0; x < width; x += 1) {
    const packed = scanline[x >> 1] ?? 0;
    out[outOffset + x] = (x & 1) === 0 ? (packed >> 4) & 0x0f : packed & 0x0f;
  }
}

export async function decodeIndexed4bppPngFromUrl(url: string, logicalTileCount: number): Promise<IndexedAtlasPage> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to load atlas png (${response.status}) from ${url}`);
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  const signature = bytes.subarray(0, 8);
  const pngSignature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (!pngSignature.every((value, index) => signature[index] === value)) {
    throw new Error('Invalid PNG signature');
  }

  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlaceMethod = 0;
  const idatChunks: Uint8Array[] = [];

  let offset = 8;
  while (offset + 8 <= bytes.length) {
    const length = readU32Be(bytes, offset);
    offset += 4;
    const chunkType = String.fromCharCode(
      bytes[offset],
      bytes[offset + 1],
      bytes[offset + 2],
      bytes[offset + 3],
    );
    offset += 4;
    const chunkData = bytes.subarray(offset, offset + length);
    offset += length;
    offset += 4;

    if (chunkType === 'IHDR') {
      width = readU32Be(chunkData, 0);
      height = readU32Be(chunkData, 4);
      bitDepth = chunkData[8] ?? 0;
      colorType = chunkData[9] ?? 0;
      interlaceMethod = chunkData[12] ?? 0;
      continue;
    }

    if (chunkType === 'IDAT') {
      idatChunks.push(chunkData);
      continue;
    }

    if (chunkType === 'IEND') {
      break;
    }
  }

  if (width === 0 || height === 0) {
    throw new Error('Missing PNG dimensions');
  }

  if (bitDepth !== 4 || colorType !== 3) {
    throw new Error(`Unsupported atlas PNG format (bitDepth=${bitDepth}, colorType=${colorType})`);
  }

  if (interlaceMethod !== 0) {
    throw new Error('Interlaced indexed PNG atlases are not supported');
  }

  const compressedLength = idatChunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const compressed = new Uint8Array(compressedLength);
  let cursor = 0;
  for (const chunk of idatChunks) {
    compressed.set(chunk, cursor);
    cursor += chunk.length;
  }

  const scanlineBytes = Math.ceil(width / 2);
  const inflated = await inflateZlib(compressed);
  const expectedInflatedLength = height * (1 + scanlineBytes);
  if (inflated.length !== expectedInflatedLength) {
    throw new Error(
      `Unexpected inflated atlas size: expected=${expectedInflatedLength}, actual=${inflated.length}`,
    );
  }

  const indices = new Uint8Array(width * height);
  const prev = new Uint8Array(scanlineBytes);
  const row = new Uint8Array(scanlineBytes);

  for (let y = 0; y < height; y += 1) {
    const scanlineOffset = y * (1 + scanlineBytes);
    const filterType = inflated[scanlineOffset] ?? 0;
    row.set(inflated.subarray(scanlineOffset + 1, scanlineOffset + 1 + scanlineBytes));
    unfilterScanline(filterType, row, prev);
    unpackIndexed4bppScanline(row, indices, y * width, width);
    prev.set(row);
  }

  const widthInTiles = Math.floor(width / SUBTILE_SIZE);
  const heightInTiles = Math.floor(height / SUBTILE_SIZE);
  const maxTileCount = widthInTiles * heightInTiles;

  return {
    width,
    height,
    tileCount: Math.min(logicalTileCount, maxTileCount),
    tileIndices: indices,
  };
}

function makePaletteTexture(indices: Uint8Array, palette: PaletteColor[] | undefined): Texture {
  const rgba = new Uint8ClampedArray(SUBTILE_SIZE * SUBTILE_SIZE * 4);
  for (let i = 0; i < indices.length; i += 1) {
    const outBase = i * 4;
    const colorIndex = indices[i] ?? 0;
    const [r, g, b] = palette?.[colorIndex] ?? [0, 0, 0];
    rgba[outBase] = r & 0xff;
    rgba[outBase + 1] = g & 0xff;
    rgba[outBase + 2] = b & 0xff;
    rgba[outBase + 3] = colorIndex === 0 ? 0 : 0xff;
  }

  const canvas = document.createElement('canvas');
  canvas.width = SUBTILE_SIZE;
  canvas.height = SUBTILE_SIZE;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('Failed to create 2D canvas context for subtile texture baking');
  }

  ctx.putImageData(new ImageData(rgba, SUBTILE_SIZE, SUBTILE_SIZE), 0, 0);
  return Texture.from(canvas);
}

export class MetatileTextureCache {
  private readonly textureCache = new Map<string, Texture>();

  getTexture(params: {
    atlasPages: IndexedAtlasPages;
    pageId: number;
    localTileIndex: number;
    paletteIndex: number;
    palettes: PaletteColor[][];
    animationKey?: string;
  }): Texture | null {
    const cacheKey = `${params.pageId}:${params.localTileIndex}:${params.paletteIndex}:${params.animationKey ?? 'base'}`;
    const cached = this.textureCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    const page = params.atlasPages.get(params.pageId);
    if (!page || params.localTileIndex < 0 || params.localTileIndex >= page.tileCount) {
      return null;
    }

    const tileColumnCount = Math.floor(page.width / SUBTILE_SIZE);
    const tileX = params.localTileIndex % tileColumnCount;
    const tileY = Math.floor(params.localTileIndex / tileColumnCount);
    const px = tileX * SUBTILE_SIZE;
    const py = tileY * SUBTILE_SIZE;
    if (py + SUBTILE_SIZE > page.height) {
      return null;
    }

    const tileIndices = new Uint8Array(SUBTILE_SIZE * SUBTILE_SIZE);
    for (let row = 0; row < SUBTILE_SIZE; row += 1) {
      const sourceOffset = (py + row) * page.width + px;
      tileIndices.set(page.tileIndices.subarray(sourceOffset, sourceOffset + SUBTILE_SIZE), row * SUBTILE_SIZE);
    }

    const texture = makePaletteTexture(tileIndices, params.palettes[params.paletteIndex]);
    this.textureCache.set(cacheKey, texture);
    return texture;
  }
}

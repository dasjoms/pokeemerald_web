export type CopyTilesOp = {
  kind: 'copy_tiles';
  pageId: number;
  destLocalTileIndex: number;
  sourceLocalTileIndex: number;
};

export type CopyPaletteOp = {
  kind: 'copy_palette';
  tilesetName: string;
  destPaletteIndex: number;
  sourcePaletteIndex: number;
};

export type BlendPaletteOp = {
  kind: 'blend_palette';
  tilesetName: string;
  destPaletteIndex: number;
  sourcePaletteAIndex: number;
  sourcePaletteBIndex: number;
  coeffA: number;
  coeffB: number;
};

export type TilesetAnimOp = CopyTilesOp | CopyPaletteOp | BlendPaletteOp;
export type TilesetAnimCallback = (counter: number, primaryCounterMax: number) => { ops?: TilesetAnimOp[] };

const ENABLE_BATTLE_DOME_NO_BLEND = false;

export function makeTilesetAnimSecondaryInit(
  callback: TilesetAnimCallback | null,
  options?: { syncWithPrimary?: boolean; max?: number },
): (primaryCounterMax: number, primaryCounter: number) => {
  secondaryCallback: TilesetAnimCallback | null;
  secondaryCounter: number;
  secondaryCounterMax: number;
} {
  return (primaryCounterMax, primaryCounter) => ({
    secondaryCallback: callback,
    secondaryCounter: options?.syncWithPrimary ? primaryCounter : 0,
    secondaryCounterMax: options?.max ?? primaryCounterMax,
  });
}

export function makeCyclicTileSwap(pageId: number, baseTileIndex: number, tileCount: number, frame: number): CopyTilesOp {
  const normalizedFrame = ((frame % tileCount) + tileCount) % tileCount;
  return {
    kind: 'copy_tiles',
    pageId,
    destLocalTileIndex: baseTileIndex,
    sourceLocalTileIndex: baseTileIndex + normalizedFrame,
  };
}

export function buildSimpleModuloAnimation(modulo: number, onFrame: (timerDiv: number) => TilesetAnimOp[]): TilesetAnimCallback {
  return (counter) => {
    if (counter % modulo !== 0) {
      return {};
    }
    return { ops: onFrame(Math.floor(counter / modulo)) };
  };
}

export function buildGeneralPrimaryAnimations(): TilesetAnimCallback {
  return (counter) => {
    const phase = counter % 16;
    const timerDiv = Math.floor(counter / 16);
    if (phase === 0) {
      const sequence = [0, 1, 0, 2];
      return { ops: [{ kind: 'copy_tiles', pageId: 0, destLocalTileIndex: 508, sourceLocalTileIndex: 508 + sequence[timerDiv % sequence.length] }] };
    }
    if (phase === 1) return { ops: [makeCyclicTileSwap(0, 432, 30, timerDiv)] };
    if (phase === 2) return { ops: [makeCyclicTileSwap(0, 464, 10, timerDiv)] };
    if (phase === 3) return { ops: [makeCyclicTileSwap(0, 496, 6, timerDiv)] };
    if (phase === 4) return { ops: [makeCyclicTileSwap(0, 480, 10, timerDiv)] };
    return {};
  };
}

export function buildRustboroSecondaryAnimations(): TilesetAnimCallback {
  return (counter) => {
    const phase = counter % 8;
    const timerDiv = Math.floor(counter / 8);
    const tileSwaps = [makeCyclicTileSwap(1, 384 + phase * 4, 4, timerDiv)];
    if (phase === 0) tileSwaps.push(makeCyclicTileSwap(1, 448, 4, timerDiv));
    return { ops: tileSwaps };
  };
}

export function buildMauvilleSecondaryAnimations(): TilesetAnimCallback {
  return (counter) => {
    const phase = counter % 8;
    const timerDiv = Math.floor(counter / 8);
    return { ops: [makeCyclicTileSwap(1, 96 + phase * 4, 4, timerDiv), makeCyclicTileSwap(1, 128 + phase * 4, 4, timerDiv)] };
  };
}

export function buildLavaridgeSecondaryAnimations(): TilesetAnimCallback {
  return (counter) => {
    const phase = counter % 16;
    const timerDiv = Math.floor(counter / 16);
    if (phase === 0) return { ops: [makeCyclicTileSwap(1, 288, 4, timerDiv), makeCyclicTileSwap(1, 292, 4, timerDiv + 2)] };
    if (phase === 1) return { ops: [makeCyclicTileSwap(1, 160, 4, timerDiv)] };
    return {};
  };
}

export function buildPacifidlogSecondaryAnimations(): TilesetAnimCallback {
  return (counter) => {
    const phase = counter % 16;
    const timerDiv = Math.floor(counter / 16);
    if (phase === 0) return { ops: [makeCyclicTileSwap(1, 464, 30, timerDiv)] };
    if (phase === 1) return { ops: [makeCyclicTileSwap(1, 496, 8, timerDiv)] };
    return {};
  };
}

export function buildBattleDomeSecondaryAnimations(): TilesetAnimCallback {
  return (counter) => {
    if (counter % 8 !== 0) return {};
    const phase = Math.floor(counter / 8) % 4;
    if (ENABLE_BATTLE_DOME_NO_BLEND) {
      return { ops: [{ kind: 'copy_palette', tilesetName: 'gTileset_BattleDome', destPaletteIndex: 8, sourcePaletteIndex: 8 + phase }] };
    }
    return { ops: [{ kind: 'blend_palette', tilesetName: 'gTileset_BattleDome', destPaletteIndex: 8, sourcePaletteAIndex: 8 + phase, sourcePaletteBIndex: 8 + ((phase + 1) % 4), coeffA: 8, coeffB: 8 }] };
  };
}

export const secondaryTilesetAnimInitByName = new Map<string, ReturnType<typeof makeTilesetAnimSecondaryInit>>([
  ['gTileset_Petalburg', makeTilesetAnimSecondaryInit(null)],
  ['gTileset_Rustboro', makeTilesetAnimSecondaryInit(buildRustboroSecondaryAnimations())],
  ['gTileset_Mauville', makeTilesetAnimSecondaryInit(buildMauvilleSecondaryAnimations(), { syncWithPrimary: true })],
  ['gTileset_Lavaridge', makeTilesetAnimSecondaryInit(buildLavaridgeSecondaryAnimations())],
  ['gTileset_Pacifidlog', makeTilesetAnimSecondaryInit(buildPacifidlogSecondaryAnimations(), { syncWithPrimary: true })],
  ['gTileset_SootopolisGym', makeTilesetAnimSecondaryInit(buildSimpleModuloAnimation(8, (timer) => [
    makeCyclicTileSwap(1, 464, 20, timer), makeCyclicTileSwap(1, 496, 12, timer),
  ]), { max: 240 })],
  ['gTileset_BattleDome', makeTilesetAnimSecondaryInit(buildBattleDomeSecondaryAnimations(), { max: 32 })],
]);

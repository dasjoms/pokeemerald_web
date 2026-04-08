import { describe, expect, it } from 'vitest';

import {
  buildBattleDomeSecondaryAnimations,
  buildGeneralPrimaryAnimations,
  buildLavaridgeSecondaryAnimations,
  buildMauvilleSecondaryAnimations,
  buildRustboroSecondaryAnimations,
  secondaryTilesetAnimInitByName,
  type CopyTilesOp,
  type TilesetAnimOp,
} from './tilesetAnimation';
import {
  GENERAL_PRIMARY_FIXTURE,
  LAVARIDGE_SECONDARY_FIXTURE,
  RUSTBORO_SECONDARY_FIXTURE,
  SOOTOPOLIS_GYM_SECONDARY_FIXTURE,
} from './tilesetAnimParityFixtures';

function toExpected(op: CopyTilesOp): { dest_tile_offset: number; byte_count: number; frame_id: number } {
  return {
    dest_tile_offset: op.destLocalTileIndex,
    byte_count: 0,
    frame_id: op.sourceLocalTileIndex - op.destLocalTileIndex,
  };
}

function normalizeCopyOps(ops: TilesetAnimOp[] | undefined, sizeByDest: Map<number, number>) {
  return (ops ?? [])
    .filter((op): op is CopyTilesOp => op.kind === 'copy_tiles')
    .map((op) => {
      const base = toExpected(op);
      return { ...base, byte_count: (sizeByDest.get(base.dest_tile_offset) ?? 0) * 32 };
    });
}

describe('tileset animation parity harness', () => {
  it('matches General primary timing/phase fixtures', () => {
    const callback = buildGeneralPrimaryAnimations();
    const tileSizes = new Map([
      [508, 4],
      [432, 30],
      [464, 10],
      [496, 6],
      [480, 10],
    ]);
    for (const [timerStr, expected] of Object.entries(GENERAL_PRIMARY_FIXTURE)) {
      const timer = Number(timerStr);
      const actual = normalizeCopyOps(callback(timer, 256).ops, tileSizes);
      expect(actual).toEqual(expected);
    }
  });

  it('matches Rustboro/Lavaridge/SootopolisGym secondary op fixtures', () => {
    const rustboro = buildRustboroSecondaryAnimations();
    const lavaridge = buildLavaridgeSecondaryAnimations();
    const sootopolisGym = secondaryTilesetAnimInitByName.get('gTileset_SootopolisGym')!(256, 0)
      .secondaryCallback!;

    for (const [timerStr, expected] of Object.entries(RUSTBORO_SECONDARY_FIXTURE)) {
      const timer = Number(timerStr);
      const actual = normalizeCopyOps(rustboro(timer, 256).ops, new Map([[384, 4], [388, 4], [392, 4], [396, 4], [400, 4], [448, 4]]));
      expect(actual).toEqual(expected);
    }

    for (const [timerStr, expected] of Object.entries(LAVARIDGE_SECONDARY_FIXTURE)) {
      const timer = Number(timerStr);
      const actual = normalizeCopyOps(lavaridge(timer, 256).ops, new Map([[288, 4], [292, 4], [160, 4]]));
      expect(actual).toEqual(expected);
    }

    for (const [timerStr, expected] of Object.entries(SOOTOPOLIS_GYM_SECONDARY_FIXTURE)) {
      const timer = Number(timerStr);
      const actual = normalizeCopyOps(sootopolisGym(timer, 256).ops, new Map([[464, 20], [496, 12]]));
      expect(actual).toEqual(expected);
    }
  });

  it('keeps Mauville/Pacifidlog secondary counters synced to primary while Rustboro resets', () => {
    const mauvilleInit = secondaryTilesetAnimInitByName.get('gTileset_Mauville')!(256, 37);
    const pacifidlogInit = secondaryTilesetAnimInitByName.get('gTileset_Pacifidlog')!(256, 37);
    const rustboroInit = secondaryTilesetAnimInitByName.get('gTileset_Rustboro')!(256, 37);

    expect(mauvilleInit.secondaryCounter).toBe(37);
    expect(pacifidlogInit.secondaryCounter).toBe(37);
    expect(rustboroInit.secondaryCounter).toBe(0);
  });

  it('returns no-op for non-animated secondary tilesets', () => {
    const petalburg = secondaryTilesetAnimInitByName.get('gTileset_Petalburg')!(256, 123);
    expect(petalburg.secondaryCallback).toBeNull();
  });

  it('matches Battle Dome palette-op parity path', () => {
    const callback = buildBattleDomeSecondaryAnimations();
    expect(callback(1, 256).ops ?? []).toEqual([]);

    const ops0 = callback(0, 256).ops ?? [];
    const ops8 = callback(8, 256).ops ?? [];

    expect(ops0).toEqual([
      {
        kind: 'blend_palette',
        tilesetName: 'gTileset_BattleDome',
        destPaletteIndex: 8,
        sourcePaletteAIndex: 8,
        sourcePaletteBIndex: 9,
        coeffA: 8,
        coeffB: 8,
      },
    ]);
    expect(ops8).toEqual([
      {
        kind: 'blend_palette',
        tilesetName: 'gTileset_BattleDome',
        destPaletteIndex: 8,
        sourcePaletteAIndex: 9,
        sourcePaletteBIndex: 10,
        coeffA: 8,
        coeffB: 8,
      },
    ]);
  });

  it('produces deterministic destination updates for Mauville phases', () => {
    const callback = buildMauvilleSecondaryAnimations();
    const ops = (callback(16, 256).ops ?? []).filter((op): op is CopyTilesOp => op.kind === 'copy_tiles');
    expect(ops.map((op) => op.destLocalTileIndex)).toEqual([96, 128]);
    expect(ops.map((op) => op.sourceLocalTileIndex - op.destLocalTileIndex)).toEqual([2, 2]);
  });
});

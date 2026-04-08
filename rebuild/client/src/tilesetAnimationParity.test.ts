import { describe, expect, it, vi } from 'vitest';

import {
  BATTLE_DOME_FIXTURE,
  GENERAL_FIXTURE,
  MAUVILLE_FIXTURE,
  SOOTOPOLIS_GYM_FIXTURE,
} from './tilesetAnimInterpreterFixtures';
import { createTilesetAnimationState } from './tilesetAnimation';

describe('extracted tile animation program interpreter', () => {
  it('executes General primary flower sequence from extracted program', () => {
    const state = createTilesetAnimationState(GENERAL_FIXTURE, 512);
    const callback = state.primaryCallback!;

    expect((callback(0, 256).ops ?? [])[0]).toMatchObject({
      kind: 'copy_tiles',
      pageId: 0,
      destLocalTileIndex: 508,
      sourceFrameLocalTileIndex: 508,
      tileCount: 4,
    });
    expect((callback(16, 256).ops ?? [])[0]).toMatchObject({
      sourceFrameLocalTileIndex: 512,
    });
    expect((callback(32, 256).ops ?? [])[0]).toMatchObject({
      sourceFrameLocalTileIndex: 508,
    });
    expect((callback(48, 256).ops ?? [])[0]).toMatchObject({
      sourceFrameLocalTileIndex: 516,
    });
  });

  it('executes Mauville secondary destination mapping via timer_div/timer_mod program args', () => {
    const state = createTilesetAnimationState(MAUVILLE_FIXTURE, 512);
    const callback = state.secondaryCallback!;
    const tick8 = callback(8, 256).ops ?? [];

    expect(tick8.filter((op) => op.kind === 'copy_tiles').map((op) => op.destLocalTileIndex)).toEqual([
      96, 100, 104,
    ]);
    expect(tick8.filter((op) => op.kind === 'copy_tiles').map((op) => op.sourceFrameLocalTileIndex)).toEqual([
      100, 104, 108,
    ]);
  });

  it('respects extracted counter max for SootopolisGym secondary', () => {
    const state = createTilesetAnimationState(SOOTOPOLIS_GYM_FIXTURE, 512);
    expect(state.secondaryCounterMax).toBe(240);
    const ops = state.secondaryCallback!(8, 256).ops ?? [];
    expect(ops[0]).toMatchObject({
      kind: 'copy_tiles',
      pageId: 1,
      destLocalTileIndex: 464,
      sourceFrameLocalTileIndex: 484,
      tileCount: 20,
    });
  });

  it('emits extracted BattleDome palette copies', () => {
    const state = createTilesetAnimationState(BATTLE_DOME_FIXTURE, 512);
    const callback = state.secondaryCallback!;
    expect(callback(1, 256).ops ?? []).toEqual([]);

    expect(callback(0, 256).ops ?? []).toEqual([
      {
        kind: 'copy_palette',
        tilesetName: 'gTileset_BattleDome',
        destPaletteIndex: 8,
        sourcePaletteIndex: 8,
      },
    ]);
    expect(callback(4, 256).ops ?? []).toEqual([
      {
        kind: 'copy_palette',
        tilesetName: 'gTileset_BattleDome',
        destPaletteIndex: 8,
        sourcePaletteIndex: 8,
      },
    ]);
  });

  it('logs explicit parity errors for invalid extracted frames and falls back to no-op', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const broken = structuredClone(GENERAL_FIXTURE);
    broken.frame_arrays.gTilesetAnims_General_Flower = [];

    const state = createTilesetAnimationState(broken, 512);
    expect(state.primaryCallback!(0, 256).ops ?? []).toEqual([]);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});

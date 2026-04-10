import { describe, expect, it } from 'vitest';

import { computeObjectDepth } from './objectDepth';
import {
  resolveHopParticleBaseSubpriority,
  resolveHopTypeContext,
  shouldRenderHopParticleAbovePlayer,
} from './hopParticleDepth';
import { BikeTransitionType, Direction, HopLandingParticleClass } from './protocol_generated';

describe('resolveHopTypeContext', () => {
  it('maps standing wheelie hop transitions to stationary context', () => {
    expect(resolveHopTypeContext(BikeTransitionType.HOP_STANDING)).toBe('stationary');
    expect(resolveHopTypeContext(BikeTransitionType.WHEELIE_HOPPING_STANDING)).toBe(
      'stationary',
    );
  });

  it('maps moving hop transitions to directional context', () => {
    expect(resolveHopTypeContext(BikeTransitionType.HOP_MOVING)).toBe('directional');
    expect(resolveHopTypeContext(BikeTransitionType.WHEELIE_HOPPING_MOVING)).toBe(
      'directional',
    );
  });
});

describe('resolveHopParticleBaseSubpriority', () => {
  const particleClass = HopLandingParticleClass.NORMAL_GROUND_DUST;

  it('places left/right stationary hops in front-covering depth band', () => {
    expect(
      resolveHopParticleBaseSubpriority({
        facing: Direction.LEFT,
        hopType: 'stationary',
        particleClass,
      }),
    ).toBe(2);
    expect(
      resolveHopParticleBaseSubpriority({
        facing: Direction.RIGHT,
        hopType: 'stationary',
        particleClass,
      }),
    ).toBe(2);
  });

  it('places left/right directional hops in front-covering depth band', () => {
    expect(
      resolveHopParticleBaseSubpriority({
        facing: Direction.LEFT,
        hopType: 'directional',
        particleClass,
      }),
    ).toBe(2);
    expect(
      resolveHopParticleBaseSubpriority({
        facing: Direction.RIGHT,
        hopType: 'directional',
        particleClass,
      }),
    ).toBe(2);
  });

  it('keeps down-facing hops under-player', () => {
    expect(
      resolveHopParticleBaseSubpriority({
        facing: Direction.DOWN,
        hopType: 'directional',
        particleClass,
      }),
    ).toBe(0);
  });

  it('uses field-effect priority path for runtime render samples', () => {
    expect(
      resolveHopParticleBaseSubpriority({
        facing: Direction.LEFT,
        hopType: 'unknown',
        particleClass,
        useFieldEffectPriority: true,
      }),
    ).toBe(2);
    expect(
      resolveHopParticleBaseSubpriority({
        facing: Direction.LEFT,
        hopType: 'unknown',
        particleClass,
        useFieldEffectPriority: false,
      }),
    ).toBe(0);
  });

  it('yields higher object depth than player base for right-facing directional hop effects', () => {
    const sharedInput = {
      screenY: 48,
      halfHeightPx: 8,
      elevation: 0,
    };
    const playerDepth = computeObjectDepth({ ...sharedInput, baseSubpriority: 1 });
    const hopDepth = computeObjectDepth({
      ...sharedInput,
      baseSubpriority: resolveHopParticleBaseSubpriority({
        facing: Direction.RIGHT,
        hopType: 'directional',
        particleClass,
      }),
    });
    expect(hopDepth).toBeGreaterThan(playerDepth);
  });
});

describe('shouldRenderHopParticleAbovePlayer', () => {
  it('returns true only for left/right with field effect priority enabled', () => {
    expect(
      shouldRenderHopParticleAbovePlayer({
        facing: Direction.LEFT,
        useFieldEffectPriority: true,
      }),
    ).toBe(true);
    expect(
      shouldRenderHopParticleAbovePlayer({
        facing: Direction.RIGHT,
        useFieldEffectPriority: true,
      }),
    ).toBe(true);
    expect(
      shouldRenderHopParticleAbovePlayer({
        facing: Direction.DOWN,
        useFieldEffectPriority: true,
      }),
    ).toBe(false);
    expect(
      shouldRenderHopParticleAbovePlayer({
        facing: Direction.UP,
        useFieldEffectPriority: true,
      }),
    ).toBe(false);
    expect(
      shouldRenderHopParticleAbovePlayer({
        facing: Direction.LEFT,
        useFieldEffectPriority: false,
      }),
    ).toBe(false);
  });
});

describe('hop particle depth clamping', () => {
  function resolveFinalParticleDepth(input: {
    playerScreenY: number;
    particleScreenY: number;
    facing: Direction;
    useFieldEffectPriority: boolean;
    particleBaseSubpriority: number;
  }): { playerDepth: number; rawParticleDepth: number; finalParticleDepth: number } {
    // Realistic sprite assumptions from current renderer:
    // player frame is 16px tall, hop particle sprite is 8px tall.
    const playerDepth = computeObjectDepth({
      screenY: input.playerScreenY,
      halfHeightPx: 8,
      elevation: 0,
      baseSubpriority: 1,
    });
    const rawParticleDepth = computeObjectDepth({
      screenY: input.particleScreenY,
      halfHeightPx: 4,
      elevation: 0,
      baseSubpriority: input.particleBaseSubpriority,
    });
    const finalParticleDepth = shouldRenderHopParticleAbovePlayer({
      facing: input.facing,
      useFieldEffectPriority: input.useFieldEffectPriority,
    })
      ? Math.max(rawParticleDepth, playerDepth + 1)
      : rawParticleDepth;
    return { playerDepth, rawParticleDepth, finalParticleDepth };
  }

  it('forces lateral stationary/directional hops above player depth', () => {
    const stationary = resolveFinalParticleDepth({
      playerScreenY: 40,
      particleScreenY: 40,
      facing: Direction.LEFT,
      useFieldEffectPriority: true,
      particleBaseSubpriority: 2,
    });
    const directional = resolveFinalParticleDepth({
      playerScreenY: 40,
      particleScreenY: 40,
      facing: Direction.RIGHT,
      useFieldEffectPriority: true,
      particleBaseSubpriority: 2,
    });
    expect(stationary.finalParticleDepth).toBeGreaterThan(stationary.playerDepth);
    expect(directional.finalParticleDepth).toBeGreaterThan(directional.playerDepth);
  });

  it('keeps down/up contexts on existing depth path without clamp', () => {
    const down = resolveFinalParticleDepth({
      playerScreenY: 40,
      particleScreenY: 40,
      facing: Direction.DOWN,
      useFieldEffectPriority: true,
      particleBaseSubpriority: 0,
    });
    const up = resolveFinalParticleDepth({
      playerScreenY: 40,
      particleScreenY: 40,
      facing: Direction.UP,
      useFieldEffectPriority: true,
      particleBaseSubpriority: 0,
    });
    expect(down.finalParticleDepth).toBe(down.rawParticleDepth);
    expect(up.finalParticleDepth).toBe(up.rawParticleDepth);
  });

  it('regression: row-phase can keep base-subpriority-2 particle behind without clamp', () => {
    const result = resolveFinalParticleDepth({
      // 1 row-phase apart, particle receives lower tileRowComponent despite baseSubpriority=2.
      playerScreenY: 8,
      particleScreenY: 24,
      facing: Direction.RIGHT,
      useFieldEffectPriority: true,
      particleBaseSubpriority: 2,
    });
    expect(result.rawParticleDepth).toBeLessThanOrEqual(result.playerDepth);
    expect(result.finalParticleDepth).toBe(result.playerDepth + 1);
  });
});

import { describe, expect, it } from 'vitest';

import { computeObjectDepth } from './objectDepth';
import { resolveHopParticleBaseSubpriority, resolveHopTypeContext } from './hopParticleDepth';
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

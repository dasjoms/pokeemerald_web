import { describe, expect, it } from 'vitest';
import { computeObjectDepth } from './objectDepth';
import {
  resolveHopParticleBaseSubpriority,
  shouldRenderHopParticleAbovePlayer,
} from './hopParticleDepth';
import { buildHopParticleLandingEvent } from './hopParticlePriority';
import {
  AcroBikeSubstate,
  BikeTransitionType,
  Direction,
  HopLandingParticleClass,
  TraversalState,
} from './protocol_generated';

describe('hop particle landing queue to depth integration', () => {
  it('forces lateral acro landing particles above the player even when transition/substate are non-hop', () => {
    const queuedEvent = buildHopParticleLandingEvent({
      particleClass: HopLandingParticleClass.NORMAL_GROUND_DUST,
      serverFrame: 42,
      hopLandingTileX: 12,
      hopLandingTileY: 8,
      hopLandingElevation: 0,
      facing: Direction.LEFT,
      traversalState: TraversalState.ACRO_BIKE,
      acroSubstate: AcroBikeSubstate.NONE,
      bikeTransition: BikeTransitionType.NONE,
    });

    expect(queuedEvent).toBeDefined();
    expect(queuedEvent?.useFieldEffectPriority).toBe(true);

    const playerDepth = computeObjectDepth({
      screenY: 140,
      halfHeightPx: 8,
      elevation: 0,
      baseSubpriority: 1,
    });
    const particleDepth = computeObjectDepth({
      screenY: 132,
      halfHeightPx: 4,
      elevation: 0,
      baseSubpriority: resolveHopParticleBaseSubpriority({
        facing: queuedEvent!.facing,
        particleClass: queuedEvent!.particleClass,
        useFieldEffectPriority: queuedEvent!.useFieldEffectPriority,
      }),
    });
    const finalParticleDepth = shouldRenderHopParticleAbovePlayer({
      facing: queuedEvent!.facing,
      useFieldEffectPriority: queuedEvent!.useFieldEffectPriority,
    })
      ? Math.max(particleDepth, playerDepth + 1)
      : particleDepth;

    expect(finalParticleDepth).toBeGreaterThan(playerDepth);
  });

  it('does not enable field-effect priority for non-acro traversal contexts', () => {
    const queuedEvent = buildHopParticleLandingEvent({
      particleClass: HopLandingParticleClass.NORMAL_GROUND_DUST,
      serverFrame: 43,
      hopLandingTileX: 12,
      hopLandingTileY: 8,
      hopLandingElevation: 0,
      facing: Direction.RIGHT,
      traversalState: TraversalState.ON_FOOT,
      acroSubstate: AcroBikeSubstate.NONE,
      bikeTransition: BikeTransitionType.NONE,
    });

    expect(queuedEvent).toBeDefined();
    expect(queuedEvent?.useFieldEffectPriority).toBe(false);
  });
});

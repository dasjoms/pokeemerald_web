import {
  AcroBikeSubstate,
  BikeTransitionType,
  Direction,
  HopLandingParticleClass,
  TraversalState,
} from './protocol_generated';

export type HopParticleLandingQueueInput = {
  particleClass: HopLandingParticleClass | undefined;
  serverFrame: number;
  hopLandingTileX?: number;
  hopLandingTileY?: number;
  hopLandingElevation: number;
  facing: Direction;
  traversalState: TraversalState;
  acroSubstate: AcroBikeSubstate | undefined;
  bikeTransition: BikeTransitionType | undefined;
};

export type QueuedHopLandingParticleEvent = {
  particleClass: HopLandingParticleClass;
  serverFrame: number;
  tileX: number;
  tileY: number;
  elevation: number;
  facing: Direction;
  useFieldEffectPriority: boolean;
};

export function buildHopParticleLandingEvent(
  input: HopParticleLandingQueueInput,
): QueuedHopLandingParticleEvent | undefined {
  if (
    input.particleClass === undefined ||
    input.hopLandingTileX === undefined ||
    input.hopLandingTileY === undefined
  ) {
    return undefined;
  }

  return {
    tileX: input.hopLandingTileX,
    tileY: input.hopLandingTileY,
    elevation: input.hopLandingElevation,
    particleClass: input.particleClass,
    serverFrame: input.serverFrame,
    facing: input.facing,
    useFieldEffectPriority: input.traversalState === TraversalState.ACRO_BIKE,
  };
}

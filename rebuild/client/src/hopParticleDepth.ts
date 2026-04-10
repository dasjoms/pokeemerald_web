import { BikeTransitionType, Direction, HopLandingParticleClass } from './protocol_generated';

export type HopTypeContext = 'stationary' | 'directional' | 'unknown';

export function resolveHopTypeContext(
  bikeTransition: BikeTransitionType | undefined,
): HopTypeContext {
  switch (bikeTransition) {
    case BikeTransitionType.HOP_STANDING:
    case BikeTransitionType.WHEELIE_HOPPING_STANDING:
      return 'stationary';
    case BikeTransitionType.HOP_MOVING:
    case BikeTransitionType.WHEELIE_HOPPING_MOVING:
    case BikeTransitionType.SIDE_JUMP:
    case BikeTransitionType.TURN_JUMP:
      return 'directional';
    default:
      return 'unknown';
  }
}

export function resolveHopParticleBaseSubpriority(input: {
  facing: Direction;
  hopType: HopTypeContext;
  particleClass: HopLandingParticleClass;
}): number {
  const { facing, hopType } = input;
  const isLateralHop =
    facing === Direction.LEFT &&
    (hopType === 'stationary' || hopType === 'directional');
  const isRightLateralHop =
    facing === Direction.RIGHT &&
    (hopType === 'stationary' || hopType === 'directional');
  if (isLateralHop || isRightLateralHop) {
    // ROM-parity intent: left/right hop landings can cover the rider in-front.
    return 2;
  }
  if (facing === Direction.DOWN) {
    // ROM-parity intent: down-facing hops stay under player body.
    return 0;
  }
  return 0;
}

export function shouldRenderHopParticleAbovePlayer(input: {
  facing: Direction;
  useFieldEffectPriority: boolean;
}): boolean {
  return (
    input.useFieldEffectPriority &&
    (input.facing === Direction.LEFT || input.facing === Direction.RIGHT)
  );
}

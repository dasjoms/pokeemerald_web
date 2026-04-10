import {
  AcroBikeSubstate,
  Direction,
  TraversalState,
} from './protocol_generated';
import type { WalkTransition, WalkTransitionStart } from './walkTransitionPipeline';

type ResolveAuthoritativeWalkTransitionStartTileInput = {
  traversalState: TraversalState;
  acroSubstate?: AcroBikeSubstate;
  facing: Direction;
  previousAuthoritativeTileX: number;
  previousAuthoritativeTileY: number;
  targetTileX: number;
  targetTileY: number;
  renderTileX: number;
  renderTileY: number;
  activeWalkTransition: WalkTransition | null;
};

const EPSILON = 1e-6;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function hasInFlightTransitionContext(activeWalkTransition: WalkTransition | null): boolean {
  return (
    activeWalkTransition !== null &&
    activeWalkTransition.elapsedMs > 0 &&
    activeWalkTransition.elapsedMs + EPSILON < activeWalkTransition.durationMs
  );
}

export function resolveAuthoritativeWalkTransitionStartTile(
  input: ResolveAuthoritativeWalkTransitionStartTileInput,
): WalkTransitionStart | undefined {
  if (
    input.traversalState !== TraversalState.ACRO_BIKE ||
    input.acroSubstate !== AcroBikeSubstate.BUNNY_HOP
  ) {
    return undefined;
  }

  if (!hasInFlightTransitionContext(input.activeWalkTransition)) {
    return {
      tileX: input.previousAuthoritativeTileX,
      tileY: input.previousAuthoritativeTileY,
    };
  }

  if (input.facing === Direction.LEFT || input.facing === Direction.RIGHT) {
    const minTileX = Math.min(input.previousAuthoritativeTileX, input.targetTileX);
    const maxTileX = Math.max(input.previousAuthoritativeTileX, input.targetTileX);
    return {
      tileX: clamp(input.renderTileX, minTileX, maxTileX),
      tileY: input.targetTileY,
    };
  }

  const minTileY = Math.min(input.previousAuthoritativeTileY, input.targetTileY);
  const maxTileY = Math.max(input.previousAuthoritativeTileY, input.targetTileY);
  return {
    tileX: input.targetTileX,
    tileY: clamp(input.renderTileY, minTileY, maxTileY),
  };
}

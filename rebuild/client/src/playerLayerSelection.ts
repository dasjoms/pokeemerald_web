export type PlayerLayerTileContext = {
  metatileLayerType: number | undefined;
  behaviorId: number;
  layer1SubtileMask: number;
};

export type ActiveWalkTransition = {
  startX: number;
  startY: number;
  targetX: number;
  targetY: number;
  elapsedMs: number;
  durationMs: number;
};

export type PlayerLayerSelectionState = {
  playerTileX: number;
  playerTileY: number;
  activeWalkTransition: ActiveWalkTransition | null;
};

const STABLE_FOOTPOINT_EPSILON = 1e-6;

export function resolvePlayerLayerSampleTile(state: PlayerLayerSelectionState): { x: number; y: number } {
  if (!state.activeWalkTransition) {
    return { x: state.playerTileX, y: state.playerTileY };
  }

  const transition = state.activeWalkTransition;
  const isStepComplete = transition.elapsedMs >= transition.durationMs;
  if (isStepComplete) {
    return { x: state.playerTileX, y: state.playerTileY };
  }

  return {
    x: stableFootpointTile(transition.startX),
    y: stableFootpointTile(transition.startY),
  };
}

export function resolvePlayerRenderPriorityAtTile(
  tileContext: PlayerLayerTileContext | undefined,
  coveredLayerType: number,
): 'below-bg2' | 'between-bg2-bg1' {
  if (!tileContext) {
    return 'between-bg2-bg1';
  }

  if (tileContext.metatileLayerType !== coveredLayerType) {
    return 'between-bg2-bg1';
  }

  if (isCoveredDecorativeOverlay(tileContext)) {
    return 'between-bg2-bg1';
  }

  return 'below-bg2';
}

function stableFootpointTile(value: number): number {
  return Math.floor(value + STABLE_FOOTPOINT_EPSILON);
}

function isCoveredDecorativeOverlay(tileContext: PlayerLayerTileContext): boolean {
  if (tileContext.layer1SubtileMask === 0) {
    return false;
  }

  switch (tileContext.behaviorId) {
    case 33: // MB_DEEP_SAND
    case 34: // MB_SAND
    case 36: // MB_ASHGRASS
    case 37: // MB_FOOTPRINTS
      return true;
    default:
      return false;
  }
}

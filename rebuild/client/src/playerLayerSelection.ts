export type PlayerLayerTileContext = {
  metatileLayerType: number | undefined;
  behaviorId: number;
  layer1SubtileMask: number;
};

export type PlayerObjectRenderPriorityState = 'normal' | 'below-bg2';

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

export type PlayerRenderPrioritySelection = {
  objectPriorityState: PlayerObjectRenderPriorityState;
  tileContext?: PlayerLayerTileContext;
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

export function resolvePlayerRenderPriority(
  selection: PlayerRenderPrioritySelection,
): 'below-bg2' | 'between-bg2-bg1' {
  // Player/object render priority is a separate system from map BG layer composition.
  // Covered/decorative metatile context does not implicitly force full actor underlay.
  if (selection.objectPriorityState === 'below-bg2') {
    return 'below-bg2';
  }

  return 'between-bg2-bg1';
}

function stableFootpointTile(value: number): number {
  return Math.floor(value + STABLE_FOOTPOINT_EPSILON);
}

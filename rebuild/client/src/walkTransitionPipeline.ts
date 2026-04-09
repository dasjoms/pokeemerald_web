import { Direction, MovementMode } from './protocol_generated';

const SERVER_MOVEMENT_SAMPLE_MS = 1000 / 60;

export type WalkTransition = {
  startX: number;
  startY: number;
  targetX: number;
  targetY: number;
  elapsedMs: number;
  durationMs: number;
  facing: Direction;
};

export type WalkTransitionMutableState = {
  renderTileX: number;
  renderTileY: number;
  playerTileX: number;
  playerTileY: number;
};

type TickWalkTransitionArgs = {
  activeWalkTransition: WalkTransition | null;
  state: WalkTransitionMutableState;
  deltaMs: number;
  hasPendingAcceptedOrDispatchableStep: () => boolean;
  markWalkTransitionCompleted: () => void;
  stopMoving: (direction: Direction) => void;
};

export function movementModeStepDurationMs(movementMode: MovementMode): number {
  switch (movementMode) {
    case MovementMode.RUN:
    case MovementMode.ACRO_CRUISE:
    case MovementMode.ACRO_WHEELIE_MOVE:
      return SERVER_MOVEMENT_SAMPLE_MS * 8;
    case MovementMode.MACH_BIKE:
      return SERVER_MOVEMENT_SAMPLE_MS * 6;
    case MovementMode.WALK:
    case MovementMode.ACRO_WHEELIE_PREP:
    case MovementMode.BUNNY_HOP:
      return SERVER_MOVEMENT_SAMPLE_MS * 16;
  }
}

export function startAuthoritativeWalkTransition(
  state: WalkTransitionMutableState,
  facing: Direction,
  movementMode: MovementMode,
): WalkTransition {
  return {
    startX: state.renderTileX,
    startY: state.renderTileY,
    targetX: state.playerTileX,
    targetY: state.playerTileY,
    elapsedMs: 0,
    durationMs: movementModeStepDurationMs(movementMode),
    facing,
  };
}

export function tickWalkTransition(args: TickWalkTransitionArgs): WalkTransition | null {
  const {
    activeWalkTransition,
    state,
    deltaMs,
    hasPendingAcceptedOrDispatchableStep,
    markWalkTransitionCompleted,
    stopMoving,
  } = args;
  if (!activeWalkTransition) {
    state.renderTileX = state.playerTileX;
    state.renderTileY = state.playerTileY;
    return null;
  }

  activeWalkTransition.elapsedMs += Math.max(0, deltaMs);
  const t = Math.min(1, activeWalkTransition.elapsedMs / activeWalkTransition.durationMs);
  state.renderTileX =
    activeWalkTransition.startX +
    (activeWalkTransition.targetX - activeWalkTransition.startX) * t;
  state.renderTileY =
    activeWalkTransition.startY +
    (activeWalkTransition.targetY - activeWalkTransition.startY) * t;

  if (t >= 1) {
    state.renderTileX = activeWalkTransition.targetX;
    state.renderTileY = activeWalkTransition.targetY;
    const completedTransitionFacing = activeWalkTransition.facing;
    const shouldRemainInLocomotion = hasPendingAcceptedOrDispatchableStep();
    markWalkTransitionCompleted();
    if (!shouldRemainInLocomotion) {
      stopMoving(completedTransitionFacing);
    }
    return null;
  }

  return activeWalkTransition;
}

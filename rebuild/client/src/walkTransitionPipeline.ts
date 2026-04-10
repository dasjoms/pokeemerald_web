import { Direction, MovementMode, StepSpeed, TraversalState } from './protocol_generated';

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

export type WalkTransitionStart = {
  tileX: number;
  tileY: number;
};

type TickWalkTransitionArgs = {
  activeWalkTransition: WalkTransition | null;
  state: WalkTransitionMutableState;
  deltaMs: number;
  hasPendingAcceptedOrDispatchableStep: () => boolean;
  noteWalkTransitionProgress: (normalizedProgress: number) => void;
  markWalkTransitionCompleted: () => void;
  stopMoving: (direction: Direction) => void;
};

function stepSamplesToDurationMs(stepSamples: number): number {
  return SERVER_MOVEMENT_SAMPLE_MS * stepSamples;
}

export type AuthoritativeStepSpeedInput = {
  authoritativeStepSpeed?: StepSpeed;
  traversalState: TraversalState;
  machSpeedStage?: number;
  movementMode: MovementMode;
};

export function authoritativeStepDurationMs(input: AuthoritativeStepSpeedInput): number {
  if (input.authoritativeStepSpeed !== undefined) {
    switch (input.authoritativeStepSpeed) {
      case StepSpeed.STEP8:
        return stepSamplesToDurationMs(2);
      case StepSpeed.STEP4:
        return stepSamplesToDurationMs(4);
      case StepSpeed.STEP3:
        return stepSamplesToDurationMs(6);
      case StepSpeed.STEP2:
        return stepSamplesToDurationMs(8);
      case StepSpeed.STEP1:
      default:
        return stepSamplesToDurationMs(16);
    }
  }

  // Backward-compat fallback for packets from older servers that don't send step speed.
  switch (input.traversalState) {
    case TraversalState.MACH_BIKE:
      if ((input.machSpeedStage ?? 0) <= 0) {
        return stepSamplesToDurationMs(16);
      }
      if (input.machSpeedStage === 1) {
        return stepSamplesToDurationMs(8);
      }
      return stepSamplesToDurationMs(4);
    case TraversalState.ACRO_BIKE:
      return stepSamplesToDurationMs(6);
    case TraversalState.ON_FOOT:
    default:
      return input.movementMode === MovementMode.RUN
        ? stepSamplesToDurationMs(8)
        : stepSamplesToDurationMs(16);
  }
}

export function movementModeStepDurationMs(movementMode: MovementMode): number {
  switch (movementMode) {
    case MovementMode.RUN:
      return stepSamplesToDurationMs(8);
    case MovementMode.WALK:
    default:
      return stepSamplesToDurationMs(16);
  }
}

export function startAuthoritativeWalkTransition(
  state: WalkTransitionMutableState,
  facing: Direction,
  stepSpeedInput: AuthoritativeStepSpeedInput,
  startTile?: WalkTransitionStart,
): WalkTransition {
  return {
    startX: startTile?.tileX ?? state.renderTileX,
    startY: startTile?.tileY ?? state.renderTileY,
    targetX: state.playerTileX,
    targetY: state.playerTileY,
    elapsedMs: 0,
    durationMs: authoritativeStepDurationMs(stepSpeedInput),
    facing,
  };
}

export function tickWalkTransition(args: TickWalkTransitionArgs): WalkTransition | null {
  const {
    activeWalkTransition,
    state,
    deltaMs,
    hasPendingAcceptedOrDispatchableStep,
    noteWalkTransitionProgress,
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
  noteWalkTransitionProgress(t);

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

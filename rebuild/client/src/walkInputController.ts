import { Direction, MovementMode, RejectionReason, type WalkResult } from './protocol_generated';

const TURN_ONLY_TAP_MS = 70;

type AcroActionStage = 'idle' | 'wheelie_prep' | 'wheelie_move';

export type WalkInputController = {
  handleKeyDown: (event: KeyboardEvent) => void;
  handleKeyUp: (event: KeyboardEvent) => void;
  cycleTraversalTestMode: () => void;
  tick: () => void;
  markWalkResultReceived: (result: WalkResult) => void;
  markWalkTransitionCompleted: () => void;
  hasPendingAcceptedOrDispatchableStep: () => boolean;
  getTraversalTestMode: () => TraversalTestMode;
  getMovementMode: () => MovementMode;
  reset: () => void;
};

export enum TraversalTestMode {
  ON_FOOT,
  MACH,
  ACRO,
}

function keyToDirection(key: string): Direction | null {
  switch (key) {
    case 'ArrowUp':
    case 'w':
    case 'W':
      return Direction.UP;
    case 'ArrowDown':
    case 's':
    case 'S':
      return Direction.DOWN;
    case 'ArrowLeft':
    case 'a':
    case 'A':
      return Direction.LEFT;
    case 'ArrowRight':
    case 'd':
    case 'D':
      return Direction.RIGHT;
    default:
      return null;
  }
}

export function createWalkInputController(config: {
  sendWalkInput: (direction: Direction, movementMode: MovementMode) => void;
  isMovementLocked: () => boolean;
  onFacingIntent: (direction: Direction) => void;
}): WalkInputController {
  const heldDirections = new Set<Direction>();
  const heldDirectionPressedAtMs = new Map<Direction, number>();
  const directionOrder: Direction[] = [];
  let activeIntent: Direction | null = null;
  let bufferedIntent: Direction | null = null;
  let hasPendingWalkRequest = false;
  let traversalTestMode: TraversalTestMode = TraversalTestMode.ON_FOOT;
  let isSpaceHeld = false;
  let acroActionStage: AcroActionStage = 'idle';
  let acroActionDirection: Direction | null = null;
  let acroHopRequestedDirection: Direction | null = null;

  const resetAcroActionStaging = (): void => {
    acroActionStage = 'idle';
    acroActionDirection = null;
    acroHopRequestedDirection = null;
  };

  const removeDirectionFromOrder = (direction: Direction): void => {
    const index = directionOrder.indexOf(direction);
    if (index >= 0) {
      directionOrder.splice(index, 1);
    }
  };

  const canDispatchNewIntent = (): boolean =>
    !hasPendingWalkRequest && !config.isMovementLocked() && activeIntent === null;

  const hasSatisfiedTapThreshold = (direction: Direction, nowMs: number): boolean => {
    const pressedAtMs = heldDirectionPressedAtMs.get(direction);
    if (pressedAtMs === undefined) {
      return false;
    }
    return nowMs - pressedAtMs >= TURN_ONLY_TAP_MS;
  };

  const getEligibleHeldDirection = (nowMs: number): Direction | null => {
    for (let i = directionOrder.length - 1; i >= 0; i -= 1) {
      const direction = directionOrder[i];
      if (!heldDirections.has(direction)) {
        continue;
      }
      if (hasSatisfiedTapThreshold(direction, nowMs)) {
        return direction;
      }
    }
    return null;
  };

  const currentBaseMovementMode = (): MovementMode => {
    switch (traversalTestMode) {
      case TraversalTestMode.MACH:
        return MovementMode.MACH_BIKE;
      case TraversalTestMode.ACRO:
        return MovementMode.ACRO_CRUISE;
      case TraversalTestMode.ON_FOOT:
      default:
        return MovementMode.WALK;
    }
  };

  const selectMovementModeForDispatch = (direction: Direction): MovementMode => {
    switch (traversalTestMode) {
      case TraversalTestMode.MACH:
        resetAcroActionStaging();
        return MovementMode.MACH_BIKE;
      case TraversalTestMode.ON_FOOT:
        resetAcroActionStaging();
        return MovementMode.WALK;
      case TraversalTestMode.ACRO:
      default:
        break;
    }

    if (!isSpaceHeld) {
      resetAcroActionStaging();
      return MovementMode.ACRO_CRUISE;
    }

    if (acroActionDirection !== null && acroActionDirection !== direction) {
      resetAcroActionStaging();
    }

    if (acroActionStage === 'idle') {
      acroActionStage = 'wheelie_prep';
      acroActionDirection = direction;
      return MovementMode.ACRO_WHEELIE_PREP;
    }

    if (acroHopRequestedDirection === direction) {
      acroHopRequestedDirection = null;
      resetAcroActionStaging();
      return MovementMode.BUNNY_HOP;
    }

    acroActionStage = 'wheelie_move';
    acroActionDirection = direction;
    return MovementMode.ACRO_WHEELIE_MOVE;
  };

  const sendIntent = (direction: Direction): void => {
    const movementMode = selectMovementModeForDispatch(direction);
    config.onFacingIntent(direction);
    config.sendWalkInput(direction, movementMode);
    activeIntent = direction;
    hasPendingWalkRequest = true;
  };

  const updateBufferedIntentFromHeldDirections = (nowMs: number): void => {
    const eligibleHeldDirection = getEligibleHeldDirection(nowMs);
    if (eligibleHeldDirection !== null) {
      bufferedIntent = eligibleHeldDirection;
      return;
    }

    if (bufferedIntent !== null && !heldDirections.has(bufferedIntent)) {
      bufferedIntent = null;
    }
  };

  const maybeDispatchIntent = (nowMs: number): void => {
    updateBufferedIntentFromHeldDirections(nowMs);
    if (!canDispatchNewIntent()) {
      return;
    }

    if (
      bufferedIntent !== null &&
      heldDirections.has(bufferedIntent) &&
      hasSatisfiedTapThreshold(bufferedIntent, nowMs)
    ) {
      const buffered = bufferedIntent;
      bufferedIntent = null;
      sendIntent(buffered);
      return;
    }

    const heldDirection = getEligibleHeldDirection(nowMs);
    if (heldDirection !== null) {
      bufferedIntent = null;
      sendIntent(heldDirection);
    }
  };

  const hasPendingAcceptedOrDispatchableStep = (nowMs: number): boolean => {
    updateBufferedIntentFromHeldDirections(nowMs);
    if (hasPendingWalkRequest) {
      return true;
    }

    if (
      bufferedIntent !== null &&
      heldDirections.has(bufferedIntent) &&
      hasSatisfiedTapThreshold(bufferedIntent, nowMs)
    ) {
      return true;
    }

    return getEligibleHeldDirection(nowMs) !== null;
  };

  return {
    handleKeyDown(event: KeyboardEvent): void {
      if (event.code === 'Space') {
        event.preventDefault();
        if (!event.repeat) {
          isSpaceHeld = true;
          if (
            traversalTestMode === TraversalTestMode.ACRO &&
            acroActionStage === 'wheelie_move' &&
            acroActionDirection !== null
          ) {
            acroHopRequestedDirection = acroActionDirection;
          }
        }
        return;
      }

      const direction = keyToDirection(event.key);
      if (direction === null) {
        return;
      }

      event.preventDefault();
      if (event.repeat) {
        return;
      }

      const isFirstPressForDirection = !heldDirections.has(direction);
      heldDirections.add(direction);
      heldDirectionPressedAtMs.set(direction, performance.now());
      removeDirectionFromOrder(direction);
      directionOrder.push(direction);

      if (
        traversalTestMode === TraversalTestMode.ACRO &&
        isSpaceHeld &&
        isFirstPressForDirection &&
        acroActionStage === 'wheelie_move' &&
        acroActionDirection === direction
      ) {
        acroHopRequestedDirection = direction;
      }

      if (isFirstPressForDirection) {
        config.onFacingIntent(direction);
      }

      maybeDispatchIntent(performance.now());
    },
    cycleTraversalTestMode(): void {
      switch (traversalTestMode) {
        case TraversalTestMode.ON_FOOT:
          traversalTestMode = TraversalTestMode.MACH;
          resetAcroActionStaging();
          return;
        case TraversalTestMode.MACH:
          traversalTestMode = TraversalTestMode.ACRO;
          resetAcroActionStaging();
          return;
        case TraversalTestMode.ACRO:
        default:
          traversalTestMode = TraversalTestMode.ON_FOOT;
          resetAcroActionStaging();
      }
    },
    handleKeyUp(event: KeyboardEvent): void {
      if (event.code === 'Space') {
        event.preventDefault();
        isSpaceHeld = false;
        resetAcroActionStaging();
        return;
      }

      const direction = keyToDirection(event.key);
      if (direction === null) {
        return;
      }

      event.preventDefault();
      heldDirections.delete(direction);
      heldDirectionPressedAtMs.delete(direction);
      removeDirectionFromOrder(direction);
      if (bufferedIntent === direction) {
        bufferedIntent = null;
      }
    },
    tick(): void {
      maybeDispatchIntent(performance.now());
    },
    markWalkResultReceived(result: WalkResult): void {
      hasPendingWalkRequest = false;
      if (!result.accepted) {
        if (
          result.reason === RejectionReason.BIKE_INVALID_STATE_TRANSITION ||
          result.reason === RejectionReason.BIKE_WHEELIE_WINDOW_EXPIRED
        ) {
          resetAcroActionStaging();
        }

        activeIntent = null;
        maybeDispatchIntent(performance.now());
      }
    },
    markWalkTransitionCompleted(): void {
      activeIntent = null;
      maybeDispatchIntent(performance.now());
    },
    hasPendingAcceptedOrDispatchableStep(): boolean {
      return hasPendingAcceptedOrDispatchableStep(performance.now());
    },
    getTraversalTestMode(): TraversalTestMode {
      return traversalTestMode;
    },
    getMovementMode(): MovementMode {
      return currentBaseMovementMode();
    },
    reset(): void {
      hasPendingWalkRequest = false;
      activeIntent = null;
      bufferedIntent = null;
      traversalTestMode = TraversalTestMode.ON_FOOT;
      heldDirections.clear();
      heldDirectionPressedAtMs.clear();
      directionOrder.length = 0;
      isSpaceHeld = false;
      resetAcroActionStaging();
    },
  };
}

import {
  Direction,
  HeldDpad,
  HeldButtons,
  MessageType,
  MovementMode,
  PROTOCOL_VERSION,
  resolveDirectionFromHeldDpad,
  type WalkResult,
} from "./protocol_generated";

export type WalkInputController = {
  handleKeyDown: (event: KeyboardEvent) => void;
  handleKeyUp: (event: KeyboardEvent) => void;
  setVirtualBHeld: (held: boolean) => void;
  toggleMovementMode: () => void;
  tick: () => void;
  noteWalkTransitionProgress: (normalizedProgress: number) => void;
  markWalkResultReceived: (result: WalkResult) => void;
  markWalkTransitionCompleted: () => void;
  hasPendingAcceptedOrDispatchableStep: () => boolean;
  getMovementMode: () => MovementMode;
  reset: () => void;
};

// Phase B: short fixed threshold that commits the first step after an initial press.
const FIRST_STEP_COMMIT_MS = 90;
const HELD_INPUT_SAMPLE_MS = 1000 / 60;
const LOOKAHEAD_SAMPLE_PROGRESS = 0.85;
const DEBUG_ACRO_HOP = true;

export function keyToDirection(key: string): Direction | null {
  switch (key) {
    case "ArrowUp":
    case "w":
    case "W":
      return Direction.UP;
    case "ArrowDown":
    case "s":
    case "S":
      return Direction.DOWN;
    case "ArrowLeft":
    case "a":
    case "A":
      return Direction.LEFT;
    case "ArrowRight":
    case "d":
    case "D":
      return Direction.RIGHT;
    default:
      return null;
  }
}

export function createWalkInputController(config: {
  sendWalkInput: (
    direction: Direction,
    movementMode: MovementMode,
    heldButtons: number,
  ) => void;
  sendHeldInputState: (
    heldDpad: number,
    heldButtons: number,
  ) => number | null;
  isMovementLocked: () => boolean;
  onFacingIntent: (direction: Direction) => void;
}): WalkInputController {
  const heldDirections = new Set<Direction>();
  const heldDirectionPressedAtMs = new Map<Direction, number>();
  const directionOrder: Direction[] = [];
  let hasPendingWalkRequest = false;
  let movementMode: MovementMode = MovementMode.WALK;
  let virtualBHeld = false;
  let heldInputSampleAccumulatorMs = 0;
  let lastHeldInputTickAtMs: number | null = null;
  let localHeldInputTick = 0;
  let lastLoggedHeldState: {
    heldDpad: number;
    heldButtons: number;
  } | null = null;

  const heldButtons = (): number =>
    virtualBHeld ? HeldButtons.B : HeldButtons.NONE;

  const getHeldDpadMask = (): number => {
    let mask = HeldDpad.NONE;
    if (heldDirections.has(Direction.UP)) {
      mask |= HeldDpad.UP;
    }
    if (heldDirections.has(Direction.DOWN)) {
      mask |= HeldDpad.DOWN;
    }
    if (heldDirections.has(Direction.LEFT)) {
      mask |= HeldDpad.LEFT;
    }
    if (heldDirections.has(Direction.RIGHT)) {
      mask |= HeldDpad.RIGHT;
    }
    return mask;
  };

  const getActiveHeldDirection = (): Direction | null => {
    return resolveDirectionFromHeldDpad(getHeldDpadMask()) ?? null;
  };

  const emitHeldInputState = (): void => {
    const heldDpad = getHeldDpadMask();
    const buttons = heldButtons();
    const outboundSeq = config.sendHeldInputState(heldDpad, buttons);
    const localTick = localHeldInputTick;
    localHeldInputTick += 1;
    if (DEBUG_ACRO_HOP) {
      const shouldLogHeldState =
        lastLoggedHeldState === null ||
        lastLoggedHeldState.heldDpad !== heldDpad ||
        lastLoggedHeldState.heldButtons !== buttons;
      if (shouldLogHeldState) {
        console.info("[acro-hop][input] emit held-state (state-change)", {
          heldDpad,
          heldButtons: buttons,
          localTick,
          outboundHeldInputSeq: outboundSeq,
        });
        lastLoggedHeldState = {
          heldDpad,
          heldButtons: buttons,
        };
      }
    }
  };

  const sampleHeldInputForTick = (nowMs: number): void => {
    if (lastHeldInputTickAtMs === null) {
      lastHeldInputTickAtMs = nowMs;
      emitHeldInputState();
      return;
    }

    const deltaMs = nowMs - lastHeldInputTickAtMs;
    lastHeldInputTickAtMs = nowMs;
    if (deltaMs <= 0) {
      return;
    }

    heldInputSampleAccumulatorMs += deltaMs;
    while (heldInputSampleAccumulatorMs >= HELD_INPUT_SAMPLE_MS) {
      heldInputSampleAccumulatorMs -= HELD_INPUT_SAMPLE_MS;
      emitHeldInputState();
    }
  };

  const removeDirectionFromOrder = (direction: Direction): void => {
    const index = directionOrder.indexOf(direction);
    if (index >= 0) {
      directionOrder.splice(index, 1);
    }
  };

  const canDispatchNewIntent = (): boolean =>
    !hasPendingWalkRequest && !config.isMovementLocked();

  const directionHasCommittedFirstStep = new Map<Direction, boolean>();
  let pendingIntentDirection: Direction | null = null;

  const hasSatisfiedFirstStepThreshold = (
    direction: Direction,
    nowMs: number,
  ): boolean => {
    const pressedAtMs = heldDirectionPressedAtMs.get(direction);
    if (pressedAtMs === undefined) {
      return false;
    }
    return nowMs - pressedAtMs >= FIRST_STEP_COMMIT_MS;
  };

  const getDispatchableFirstStepDirection = (
    nowMs: number,
  ): Direction | null => {
    for (let i = directionOrder.length - 1; i >= 0; i -= 1) {
      const direction = directionOrder[i];
      if (!heldDirections.has(direction)) {
        continue;
      }
      const firstStepCommitted =
        directionHasCommittedFirstStep.get(direction) ?? false;
      if (!firstStepCommitted) {
        if (hasSatisfiedFirstStepThreshold(direction, nowMs)) {
          return direction;
        }
      }
    }
    return null;
  };

  const markIntentDispatched = (direction: Direction): void => {
    const firstStepCommitted =
      directionHasCommittedFirstStep.get(direction) ?? false;
    if (!firstStepCommitted) {
      directionHasCommittedFirstStep.set(direction, true);
    }
  };

  const sendIntent = (direction: Direction): void => {
    config.onFacingIntent(direction);
    config.sendWalkInput(direction, movementMode, heldButtons());
    markIntentDispatched(direction);
    hasPendingWalkRequest = true;
  };

  const maybeDispatchIntent = (nowMs: number): void => {
    if (!canDispatchNewIntent()) {
      return;
    }

    if (pendingIntentDirection !== null) {
      const queuedDirection = pendingIntentDirection;
      pendingIntentDirection = null;
      sendIntent(queuedDirection);
      return;
    }

    const firstStepDirection = getDispatchableFirstStepDirection(nowMs);
    if (firstStepDirection !== null) {
      sendIntent(firstStepDirection);
    }
  };

  const hasPendingAcceptedOrDispatchableStep = (nowMs: number): boolean => {
    if (hasPendingWalkRequest) {
      return true;
    }
    if (pendingIntentDirection !== null) {
      return true;
    }
    return getDispatchableFirstStepDirection(nowMs) !== null;
  };

  return {
    handleKeyDown(event: KeyboardEvent): void {
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
      directionHasCommittedFirstStep.set(direction, false);
      removeDirectionFromOrder(direction);
      directionOrder.push(direction);

      if (isFirstPressForDirection) {
        config.onFacingIntent(direction);
      }

      emitHeldInputState();
      maybeDispatchIntent(performance.now());
    },
    setVirtualBHeld(held: boolean): void {
      if (virtualBHeld === held) {
        return;
      }
      virtualBHeld = held;
      if (DEBUG_ACRO_HOP) {
        console.info(
          `[acro-hop][input] virtual B ${held ? "pressed" : "released"}`,
        );
      }
      emitHeldInputState();
    },
    toggleMovementMode(): void {
      movementMode =
        movementMode === MovementMode.WALK
          ? MovementMode.RUN
          : MovementMode.WALK;
    },
    handleKeyUp(event: KeyboardEvent): void {
      const direction = keyToDirection(event.key);
      if (direction === null) {
        return;
      }

      event.preventDefault();
      heldDirections.delete(direction);
      heldDirectionPressedAtMs.delete(direction);
      directionHasCommittedFirstStep.delete(direction);
      removeDirectionFromOrder(direction);
      emitHeldInputState();
    },
    tick(): void {
      const nowMs = performance.now();
      sampleHeldInputForTick(nowMs);
      maybeDispatchIntent(nowMs);
    },
    noteWalkTransitionProgress(normalizedProgress: number): void {
      if (normalizedProgress < LOOKAHEAD_SAMPLE_PROGRESS) {
        return;
      }
      pendingIntentDirection = getActiveHeldDirection();
    },
    markWalkResultReceived(result: WalkResult): void {
      hasPendingWalkRequest = false;
      if (!result.accepted) {
        pendingIntentDirection = null;
      }
      maybeDispatchIntent(performance.now());
    },
    markWalkTransitionCompleted(): void {
      pendingIntentDirection = getActiveHeldDirection();
      maybeDispatchIntent(performance.now());
    },
    hasPendingAcceptedOrDispatchableStep(): boolean {
      return hasPendingAcceptedOrDispatchableStep(performance.now());
    },
    getMovementMode(): MovementMode {
      return movementMode;
    },
    reset(): void {
      hasPendingWalkRequest = false;
      movementMode = MovementMode.WALK;
      virtualBHeld = false;
      heldInputSampleAccumulatorMs = 0;
      lastHeldInputTickAtMs = null;
      localHeldInputTick = 0;
      heldDirections.clear();
      heldDirectionPressedAtMs.clear();
      directionHasCommittedFirstStep.clear();
      pendingIntentDirection = null;
      directionOrder.length = 0;
      config.sendHeldInputState(HeldDpad.NONE, HeldButtons.NONE);
    },
  };
}

export function encodeWalkInput(
  direction: Direction,
  movementMode: MovementMode,
  heldButtons: number,
  inputSeq: number,
  clientTime: bigint,
): Uint8Array {
  const payload = new Uint8Array(15);
  const payloadView = new DataView(payload.buffer);
  payloadView.setUint8(0, direction);
  payloadView.setUint8(1, movementMode);
  payloadView.setUint8(2, heldButtons);
  payloadView.setUint32(3, inputSeq, true);
  payloadView.setBigUint64(7, clientTime, true);

  const frame = new Uint8Array(7 + payload.length);
  const view = new DataView(frame.buffer);
  view.setUint16(0, PROTOCOL_VERSION, true);
  view.setUint8(2, MessageType.WALK_INPUT);
  view.setUint32(3, payload.length, true);
  frame.set(payload, 7);
  return frame;
}

export function encodeHeldInputState(
  heldDpad: number,
  heldButtons: number,
  inputSeq: number,
  clientTime: bigint,
): Uint8Array {
  const payload = new Uint8Array(14);
  const payloadView = new DataView(payload.buffer);
  payloadView.setUint8(0, heldDpad);
  payloadView.setUint8(1, heldButtons);
  payloadView.setUint32(2, inputSeq, true);
  payloadView.setBigUint64(6, clientTime, true);

  const frame = new Uint8Array(7 + payload.length);
  const view = new DataView(frame.buffer);
  view.setUint16(0, PROTOCOL_VERSION, true);
  view.setUint8(2, MessageType.HELD_INPUT_STATE);
  view.setUint32(3, payload.length, true);
  frame.set(payload, 7);
  return frame;
}

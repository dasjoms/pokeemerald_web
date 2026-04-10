import {
  Direction,
  HeldButtons,
  MessageType,
  MovementMode,
  PROTOCOL_VERSION,
  type WalkResult,
} from './protocol_generated';

export type WalkInputController = {
  handleKeyDown: (event: KeyboardEvent) => void;
  handleKeyUp: (event: KeyboardEvent) => void;
  setVirtualBHeld: (held: boolean) => void;
  toggleMovementMode: () => void;
  tick: () => void;
  markWalkResultReceived: (result: WalkResult) => void;
  markWalkTransitionCompleted: () => void;
  hasPendingAcceptedOrDispatchableStep: () => boolean;
  getMovementMode: () => MovementMode;
  reset: () => void;
};

// A directional key press shorter than this threshold is treated as a turn-only tap:
// local facing updates immediately, but no WalkInput is emitted.
const TURN_ONLY_TAP_MS = 90;
const HELD_INPUT_SAMPLE_MS = 1000 / 60;
const DEBUG_ACRO_HOP = true;

export function keyToDirection(key: string): Direction | null {
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
  sendWalkInput: (direction: Direction, movementMode: MovementMode, heldButtons: number) => void;
  sendHeldInputState: (heldDirection: Direction | null, heldButtons: number) => number | null;
  isMovementLocked: () => boolean;
  onFacingIntent: (direction: Direction) => void;
}): WalkInputController {
  const heldDirections = new Set<Direction>();
  const heldDirectionPressedAtMs = new Map<Direction, number>();
  const directionOrder: Direction[] = [];
  let bufferedIntent: Direction | null = null;
  let hasPendingWalkRequest = false;
  let movementMode: MovementMode = MovementMode.WALK;
  let virtualBHeld = false;
  let heldInputSampleAccumulatorMs = 0;
  let lastHeldInputTickAtMs: number | null = null;
  let localHeldInputTick = 0;

  const heldButtons = (): number => (virtualBHeld ? HeldButtons.B : HeldButtons.NONE);

  const getActiveHeldDirection = (): Direction | null => {
    for (let i = directionOrder.length - 1; i >= 0; i -= 1) {
      const direction = directionOrder[i];
      if (heldDirections.has(direction)) {
        return direction;
      }
    }
    return null;
  };

  const emitHeldInputState = (): void => {
    const heldDirection = getActiveHeldDirection();
    const buttons = heldButtons();
    const outboundSeq = config.sendHeldInputState(heldDirection, buttons);
    const localTick = localHeldInputTick;
    localHeldInputTick += 1;
    if (DEBUG_ACRO_HOP) {
      console.info('[acro-hop][input] emit held-state', {
        heldDirection,
        heldButtons: buttons,
        localTick,
        outboundHeldInputSeq: outboundSeq,
      });
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

  const sendIntent = (direction: Direction): void => {
    config.onFacingIntent(direction);
    config.sendWalkInput(
      direction,
      movementMode,
      heldButtons(),
    );
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
        console.info(`[acro-hop][input] virtual B ${held ? 'pressed' : 'released'}`);
      }
      emitHeldInputState();
    },
    toggleMovementMode(): void {
      movementMode =
        movementMode === MovementMode.WALK ? MovementMode.RUN : MovementMode.WALK;
    },
    handleKeyUp(event: KeyboardEvent): void {
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
      emitHeldInputState();
    },
    tick(): void {
      const nowMs = performance.now();
      sampleHeldInputForTick(nowMs);
      maybeDispatchIntent(nowMs);
    },
    markWalkResultReceived(_result: WalkResult): void {
      hasPendingWalkRequest = false;
      maybeDispatchIntent(performance.now());
    },
    markWalkTransitionCompleted(): void {
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
      bufferedIntent = null;
      movementMode = MovementMode.WALK;
      virtualBHeld = false;
      heldInputSampleAccumulatorMs = 0;
      lastHeldInputTickAtMs = null;
      localHeldInputTick = 0;
      heldDirections.clear();
      heldDirectionPressedAtMs.clear();
      directionOrder.length = 0;
      config.sendHeldInputState(null, HeldButtons.NONE);
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
  heldDirection: Direction | null,
  heldButtons: number,
  inputSeq: number,
  clientTime: bigint,
): Uint8Array {
  const payload = new Uint8Array(15);
  const payloadView = new DataView(payload.buffer);
  payloadView.setUint8(0, heldDirection === null ? 0 : 1);
  payloadView.setUint8(1, heldDirection ?? Direction.UP);
  payloadView.setUint8(2, heldButtons);
  payloadView.setUint32(3, inputSeq, true);
  payloadView.setBigUint64(7, clientTime, true);

  const frame = new Uint8Array(7 + payload.length);
  const view = new DataView(frame.buffer);
  view.setUint16(0, PROTOCOL_VERSION, true);
  view.setUint8(2, MessageType.HELD_INPUT_STATE);
  view.setUint32(3, payload.length, true);
  frame.set(payload, 7);
  return frame;
}

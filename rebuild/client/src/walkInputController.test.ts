import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createWalkInputController, TraversalTestMode } from './walkInputController';
import { Direction, MovementMode, RejectionReason, type WalkResult } from './protocol_generated';

function makeKeyboardEvent(key: string, options?: { code?: string; repeat?: boolean }): KeyboardEvent {
  return {
    key,
    code: options?.code ?? key,
    repeat: options?.repeat ?? false,
    preventDefault: vi.fn(),
  } as unknown as KeyboardEvent;
}

function acceptedResult(seq: number): WalkResult {
  return {
    input_seq: seq,
    accepted: true,
    authoritative_pos: { x: seq, y: 0 },
    facing: Direction.RIGHT,
    reason: RejectionReason.NONE,
    server_frame: seq,
  };
}

describe('walk input controller traversal and acro modifier behavior', () => {
  let nowMs = 0;

  beforeEach(() => {
    nowMs = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => nowMs);
  });

  it('cycles traversal test mode in F5 order: ON_FOOT -> MACH -> ACRO -> ON_FOOT', () => {
    const controller = createWalkInputController({
      sendWalkInput: () => {},
      isMovementLocked: () => false,
      onFacingIntent: () => {},
    });

    expect(controller.getTraversalTestMode()).toBe(TraversalTestMode.ON_FOOT);
    controller.cycleTraversalTestMode();
    expect(controller.getTraversalTestMode()).toBe(TraversalTestMode.MACH);
    controller.cycleTraversalTestMode();
    expect(controller.getTraversalTestMode()).toBe(TraversalTestMode.ACRO);
    controller.cycleTraversalTestMode();
    expect(controller.getTraversalTestMode()).toBe(TraversalTestMode.ON_FOOT);
  });

  it('uses Space modifier to emit ACRO_WHEELIE_PREP, ACRO_WHEELIE_MOVE, then BUNNY_HOP', () => {
    const sends: Array<{ direction: Direction; movementMode: MovementMode }> = [];
    const controller = createWalkInputController({
      sendWalkInput: (direction, movementMode) => {
        sends.push({ direction, movementMode });
      },
      isMovementLocked: () => false,
      onFacingIntent: () => {},
    });

    controller.cycleTraversalTestMode();
    controller.cycleTraversalTestMode();
    expect(controller.getTraversalTestMode()).toBe(TraversalTestMode.ACRO);

    const spaceDown = makeKeyboardEvent(' ', { code: 'Space' });
    controller.handleKeyDown(spaceDown);
    expect((spaceDown.preventDefault as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);

    controller.handleKeyDown(makeKeyboardEvent('ArrowRight', { code: 'ArrowRight' }));
    nowMs = 80;
    controller.tick();
    expect(sends[0]).toEqual({
      direction: Direction.RIGHT,
      movementMode: MovementMode.ACRO_WHEELIE_PREP,
    });

    controller.markWalkResultReceived(acceptedResult(1));
    controller.markWalkTransitionCompleted();
    nowMs = 160;
    controller.tick();
    expect(sends[1]).toEqual({
      direction: Direction.RIGHT,
      movementMode: MovementMode.ACRO_WHEELIE_MOVE,
    });

    controller.markWalkResultReceived(acceptedResult(2));
    controller.handleKeyUp(makeKeyboardEvent('ArrowRight', { code: 'ArrowRight' }));
    controller.markWalkTransitionCompleted();
    controller.handleKeyDown(makeKeyboardEvent('ArrowRight', { code: 'ArrowRight' }));
    nowMs = 240;
    controller.tick();
    expect(sends[2]).toEqual({
      direction: Direction.RIGHT,
      movementMode: MovementMode.BUNNY_HOP,
    });

    controller.markWalkResultReceived({
      ...acceptedResult(3),
      accepted: false,
      reason: RejectionReason.BIKE_INVALID_STATE_TRANSITION,
    });
    controller.markWalkTransitionCompleted();
    nowMs = 320;
    controller.tick();
    expect(sends[3]).toEqual({
      direction: Direction.RIGHT,
      movementMode: MovementMode.ACRO_WHEELIE_PREP,
    });

    const spaceUp = makeKeyboardEvent(' ', { code: 'Space' });
    controller.handleKeyUp(spaceUp);
    expect((spaceUp.preventDefault as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
  });

  it('ignores Space for movement mode selection when traversal mode is non-Acro', () => {
    const sends: MovementMode[] = [];
    const controller = createWalkInputController({
      sendWalkInput: (_direction, movementMode) => {
        sends.push(movementMode);
      },
      isMovementLocked: () => false,
      onFacingIntent: () => {},
    });

    controller.handleKeyDown(makeKeyboardEvent(' ', { code: 'Space' }));

    controller.handleKeyDown(makeKeyboardEvent('ArrowUp', { code: 'ArrowUp' }));
    nowMs = 80;
    controller.tick();
    expect(sends[0]).toBe(MovementMode.WALK);

    controller.markWalkResultReceived(acceptedResult(1));
    controller.handleKeyUp(makeKeyboardEvent('ArrowUp', { code: 'ArrowUp' }));
    controller.markWalkTransitionCompleted();
    controller.cycleTraversalTestMode();
    expect(controller.getTraversalTestMode()).toBe(TraversalTestMode.MACH);

    controller.handleKeyDown(makeKeyboardEvent('ArrowUp', { code: 'ArrowUp' }));
    nowMs = 160;
    controller.tick();
    expect(sends[1]).toBe(MovementMode.MACH_BIKE);
  });

  it('resets local acro staging on bike rejection reasons so inputs recover', () => {
    const sends: MovementMode[] = [];
    const controller = createWalkInputController({
      sendWalkInput: (_direction, movementMode) => {
        sends.push(movementMode);
      },
      isMovementLocked: () => false,
      onFacingIntent: () => {},
    });

    controller.cycleTraversalTestMode();
    controller.cycleTraversalTestMode();
    controller.handleKeyDown(makeKeyboardEvent(' ', { code: 'Space' }));
    controller.handleKeyDown(makeKeyboardEvent('ArrowUp', { code: 'ArrowUp' }));

    nowMs = 80;
    controller.tick();
    expect(sends[0]).toBe(MovementMode.ACRO_WHEELIE_PREP);

    controller.markWalkResultReceived(acceptedResult(1));
    controller.markWalkTransitionCompleted();
    nowMs = 160;
    controller.tick();
    expect(sends[1]).toBe(MovementMode.ACRO_WHEELIE_MOVE);

    controller.markWalkResultReceived({
      ...acceptedResult(2),
      accepted: false,
      reason: RejectionReason.BIKE_WHEELIE_WINDOW_EXPIRED,
    });
    controller.markWalkTransitionCompleted();

    nowMs = 240;
    controller.tick();
    expect(sends[2]).toBe(MovementMode.ACRO_WHEELIE_PREP);
  });
});

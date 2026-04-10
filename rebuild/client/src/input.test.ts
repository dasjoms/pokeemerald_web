import { describe, expect, it, vi } from 'vitest';

import { createWalkInputController } from './input';
import { Direction, HeldButtons, MovementMode } from './protocol_generated';

function keyEvent(key: string): KeyboardEvent {
  return {
    key,
    repeat: false,
    preventDefault: () => {},
  } as KeyboardEvent;
}

describe('virtual B parity input mapping', () => {
  it('queues at most one lookahead step from deterministic sampling near completion', () => {
    const sentWalk: Array<{ direction: Direction }> = [];
    const sentFacing: Direction[] = [];
    const nowSpy = vi.spyOn(performance, 'now');
    nowSpy.mockReturnValue(10_000);

    const controller = createWalkInputController({
      sendWalkInput: (direction) => {
        sentWalk.push({ direction });
      },
      sendHeldInputState: () => null,
      isMovementLocked: () => false,
      onFacingIntent: (direction) => {
        sentFacing.push(direction);
      },
    });

    controller.handleKeyDown(keyEvent('ArrowRight'));
    expect(sentFacing).toEqual([Direction.RIGHT]);
    expect(sentWalk).toHaveLength(0);

    nowSpy.mockReturnValue(10_050);
    controller.tick();
    expect(sentWalk).toHaveLength(0);

    nowSpy.mockReturnValue(10_090);
    controller.tick();
    expect(sentWalk).toHaveLength(1);

    controller.noteWalkTransitionProgress(0.5);
    controller.markWalkResultReceived({ accepted: true } as never);
    expect(sentWalk).toHaveLength(1);

    controller.noteWalkTransitionProgress(0.9);
    controller.noteWalkTransitionProgress(0.95);
    controller.markWalkResultReceived({ accepted: true } as never);
    expect(sentWalk).toHaveLength(2);

    controller.noteWalkTransitionProgress(0.9);
    controller.markWalkResultReceived({ accepted: true } as never);
    expect(sentWalk).toHaveLength(3);

    nowSpy.mockRestore();
  });

  it('does not queue a second step when released before lookahead sampling point', () => {
    const sentWalk: Array<{ direction: Direction }> = [];
    const nowSpy = vi.spyOn(performance, 'now');
    nowSpy.mockReturnValue(11_000);

    const controller = createWalkInputController({
      sendWalkInput: (direction) => {
        sentWalk.push({ direction });
      },
      sendHeldInputState: () => null,
      isMovementLocked: () => false,
      onFacingIntent: () => {},
    });

    controller.handleKeyDown(keyEvent('ArrowRight'));
    nowSpy.mockReturnValue(11_090);
    controller.tick();
    expect(sentWalk).toHaveLength(1);

    controller.handleKeyUp(keyEvent('ArrowRight'));
    controller.noteWalkTransitionProgress(0.9);
    controller.markWalkResultReceived({ accepted: true } as never);
    expect(sentWalk).toHaveLength(1);

    nowSpy.mockRestore();
  });

  it('does not emit a walk intent when direction is released before first-step threshold', () => {
    const sentWalk: Array<{ direction: Direction }> = [];
    const nowSpy = vi.spyOn(performance, 'now');
    nowSpy.mockReturnValue(20_000);

    const controller = createWalkInputController({
      sendWalkInput: (direction) => {
        sentWalk.push({ direction });
      },
      sendHeldInputState: () => null,
      isMovementLocked: () => false,
      onFacingIntent: () => {},
    });

    controller.handleKeyDown(keyEvent('ArrowUp'));
    nowSpy.mockReturnValue(20_060);
    controller.handleKeyUp(keyEvent('ArrowUp'));
    nowSpy.mockReturnValue(20_120);
    controller.tick();

    expect(sentWalk).toHaveLength(0);
    nowSpy.mockRestore();
  });

  it('maps C-key virtual hold to HeldButtons.B in outbound walk input', () => {
    const sent: Array<{ direction: Direction; movementMode: MovementMode; heldButtons: number }> =
      [];
    const nowSpy = vi.spyOn(performance, 'now');
    nowSpy.mockReturnValue(1_000);

    const controller = createWalkInputController({
      sendWalkInput: (direction, movementMode, heldButtons) => {
        sent.push({ direction, movementMode, heldButtons });
      },
      sendHeldInputState: () => null,
      isMovementLocked: () => false,
      onFacingIntent: () => {},
    });

    controller.setVirtualBHeld(true);
    controller.handleKeyDown(keyEvent('ArrowRight'));
    nowSpy.mockReturnValue(1_100);
    controller.tick();

    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual({
      direction: Direction.RIGHT,
      movementMode: MovementMode.WALK,
      heldButtons: HeldButtons.B,
    });

    nowSpy.mockRestore();
  });

  it('clearing virtual B hold emits HeldButtons.NONE', () => {
    const sent: Array<{ heldButtons: number }> = [];
    const nowSpy = vi.spyOn(performance, 'now');
    nowSpy.mockReturnValue(2_000);

    const controller = createWalkInputController({
      sendWalkInput: (_direction, _movementMode, heldButtons) => {
        sent.push({ heldButtons });
      },
      sendHeldInputState: () => null,
      isMovementLocked: () => false,
      onFacingIntent: () => {},
    });

    controller.setVirtualBHeld(false);
    controller.handleKeyDown(keyEvent('ArrowUp'));
    nowSpy.mockReturnValue(2_100);
    controller.tick();

    expect(sent).toHaveLength(1);
    expect(sent[0].heldButtons).toBe(HeldButtons.NONE);

    nowSpy.mockRestore();
  });

  it('samples held C+direction every tick before turn-tap threshold for authoritative side jumps', () => {
    const sentHeld: Array<{ heldDirection: Direction | null; heldButtons: number }> = [];
    const sentWalk: Array<{ direction: Direction }> = [];
    const nowSpy = vi.spyOn(performance, 'now');
    nowSpy.mockReturnValue(3_000);

    const controller = createWalkInputController({
      sendWalkInput: (direction) => {
        sentWalk.push({ direction });
      },
      sendHeldInputState: (heldDirection, heldButtons) => {
        sentHeld.push({ heldDirection, heldButtons });
        return sentHeld.length - 1;
      },
      isMovementLocked: () => false,
      onFacingIntent: () => {},
    });

    controller.setVirtualBHeld(true);
    controller.handleKeyDown(keyEvent('ArrowRight'));

    for (let i = 1; i <= 4; i += 1) {
      nowSpy.mockReturnValue(3_000 + i * 16);
      controller.tick();
    }

    expect(sentHeld).toContainEqual({
      heldDirection: Direction.RIGHT,
      heldButtons: HeldButtons.B,
    });
    expect(sentWalk).toHaveLength(0);

    nowSpy.mockRestore();
  });

  it('samples held C+opposite-direction every tick before turn-tap threshold for authoritative turn jumps', () => {
    const sentHeld: Array<{ heldDirection: Direction | null; heldButtons: number }> = [];
    const sentWalk: Array<{ direction: Direction }> = [];
    const nowSpy = vi.spyOn(performance, 'now');
    nowSpy.mockReturnValue(4_000);

    const controller = createWalkInputController({
      sendWalkInput: (direction) => {
        sentWalk.push({ direction });
      },
      sendHeldInputState: (heldDirection, heldButtons) => {
        sentHeld.push({ heldDirection, heldButtons });
        return sentHeld.length - 1;
      },
      isMovementLocked: () => false,
      onFacingIntent: () => {},
    });

    controller.setVirtualBHeld(true);
    controller.handleKeyDown(keyEvent('ArrowLeft'));

    for (let i = 1; i <= 4; i += 1) {
      nowSpy.mockReturnValue(4_000 + i * 16);
      controller.tick();
    }

    expect(sentHeld).toContainEqual({
      heldDirection: Direction.LEFT,
      heldButtons: HeldButtons.B,
    });
    expect(sentWalk).toHaveLength(0);

    nowSpy.mockRestore();
  });
});

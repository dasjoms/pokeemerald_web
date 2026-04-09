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
  it('maps C-key virtual hold to HeldButtons.B in outbound walk input', () => {
    const sent: Array<{ direction: Direction; movementMode: MovementMode; heldButtons: number }> =
      [];
    const nowSpy = vi.spyOn(performance, 'now');
    nowSpy.mockReturnValue(1_000);

    const controller = createWalkInputController({
      sendWalkInput: (direction, movementMode, heldButtons) => {
        sent.push({ direction, movementMode, heldButtons });
      },
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
});

import { describe, expect, it } from 'vitest';
import { CAMERA_METATILE_BUFFER_DIM } from './cameraTilemap';
import { computeEnteringCameraSliceSlots } from './cameraWindowRingMapping';

describe('camera window ring mapping', () => {
  it('maps newly revealed slices to stable logical slots across a down-right-left path', () => {
    const bufferDim = CAMERA_METATILE_BUFFER_DIM;
    const downSteps = 3;
    let originX = 120;
    let originY = 240;

    for (let step = 0; step < downSteps; step += 1) {
      originY += 1;
      const slots = computeEnteringCameraSliceSlots({
        stepX: 0,
        stepY: 1,
        windowOriginTileX: originX,
        windowOriginTileY: originY,
        bufferDim,
      });
      expect(slots).toHaveLength(bufferDim);
      expect(slots[0]).toEqual({
        slotX: 0,
        slotY: bufferDim - 1,
        worldTileX: originX,
        worldTileY: originY + bufferDim - 1,
      });
      expect(slots[bufferDim - 1]).toEqual({
        slotX: bufferDim - 1,
        slotY: bufferDim - 1,
        worldTileX: originX + bufferDim - 1,
        worldTileY: originY + bufferDim - 1,
      });
    }

    originX += 1;
    const rightSlots = computeEnteringCameraSliceSlots({
      stepX: 1,
      stepY: 0,
      windowOriginTileX: originX,
      windowOriginTileY: originY,
      bufferDim,
    });
    expect(rightSlots).toHaveLength(bufferDim);
    expect(rightSlots[0]).toEqual({
      slotX: bufferDim - 1,
      slotY: 0,
      worldTileX: originX + bufferDim - 1,
      worldTileY: originY,
    });
    expect(rightSlots[bufferDim - 1]).toEqual({
      slotX: bufferDim - 1,
      slotY: bufferDim - 1,
      worldTileX: originX + bufferDim - 1,
      worldTileY: originY + bufferDim - 1,
    });

    originX -= 1;
    const leftSlots = computeEnteringCameraSliceSlots({
      stepX: -1,
      stepY: 0,
      windowOriginTileX: originX,
      windowOriginTileY: originY,
      bufferDim,
    });
    expect(leftSlots).toHaveLength(bufferDim);
    expect(leftSlots[0]).toEqual({
      slotX: 0,
      slotY: 0,
      worldTileX: originX,
      worldTileY: originY,
    });
    expect(leftSlots[bufferDim - 1]).toEqual({
      slotX: 0,
      slotY: bufferDim - 1,
      worldTileX: originX,
      worldTileY: originY + bufferDim - 1,
    });
  });
});

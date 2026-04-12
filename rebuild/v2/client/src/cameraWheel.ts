import { wrap32 } from "./tileWheel32";

const METATILE_STEP_SUBTILES = 2;
const REDRAW_OPPOSITE_EDGE_OFFSET = 28;

export type CameraWheelState = {
  cameraPosX: number;
  cameraPosY: number;
  xTileOffset: number;
  yTileOffset: number;
};

export type StripRedrawSample = {
  destX: number;
  destY: number;
  worldX: number;
  worldY: number;
};

export function applyMetatileStep(state: CameraWheelState, deltaX: number, deltaY: number): StripRedrawSample[] {
  if (deltaX === 0 && deltaY === 0) {
    return [];
  }

  // Emerald order: update camera position first.
  state.cameraPosX += deltaX;
  state.cameraPosY += deltaY;

  // Then AddCameraTileOffset(delta * 2) in subtile units.
  state.xTileOffset = wrap32(state.xTileOffset + deltaX * METATILE_STEP_SUBTILES);
  state.yTileOffset = wrap32(state.yTileOffset + deltaY * METATILE_STEP_SUBTILES);

  const strip: StripRedrawSample[] = [];
  if (deltaX !== 0) {
    const destX = deltaX > 0 ? wrap32(state.xTileOffset + REDRAW_OPPOSITE_EDGE_OFFSET) : state.xTileOffset;
    const worldX = deltaX > 0 ? state.cameraPosX + 14 : state.cameraPosX;
    for (let i = 0; i <= 30; i += 2) {
      strip.push({
        destX,
        destY: wrap32(state.yTileOffset + i),
        worldX,
        worldY: state.cameraPosY + i / METATILE_STEP_SUBTILES
      });
    }
  }

  if (deltaY !== 0) {
    const destY = deltaY > 0 ? wrap32(state.yTileOffset + REDRAW_OPPOSITE_EDGE_OFFSET) : state.yTileOffset;
    const worldY = deltaY > 0 ? state.cameraPosY + 14 : state.cameraPosY;
    for (let i = 0; i <= 30; i += 2) {
      strip.push({
        destX: wrap32(state.xTileOffset + i),
        destY,
        worldX: state.cameraPosX + i / METATILE_STEP_SUBTILES,
        worldY
      });
    }
  }

  return strip;
}

export function runCameraWheelFixtures(): void {
  const north: CameraWheelState = { cameraPosX: 100, cameraPosY: 200, xTileOffset: 6, yTileOffset: 10 };
  const northStrip = applyMetatileStep(north, 0, 1);
  expectEqual(north.yTileOffset, 12, "north.yTileOffset");
  expectEqual(northStrip.length, 16, "north.strip.length");
  expectSample(northStrip[0], { destX: 6, destY: 8, worldX: 100, worldY: 215 }, "north.strip.first");
  expectSample(northStrip[15], { destX: 4, destY: 8, worldX: 115, worldY: 215 }, "north.strip.last");

  const west: CameraWheelState = { cameraPosX: 40, cameraPosY: 20, xTileOffset: 30, yTileOffset: 0 };
  const westStrip = applyMetatileStep(west, 1, 0);
  expectEqual(west.xTileOffset, 0, "west.xTileOffset");
  expectSample(westStrip[0], { destX: 28, destY: 0, worldX: 55, worldY: 20 }, "west.strip.first");
  expectSample(westStrip[15], { destX: 28, destY: 30, worldX: 55, worldY: 35 }, "west.strip.last");

  const wrap: CameraWheelState = { cameraPosX: 4, cameraPosY: 5, xTileOffset: 31, yTileOffset: 0 };
  applyMetatileStep(wrap, 1, -1);
  expectEqual(wrap.xTileOffset, 1, "wrap.xTileOffset");
  expectEqual(wrap.yTileOffset, 30, "wrap.yTileOffset");
}

function expectEqual(actual: number, expected: number, label: string): void {
  if (actual !== expected) {
    throw new Error(`[camera-wheel-fixture] ${label}: expected ${expected}, got ${actual}`);
  }
}

function expectSample(actual: StripRedrawSample, expected: StripRedrawSample, label: string): void {
  if (
    actual.destX !== expected.destX ||
    actual.destY !== expected.destY ||
    actual.worldX !== expected.worldX ||
    actual.worldY !== expected.worldY
  ) {
    throw new Error(`[camera-wheel-fixture] ${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

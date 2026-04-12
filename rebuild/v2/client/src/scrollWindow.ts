import { wrap32, WHEEL_SIZE } from "./tileWheel32";

export const SUBTILE_SIZE = 8;
export const VIEWPORT_WIDTH = 240;
export const VIEWPORT_HEIGHT = 160;
export const VISIBLE_SUBTILES_X = VIEWPORT_WIDTH / SUBTILE_SIZE;
export const VISIBLE_SUBTILES_Y = VIEWPORT_HEIGHT / SUBTILE_SIZE;

export type BgScrollInputs = {
  xPixelOffset: number;
  yPixelOffset: number;
  horizontalPan: number;
  verticalPan: number;
};

export type BgScrollWindow = {
  hofs: number;
  vofs: number;
  tileOriginX: number;
  tileOriginY: number;
  fineX: number;
  fineY: number;
};

export function computeBgScrollWindow(input: BgScrollInputs): BgScrollWindow {
  const hofs = input.xPixelOffset + input.horizontalPan;
  const vofs = input.yPixelOffset + input.verticalPan + 8;
  return {
    hofs,
    vofs,
    tileOriginX: wrap32(Math.floor(hofs / SUBTILE_SIZE)),
    tileOriginY: wrap32(Math.floor(vofs / SUBTILE_SIZE)),
    fineX: hofs & 7,
    fineY: vofs & 7
  };
}

export function visibleSubtileRange(start: number, count: number): number[] {
  const values: number[] = [];
  for (let i = 0; i < count; i += 1) {
    values.push(wrap32(start + i));
  }
  return values;
}

export function runScrollWindowFixtures(): void {
  const fixtureA = computeBgScrollWindow({
    xPixelOffset: 3,
    yPixelOffset: 10,
    horizontalPan: 4,
    verticalPan: 2
  });

  expectEqual(fixtureA.hofs, 7, "fixtureA.hofs");
  expectEqual(fixtureA.vofs, 20, "fixtureA.vofs");
  expectEqual(fixtureA.tileOriginX, 0, "fixtureA.tileOriginX");
  expectEqual(fixtureA.tileOriginY, 2, "fixtureA.tileOriginY");
  expectEqual(fixtureA.fineX, 7, "fixtureA.fineX");
  expectEqual(fixtureA.fineY, 4, "fixtureA.fineY");

  const xRange = visibleSubtileRange(fixtureA.tileOriginX, VISIBLE_SUBTILES_X);
  const yRange = visibleSubtileRange(fixtureA.tileOriginY, VISIBLE_SUBTILES_Y);
  expectEqual(xRange[0], 0, "fixtureA.xRange.start");
  expectEqual(xRange.at(-1), 29, "fixtureA.xRange.end");
  expectEqual(yRange[0], 2, "fixtureA.yRange.start");
  expectEqual(yRange.at(-1), 21, "fixtureA.yRange.end");

  const fixtureB = computeBgScrollWindow({
    xPixelOffset: 252,
    yPixelOffset: 241,
    horizontalPan: 3,
    verticalPan: 7
  });

  expectEqual(fixtureB.hofs, 255, "fixtureB.hofs");
  expectEqual(fixtureB.vofs, 256, "fixtureB.vofs");
  expectEqual(fixtureB.tileOriginX, 31, "fixtureB.tileOriginX");
  expectEqual(fixtureB.tileOriginY, 0, "fixtureB.tileOriginY");
  expectEqual(fixtureB.fineX, 7, "fixtureB.fineX");
  expectEqual(fixtureB.fineY, 0, "fixtureB.fineY");

  const wrappedXRange = visibleSubtileRange(fixtureB.tileOriginX, VISIBLE_SUBTILES_X);
  expectEqual(wrappedXRange[0], 31, "fixtureB.xRange.start");
  expectEqual(wrappedXRange[1], 0, "fixtureB.xRange.wrap");
  expectEqual(wrappedXRange.at(-1), 28, "fixtureB.xRange.end");

  expectEqual(VISIBLE_SUBTILES_X, 30, "visible_subtiles_x");
  expectEqual(VISIBLE_SUBTILES_Y, 20, "visible_subtiles_y");
  expectEqual(WHEEL_SIZE, 32, "wheel_size");
}

function expectEqual(actual: number | undefined, expected: number, label: string): void {
  if (actual !== expected) {
    throw new Error(`[scroll-window-fixture] ${label}: expected ${expected}, got ${String(actual)}`);
  }
}

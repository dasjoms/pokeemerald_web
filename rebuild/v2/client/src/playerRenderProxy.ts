import type { BgScrollInputs } from "./scrollWindow";

export type PlayerRenderProxy = {
  mapLocalX: number;
  mapLocalY: number;
  subpixelX: number;
  subpixelY: number;
  cameraPosX: number;
  cameraPosY: number;
  xTileOffset: number;
  yTileOffset: number;
};

export type PlayerRenderProxyScreenPosition = {
  wheelPxX: number;
  wheelPxY: number;
  hofs: number;
  vofs: number;
  screenX: number;
  screenY: number;
};

export function computePlayerRenderProxyScreenPosition(
  proxy: PlayerRenderProxy,
  scroll: BgScrollInputs
): PlayerRenderProxyScreenPosition {
  const wheelPxX = wrap256(
    proxy.xTileOffset * 8 + (proxy.mapLocalX - proxy.cameraPosX) * 16 + proxy.subpixelX
  );
  const wheelPxY = wrap256(
    proxy.yTileOffset * 8 + (proxy.mapLocalY - proxy.cameraPosY) * 16 + proxy.subpixelY
  );

  const hofs = scroll.xPixelOffset + scroll.horizontalPan;
  const vofs = scroll.yPixelOffset + scroll.verticalPan + 8;

  return {
    wheelPxX,
    wheelPxY,
    hofs,
    vofs,
    screenX: wrap256(wheelPxX - hofs),
    screenY: wrap256(wheelPxY - vofs)
  };
}

export function runPlayerRenderProxyFixtures(): void {
  const stationary = computePlayerRenderProxyScreenPosition(
    {
      mapLocalX: 10,
      mapLocalY: 1,
      subpixelX: 0,
      subpixelY: 0,
      cameraPosX: 10,
      cameraPosY: 1,
      xTileOffset: 0,
      yTileOffset: 0
    },
    {
      xPixelOffset: 0,
      yPixelOffset: 0,
      horizontalPan: 0,
      verticalPan: 32
    }
  );
  expectEqual(stationary.screenX, 0, "stationary.screenX");
  expectEqual(stationary.screenY, 216, "stationary.screenY");

  const eastWalkPositions: number[] = [];
  for (let tick = 0; tick < 16; tick += 1) {
    eastWalkPositions.push(
      computePlayerRenderProxyScreenPosition(
        {
          mapLocalX: 10,
          mapLocalY: 1,
          subpixelX: tick,
          subpixelY: 0,
          cameraPosX: 10,
          cameraPosY: 1,
          xTileOffset: 0,
          yTileOffset: 0
        },
        {
          xPixelOffset: 0,
          yPixelOffset: 0,
          horizontalPan: 0,
          verticalPan: 32
        }
      ).screenX
    );
  }
  for (let tick = 1; tick < eastWalkPositions.length; tick += 1) {
    expectEqual(eastWalkPositions[tick], eastWalkPositions[tick - 1] + 1, `eastWalk.tick.${tick}`);
  }

  const wrapCaseRawSum = 30 * 8 + (11 - 10) * 16 + 15;
  expectEqual(wrapCaseRawSum, 271, "wrapCase.rawSum");

  const wrapCase = computePlayerRenderProxyScreenPosition(
    {
      mapLocalX: 11,
      mapLocalY: 1,
      subpixelX: 15,
      subpixelY: 0,
      cameraPosX: 10,
      cameraPosY: 1,
      xTileOffset: 30,
      yTileOffset: 0
    },
    {
      xPixelOffset: 0,
      yPixelOffset: 0,
      horizontalPan: 0,
      verticalPan: 32
    }
  );
  expectEqual(wrapCase.wheelPxX, 15, "wrapCase.wheelPxX");
  expectEqual(wrapCase.screenX, 15, "wrapCase.screenX");
  const wrapCaseNext = computePlayerRenderProxyScreenPosition(
    {
      mapLocalX: 12,
      mapLocalY: 1,
      subpixelX: 0,
      subpixelY: 0,
      cameraPosX: 10,
      cameraPosY: 1,
      xTileOffset: 28,
      yTileOffset: 0
    },
    {
      xPixelOffset: 0,
      yPixelOffset: 0,
      horizontalPan: 0,
      verticalPan: 32
    }
  );
  expectEqual(wrapCaseNext.wheelPxX, 0, "wrapCaseNext.wheelPxX");
  expectEqual(wrapCaseNext.screenX, 0, "wrapCaseNext.screenX");

  const vofsBaseline = computePlayerRenderProxyScreenPosition(
    {
      mapLocalX: 10,
      mapLocalY: 1,
      subpixelX: 0,
      subpixelY: 0,
      cameraPosX: 10,
      cameraPosY: 1,
      xTileOffset: 0,
      yTileOffset: 0
    },
    {
      xPixelOffset: 0,
      yPixelOffset: 0,
      horizontalPan: 0,
      verticalPan: 0
    }
  );
  const vofsWithPlusEight = computePlayerRenderProxyScreenPosition(
    {
      mapLocalX: 10,
      mapLocalY: 1,
      subpixelX: 0,
      subpixelY: 0,
      cameraPosX: 10,
      cameraPosY: 1,
      xTileOffset: 0,
      yTileOffset: 0
    },
    {
      xPixelOffset: 0,
      yPixelOffset: 0,
      horizontalPan: 0,
      verticalPan: 8
    }
  );
  expectEqual(vofsBaseline.screenY, 248, "vofsBaseline.screenY");
  expectEqual(vofsWithPlusEight.screenY, 240, "vofsWithPlusEight.screenY");
}

function wrap256(value: number): number {
  return ((value % 256) + 256) % 256;
}

function expectEqual(actual: number, expected: number, label: string): void {
  if (actual !== expected) {
    throw new Error(`[player-render-proxy-fixture] ${label}: expected ${expected}, got ${actual}`);
  }
}

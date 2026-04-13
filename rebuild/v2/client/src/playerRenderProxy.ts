export type RenderPositionContract = {
  frameId: number;
  playerMapPixelX: number;
  playerMapPixelY: number;
  wheelPixelX: number;
  wheelPixelY: number;
  hofs: number;
  vofs: number;
};

export type PlayerRenderProxyScreenPosition = {
  frameId: number;
  wheelPxX: number;
  wheelPxY: number;
  hofs: number;
  vofs: number;
  screenX: number;
  screenY: number;
};

export function computePlayerRenderProxyScreenPosition(
  renderPosition: RenderPositionContract
): PlayerRenderProxyScreenPosition {
  const wheelPxX = wrap256(renderPosition.wheelPixelX);
  const wheelPxY = wrap256(renderPosition.wheelPixelY);

  return {
    frameId: renderPosition.frameId,
    wheelPxX,
    wheelPxY,
    hofs: renderPosition.hofs,
    vofs: renderPosition.vofs,
    screenX: wrap256(wheelPxX - renderPosition.hofs),
    screenY: wrap256(wheelPxY - renderPosition.vofs)
  };
}

type TraceFrame = {
  label: string;
  contract: RenderPositionContract;
};

const TRACE_FRAMES: TraceFrame[] = [
  { label: "stationary", contract: { frameId: 0, playerMapPixelX: 160, playerMapPixelY: 16, wheelPixelX: 0, wheelPixelY: 0, hofs: 0, vofs: 40 } },
  ...Array.from({ length: 16 }, (_, idx) => ({
    label: `east_walk_${idx + 1}`,
    contract: {
      frameId: idx + 1,
      playerMapPixelX: 160 + (idx + 1),
      playerMapPixelY: 16,
      wheelPixelX: idx + 1,
      wheelPixelY: 0,
      hofs: 0,
      vofs: 40
    }
  })),
  {
    label: "boundary_cross",
    contract: { frameId: 17, playerMapPixelX: 176, playerMapPixelY: 16, wheelPixelX: 271, wheelPixelY: 0, hofs: 0, vofs: 40 }
  },
  {
    label: "boundary_cross_next",
    contract: { frameId: 18, playerMapPixelX: 177, playerMapPixelY: 16, wheelPixelX: 272, wheelPixelY: 0, hofs: 0, vofs: 40 }
  }
];

export function runPlayerRenderProxyFixtures(): void {
  const computed = TRACE_FRAMES.map((frame) => ({ label: frame.label, value: computePlayerRenderProxyScreenPosition(frame.contract) }));

  expectEqual(computed[0].value.screenX, 0, "stationary.screenX");
  expectEqual(computed[0].value.screenY, 216, "stationary.screenY");

  for (let i = 1; i <= 16; i += 1) {
    const delta = wrapDelta(computed[i - 1].value.screenX, computed[i].value.screenX);
    expectEqual(delta, 1, `${computed[i].label}.deltaX`);
  }

  const boundary = computed.find((frame) => frame.label === "boundary_cross");
  const next = computed.find((frame) => frame.label === "boundary_cross_next");
  if (!boundary || !next) {
    throw new Error("[player-render-proxy-fixture] missing boundary fixtures");
  }

  const beforeBoundary = computed[16];
  expectEqual(wrapDelta(beforeBoundary.value.screenX, boundary.value.screenX), 1, "boundary.deltaX");
  expectEqual(wrapDelta(boundary.value.screenX, next.value.screenX), 1, "boundary.next.deltaX");

  for (const frame of computed) {
    expectEqual(frame.value.screenX, wrap256(frame.value.wheelPxX - frame.value.hofs), `${frame.label}.relation.x`);
    expectEqual(frame.value.screenY, wrap256(frame.value.wheelPxY - frame.value.vofs), `${frame.label}.relation.y`);
  }
}

function wrapDelta(previous: number, current: number): number {
  return wrap256(current - previous);
}

function wrap256(value: number): number {
  return ((value % 256) + 256) % 256;
}

function expectEqual(actual: number, expected: number, label: string): void {
  if (actual !== expected) {
    throw new Error(`[player-render-proxy-fixture] ${label}: expected ${expected}, got ${actual}`);
  }
}

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
  { label: "spawn_anchor", contract: { frameId: 0, playerMapPixelX: 160, playerMapPixelY: 16, wheelPixelX: 112, wheelPixelY: 40, hofs: 0, vofs: 40 } },
  ...Array.from({ length: 16 }, (_, idx) => ({
    label: `east_walk_${idx + 1}`,
    contract: {
      frameId: idx + 1,
      playerMapPixelX: 160 + (idx + 1),
      playerMapPixelY: 16,
      wheelPixelX: 112 + (idx + 1),
      wheelPixelY: 40,
      hofs: idx + 1,
      vofs: 40
    }
  })),
  {
    label: "boundary_cross",
    contract: { frameId: 17, playerMapPixelX: 176, playerMapPixelY: 16, wheelPixelX: 128, wheelPixelY: 40, hofs: 16, vofs: 40 }
  },
  {
    label: "boundary_cross_next",
    contract: { frameId: 18, playerMapPixelX: 177, playerMapPixelY: 16, wheelPixelX: 129, wheelPixelY: 40, hofs: 17, vofs: 40 }
  }
];

export function runPlayerRenderProxyFixtures(): void {
  const computed = TRACE_FRAMES.map((frame) => ({ label: frame.label, value: computePlayerRenderProxyScreenPosition(frame.contract) }));

  expectEqual(computed[0].value.screenX, 112, "spawn_anchor.screenX");
  expectEqual(computed[0].value.screenY, 0, "spawn_anchor.screenY");

  for (let i = 1; i <= 16; i += 1) {
    expectEqual(computed[i].value.screenX, 112, `${computed[i].label}.screenX`);
  }

  const boundary = computed.find((frame) => frame.label === "boundary_cross");
  const next = computed.find((frame) => frame.label === "boundary_cross_next");
  if (!boundary || !next) {
    throw new Error("[player-render-proxy-fixture] missing boundary fixtures");
  }

  const beforeBoundary = computed[16];
  expectEqual(beforeBoundary.value.screenX, 112, "east_walk_16.screenX");
  expectEqual(boundary.value.screenX, 112, "boundary.screenX");
  expectEqual(next.value.screenX, 112, "boundary_next.screenX");

  for (const frame of computed) {
    expectEqual(frame.value.screenX, wrap256(frame.value.wheelPxX - frame.value.hofs), `${frame.label}.relation.x`);
    expectEqual(frame.value.screenY, wrap256(frame.value.wheelPxY - frame.value.vofs), `${frame.label}.relation.y`);
  }
}

function wrap256(value: number): number {
  return ((value % 256) + 256) % 256;
}

function expectEqual(actual: number, expected: number, label: string): void {
  if (actual !== expected) {
    throw new Error(`[player-render-proxy-fixture] ${label}: expected ${expected}, got ${actual}`);
  }
}

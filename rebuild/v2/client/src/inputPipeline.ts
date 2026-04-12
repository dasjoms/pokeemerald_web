const DPAD_UP = 1 << 0;
const DPAD_DOWN = 1 << 1;
const DPAD_LEFT = 1 << 2;
const DPAD_RIGHT = 1 << 3;

export type DpadDirection = "NORTH" | "SOUTH" | "WEST" | "EAST" | "NONE";

export type InputFrame = {
  heldKeys: number;
  newKeys: number;
  resolvedDirection: DpadDirection;
};

export class InputPipeline {
  private readonly heldCodes = new Set<string>();
  private previousHeldMask = 0;

  handleKeyDown(code: string): void {
    if (!isTrackedCode(code)) {
      return;
    }
    this.heldCodes.add(code);
  }

  handleKeyUp(code: string): void {
    if (!isTrackedCode(code)) {
      return;
    }
    this.heldCodes.delete(code);
  }

  synthesizeFrame(): InputFrame {
    const heldKeys = synthesizeHeldMask(this.heldCodes);
    const newKeys = heldKeys & ~this.previousHeldMask;
    this.previousHeldMask = heldKeys;
    return {
      heldKeys,
      newKeys,
      resolvedDirection: resolveDirection(heldKeys)
    };
  }
}

export function resolveDirection(heldKeys: number): DpadDirection {
  // Emerald parity: resolve in strict priority order Up > Down > Left > Right.
  // This intentionally means Up+Down => NORTH and Left+Right => WEST when vertical is not held.
  if (heldKeys & DPAD_UP) {
    return "NORTH";
  }
  if (heldKeys & DPAD_DOWN) {
    return "SOUTH";
  }
  if (heldKeys & DPAD_LEFT) {
    return "WEST";
  }
  if (heldKeys & DPAD_RIGHT) {
    return "EAST";
  }
  return "NONE";
}

function synthesizeHeldMask(codes: Set<string>): number {
  let held = 0;
  if (codes.has("ArrowUp") || codes.has("KeyW")) {
    held |= DPAD_UP;
  }
  if (codes.has("ArrowDown") || codes.has("KeyS")) {
    held |= DPAD_DOWN;
  }
  if (codes.has("ArrowLeft") || codes.has("KeyA")) {
    held |= DPAD_LEFT;
  }
  if (codes.has("ArrowRight") || codes.has("KeyD")) {
    held |= DPAD_RIGHT;
  }
  return held;
}

function isTrackedCode(code: string): boolean {
  return (
    code === "ArrowUp" ||
    code === "ArrowDown" ||
    code === "ArrowLeft" ||
    code === "ArrowRight" ||
    code === "KeyW" ||
    code === "KeyA" ||
    code === "KeyS" ||
    code === "KeyD"
  );
}

export function runInputPipelineFixtures(): void {
  const dirs: Array<[string, string, DpadDirection]> = [
    ["ArrowUp", "KeyW", "NORTH"],
    ["ArrowDown", "KeyS", "SOUTH"],
    ["ArrowLeft", "KeyA", "WEST"],
    ["ArrowRight", "KeyD", "EAST"]
  ];

  for (const [arrow, wasd, expected] of dirs) {
    const fromArrow = new InputPipeline();
    fromArrow.handleKeyDown(arrow);
    const arrowFrame = fromArrow.synthesizeFrame();

    const fromWasd = new InputPipeline();
    fromWasd.handleKeyDown(wasd);
    const wasdFrame = fromWasd.synthesizeFrame();

    assert(arrowFrame.heldKeys === wasdFrame.heldKeys, `${arrow} and ${wasd} should map to same held mask`);
    assert(arrowFrame.resolvedDirection === expected, `${arrow} should resolve to ${expected}`);
    assert(wasdFrame.resolvedDirection === expected, `${wasd} should resolve to ${expected}`);
  }

  assert(resolveDirection(DPAD_UP | DPAD_DOWN) === "NORTH", "up+down should resolve NORTH by priority");
  assert(resolveDirection(DPAD_LEFT | DPAD_RIGHT) === "WEST", "left+right should resolve WEST without vertical input");

  const hold = new InputPipeline();
  hold.handleKeyDown("ArrowRight");
  const first = hold.synthesizeFrame();
  const second = hold.synthesizeFrame();
  assert(first.newKeys === DPAD_RIGHT, "first hold frame should have newKeys edge");
  assert(second.newKeys === 0, "subsequent hold frame should clear newKeys");

  const centerSwitch = new InputPipeline();
  centerSwitch.handleKeyDown("ArrowRight");
  centerSwitch.synthesizeFrame();
  centerSwitch.handleKeyUp("ArrowRight");
  centerSwitch.handleKeyDown("ArrowUp");
  const switchFrame = centerSwitch.synthesizeFrame();
  assert(switchFrame.resolvedDirection === "NORTH", "direction switch should apply on next eligible frame");
}

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`inputPipeline fixture failed: ${message}`);
  }
}

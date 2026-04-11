import { readFileSync } from 'node:fs';

import { beforeAll, describe, expect, it, vi } from 'vitest';

import { BikeTransitionType, Direction, TraversalState } from './protocol_generated';

type FixtureDirection = 'UP' | 'DOWN' | 'LEFT' | 'RIGHT';
type FixtureAction = 'set_idle' | 'start_walk' | 'start_run';

type ParityFixture = {
  tick_ms: number;
  scenarios: ParityScenario[];
};

type ParityScenario = {
  name: string;
  events: ParityEvent[];
  expected: Array<{
    anim_id: string;
    frame_index: number;
    stride_phase: 0 | 1;
  }>;
};

type ParityEvent = {
  tick: number;
  action: FixtureAction;
  direction: FixtureDirection;
};

type PlayerAnimationDebugState = {
  animId: string;
  frameIndex: number;
  stridePhase: 0 | 1;
};

type PlayerAnimationAssets = {
  avatarId: string;
  frameWidth: number;
  frameHeight: number;
  anchorX: number;
  anchorY: number;
  paletteColors: string[];
  reflectionPaletteColors: string[] | null;
  reflectionPaletteSourcePath: string | null;
  animationSets: Record<
    string,
    {
      anim_table_symbol: string;
      actions: Record<
        string,
        Record<string, {
          action_id?: string;
          anim_cmd_symbol: string;
          loop_mode?: 'loop' | 'end_hold';
          frames: Array<{ duration: number; frame: number; h_flip: boolean }>;
        }>
        
      >;
    }
  >;
  frameTextures: Map<number, unknown>;
};

type PlayerAnimationControllerCtor = new (assets: PlayerAnimationAssets) => {
  setFacing: (direction: Direction) => void;
  setTraversalState: (state: {
    traversalState: TraversalState;
    machSpeedStage?: number;
    bikeTransition?: BikeTransitionType;
  }) => void;
  stopMoving: (direction: Direction) => void;
  applyPendingModeChanges: () => void;
  startWalkStep: (direction: Direction) => void;
  startRunStep: (direction: Direction) => void;
  startStep: (direction: Direction, mode: 'walk' | 'run') => void;
  getDebugState: () => PlayerAnimationDebugState;
  getCurrentFrame: () => { texture: unknown; hFlip: boolean };
  tick: (deltaMs: number) => void;
};

const fixture = loadFixture();
const fixtureDirections: Record<FixtureDirection, Direction> = {
  UP: Direction.UP,
  DOWN: Direction.DOWN,
  LEFT: Direction.LEFT,
  RIGHT: Direction.RIGHT,
};

let PlayerAnimationController: PlayerAnimationControllerCtor;

beforeAll(async () => {
  vi.mock('pixi.js', () => ({
    Rectangle: class Rectangle {},
    Texture: class Texture {
      static from(): unknown {
        return {};
      }
    },
  }));

  const imported = await import('./playerAnimation');
  PlayerAnimationController = imported.PlayerAnimationController as PlayerAnimationControllerCtor;
});

describe('player animation parity fixtures', () => {
  for (const scenario of fixture.scenarios) {
    it(`replays deterministic frame timeline: ${scenario.name}`, () => {
      const controller = new PlayerAnimationController(makeMockAssets());
      const eventsByTick = new Map<number, ParityEvent[]>();
      for (const event of scenario.events) {
        const bucket = eventsByTick.get(event.tick);
        if (bucket) {
          bucket.push(event);
        } else {
          eventsByTick.set(event.tick, [event]);
        }
      }

      const actual = scenario.expected.map((_, tick) => {
        const tickEvents = eventsByTick.get(tick) ?? [];
        for (const event of tickEvents) {
          const direction = fixtureDirections[event.direction];
          if (event.action === 'set_idle') {
            controller.stopMoving(direction);
          } else if (event.action === 'start_walk') {
            controller.startWalkStep(direction);
          } else {
            controller.startRunStep(direction);
          }
        }

        controller.applyPendingModeChanges();
        const debug = controller.getDebugState();
        controller.tick(fixture.tick_ms);
        return {
          animId: debug.animId,
          frameIndex: debug.frameIndex,
          stridePhase: debug.stridePhase,
        };
      });

      expect(actual).toEqual(
        scenario.expected.map((entry) => ({
          animId: entry.anim_id,
          frameIndex: entry.frame_index,
          stridePhase: entry.stride_phase,
        })),
      );
    });
  }

  it('preserves valid frame selection when stop is requested at walk end', () => {
    const controller = new PlayerAnimationController(makeMockAssets());
    controller.startWalkStep(Direction.DOWN);
    controller.tick(fixture.tick_ms * 2);

    expect(() => controller.getCurrentFrame()).not.toThrow();
    controller.stopMoving(Direction.DOWN);
    expect(() => controller.getCurrentFrame()).not.toThrow();

    controller.applyPendingModeChanges();
    expect(() => controller.getCurrentFrame()).not.toThrow();
    expect(controller.getDebugState()).toMatchObject({
      animId: 'anim_face_south',
      frameIndex: 100,
    });
  });

  it('holds the final frame for end_hold actions instead of looping', () => {
    const controller = new PlayerAnimationController(makeMockAssets());
    controller.setTraversalState({
      traversalState: TraversalState.ACRO_BIKE,
      bikeTransition: BikeTransitionType.WHEELIE_POP,
    });
    controller.stopMoving(Direction.RIGHT);
    controller.applyPendingModeChanges();

    expect(controller.getDebugState()).toMatchObject({
      animId: 'anim_acro_pop_wheelie_stationary_east',
      frameIndex: 400,
    });

    controller.tick(1000 / 60);
    controller.tick(1000 / 60);
    expect(controller.getDebugState().frameIndex).toBe(400);

    controller.tick(1000 / 60);
    expect(controller.getDebugState().frameIndex).toBe(401);

    controller.tick((1000 / 60) * 16);
    expect(controller.getDebugState().frameIndex).toBe(401);
  });

  it.each([
    {
      label: 'acro_pop_wheelie_stationary',
      transition: BikeTransitionType.WHEELIE_POP,
      expectedFrames: [400, 400, 401, 401, 401],
    },
    {
      label: 'acro_end_wheelie_stationary',
      transition: BikeTransitionType.WHEELIE_END,
      expectedFrames: [410, 410, 411, 411, 411],
    },
  ])(
    'keeps first frame dwell when ticking before rendering for $label one-shot actions',
    ({ transition, expectedFrames }) => {
      const controller = new PlayerAnimationController(makeMockAssets());
      controller.setTraversalState({
        traversalState: TraversalState.ACRO_BIKE,
        bikeTransition: transition,
      });
      controller.stopMoving(Direction.RIGHT);
      controller.applyPendingModeChanges();

      const observedFrames: number[] = [];
      for (let tick = 0; tick < expectedFrames.length; tick += 1) {
        controller.tick(1000 / 60);
        observedFrames.push(controller.getDebugState().frameIndex);
      }

      expect(observedFrames).toEqual(expectedFrames);
    },
  );

  it('preserves looping walk cadence when ticking before rendering', () => {
    const controller = new PlayerAnimationController(makeMockAssets());
    controller.startWalkStep(Direction.RIGHT);

    const observedFrames: number[] = [];
    for (let tick = 0; tick < 6; tick += 1) {
      controller.tick(1000 / 60);
      observedFrames.push(controller.getDebugState().frameIndex);
    }

    expect(observedFrames).toEqual([230, 231, 231, 232, 232, 233]);
  });

  it.each([
    {
      label: 'acro_pop_wheelie_moving',
      transition: BikeTransitionType.WHEELIE_POP,
      expectedFirstFrame: 430,
      expectedSecondFrame: 431,
    },
    {
      label: 'acro_end_wheelie_moving',
      transition: BikeTransitionType.WHEELIE_END,
      expectedFirstFrame: 440,
      expectedSecondFrame: 441,
    },
  ])(
    'does not stride-remap 2-frame end_hold moving transition for $label on repeated accepted steps',
    ({ transition, expectedFirstFrame, expectedSecondFrame }) => {
      const controller = new PlayerAnimationController(makeMockAssets());
      controller.setTraversalState({
        traversalState: TraversalState.ACRO_BIKE,
        bikeTransition: transition,
      });

      controller.startWalkStep(Direction.RIGHT);
      expect(controller.getDebugState().frameIndex).toBe(expectedFirstFrame);

      controller.tick((1000 / 60) * 3);
      expect(controller.getDebugState().frameIndex).toBe(expectedSecondFrame);

      controller.startWalkStep(Direction.RIGHT);
      expect(controller.getDebugState().frameIndex).toBe(expectedSecondFrame);
    },
  );
});

function loadFixture(): ParityFixture {
  const fixtureUrl = new URL('../../tests/fixtures/player_animation_parity.json', import.meta.url);
  const raw = readFileSync(fixtureUrl, 'utf8');
  return JSON.parse(raw) as ParityFixture;
}

function makeMockAssets(): PlayerAnimationAssets {
  const animation_bindings = {
    face: {
      south: { anim_cmd_symbol: 'anim_face_south', frames: [{ duration: 16, frame: 100, h_flip: false }] },
      north: { anim_cmd_symbol: 'anim_face_north', frames: [{ duration: 16, frame: 101, h_flip: false }] },
      west: { anim_cmd_symbol: 'anim_face_west', frames: [{ duration: 16, frame: 102, h_flip: false }] },
      east: { anim_cmd_symbol: 'anim_face_east', frames: [{ duration: 16, frame: 103, h_flip: false }] },
    },
    walk: {
      south: {
        anim_cmd_symbol: 'anim_walk_south',
        frames: [
          { duration: 2, frame: 200, h_flip: false },
          { duration: 2, frame: 201, h_flip: false },
          { duration: 2, frame: 202, h_flip: false },
          { duration: 2, frame: 203, h_flip: false },
        ],
      },
      north: {
        anim_cmd_symbol: 'anim_walk_north',
        frames: [
          { duration: 2, frame: 210, h_flip: false },
          { duration: 2, frame: 211, h_flip: false },
          { duration: 2, frame: 212, h_flip: false },
          { duration: 2, frame: 213, h_flip: false },
        ],
      },
      west: {
        anim_cmd_symbol: 'anim_walk_west',
        frames: [
          { duration: 2, frame: 220, h_flip: false },
          { duration: 2, frame: 221, h_flip: false },
          { duration: 2, frame: 222, h_flip: false },
          { duration: 2, frame: 223, h_flip: false },
        ],
      },
      east: {
        anim_cmd_symbol: 'anim_walk_east',
        frames: [
          { duration: 2, frame: 230, h_flip: false },
          { duration: 2, frame: 231, h_flip: false },
          { duration: 2, frame: 232, h_flip: false },
          { duration: 2, frame: 233, h_flip: false },
        ],
      },
    },
    run: {
      south: {
        anim_cmd_symbol: 'anim_run_south',
        frames: [
          { duration: 1, frame: 300, h_flip: false },
          { duration: 1, frame: 301, h_flip: false },
          { duration: 1, frame: 302, h_flip: false },
          { duration: 1, frame: 303, h_flip: false },
        ],
      },
      north: {
        anim_cmd_symbol: 'anim_run_north',
        frames: [
          { duration: 1, frame: 310, h_flip: false },
          { duration: 1, frame: 311, h_flip: false },
          { duration: 1, frame: 312, h_flip: false },
          { duration: 1, frame: 313, h_flip: false },
        ],
      },
      west: {
        anim_cmd_symbol: 'anim_run_west',
        frames: [
          { duration: 1, frame: 320, h_flip: false },
          { duration: 1, frame: 321, h_flip: false },
          { duration: 1, frame: 322, h_flip: false },
          { duration: 1, frame: 323, h_flip: false },
        ],
      },
      east: {
        anim_cmd_symbol: 'anim_run_east',
        frames: [
          { duration: 1, frame: 330, h_flip: false },
          { duration: 1, frame: 331, h_flip: false },
          { duration: 1, frame: 332, h_flip: false },
          { duration: 1, frame: 333, h_flip: false },
        ],
      },
    },
  };

  const frameTextures = new Map<number, unknown>();
  for (const frame of [
    100, 101, 102, 103,
    200, 201, 202, 203,
    210, 211, 212, 213,
    220, 221, 222, 223,
    230, 231, 232, 233,
    300, 301, 302, 303,
    310, 311, 312, 313,
    320, 321, 322, 323,
    330, 331, 332, 333,
    400, 401, 402, 403,
    404, 405, 406, 407,
    410, 411, 412, 413,
    414, 415, 416, 417,
    430, 431, 432, 433,
    434, 435, 436, 437,
    440, 441, 442, 443,
    444, 445, 446, 447,
  ]) {
    frameTextures.set(frame, {});
  }

  return {
    avatarId: 'test-avatar',
    frameWidth: 16,
    frameHeight: 32,
    anchorX: 8,
    anchorY: 32,
    paletteColors: [],
    reflectionPaletteColors: null,
    reflectionPaletteSourcePath: null,
    animationSets: {
      on_foot: {
        anim_table_symbol: 'sAnimTable_BrendanMayNormal',
        actions: animation_bindings,
      },
      mach_bike: {
        anim_table_symbol: 'sAnimTable_Standard',
        actions: {
          face: {
            south: { action_id: 'face', anim_cmd_symbol: 'anim_face_south', frames: [{ duration: 16, frame: 100, h_flip: false }] },
            north: { action_id: 'face', anim_cmd_symbol: 'anim_face_north', frames: [{ duration: 16, frame: 101, h_flip: false }] },
            west: { action_id: 'face', anim_cmd_symbol: 'anim_face_west', frames: [{ duration: 16, frame: 102, h_flip: false }] },
            east: { action_id: 'face', anim_cmd_symbol: 'anim_face_east', frames: [{ duration: 16, frame: 103, h_flip: false }] },
          },
          bike_walk: {
            south: { action_id: 'bike_walk', anim_cmd_symbol: 'anim_walk_south', frames: [{ duration: 2, frame: 200, h_flip: false }] },
            north: { action_id: 'bike_walk', anim_cmd_symbol: 'anim_walk_north', frames: [{ duration: 2, frame: 210, h_flip: false }] },
            west: { action_id: 'bike_walk', anim_cmd_symbol: 'anim_walk_west', frames: [{ duration: 2, frame: 220, h_flip: false }] },
            east: { action_id: 'bike_walk', anim_cmd_symbol: 'anim_walk_east', frames: [{ duration: 2, frame: 230, h_flip: false }] },
          },
        },
      },
      acro_bike: {
        anim_table_symbol: 'sAnimTable_AcroBike',
        actions: {
          face: {
            south: { action_id: 'face', anim_cmd_symbol: 'anim_face_south', frames: [{ duration: 16, frame: 100, h_flip: false }] },
            north: { action_id: 'face', anim_cmd_symbol: 'anim_face_north', frames: [{ duration: 16, frame: 101, h_flip: false }] },
            west: { action_id: 'face', anim_cmd_symbol: 'anim_face_west', frames: [{ duration: 16, frame: 102, h_flip: false }] },
            east: { action_id: 'face', anim_cmd_symbol: 'anim_face_east', frames: [{ duration: 16, frame: 103, h_flip: false }] },
          },
          acro_pop_wheelie_stationary: {
            south: {
              action_id: 'acro_pop_wheelie_stationary',
              anim_cmd_symbol: 'anim_acro_pop_wheelie_stationary_south',
              loop_mode: 'end_hold',
              frames: [
                { duration: 2, frame: 402, h_flip: false },
                { duration: 2, frame: 403, h_flip: false },
              ],
            },
            north: {
              action_id: 'acro_pop_wheelie_stationary',
              anim_cmd_symbol: 'anim_acro_pop_wheelie_stationary_north',
              loop_mode: 'end_hold',
              frames: [
                { duration: 2, frame: 404, h_flip: false },
                { duration: 2, frame: 405, h_flip: false },
              ],
            },
            west: {
              action_id: 'acro_pop_wheelie_stationary',
              anim_cmd_symbol: 'anim_acro_pop_wheelie_stationary_west',
              loop_mode: 'end_hold',
              frames: [
                { duration: 2, frame: 406, h_flip: false },
                { duration: 2, frame: 407, h_flip: false },
              ],
            },
            east: {
              action_id: 'acro_pop_wheelie_stationary',
              anim_cmd_symbol: 'anim_acro_pop_wheelie_stationary_east',
              loop_mode: 'end_hold',
              frames: [
                { duration: 2, frame: 400, h_flip: false },
                { duration: 2, frame: 401, h_flip: false },
              ],
            },
          },
          acro_end_wheelie_stationary: {
            south: {
              action_id: 'acro_end_wheelie_stationary',
              anim_cmd_symbol: 'anim_acro_end_wheelie_stationary_south',
              loop_mode: 'end_hold',
              frames: [
                { duration: 2, frame: 412, h_flip: false },
                { duration: 2, frame: 413, h_flip: false },
              ],
            },
            north: {
              action_id: 'acro_end_wheelie_stationary',
              anim_cmd_symbol: 'anim_acro_end_wheelie_stationary_north',
              loop_mode: 'end_hold',
              frames: [
                { duration: 2, frame: 414, h_flip: false },
                { duration: 2, frame: 415, h_flip: false },
              ],
            },
            west: {
              action_id: 'acro_end_wheelie_stationary',
              anim_cmd_symbol: 'anim_acro_end_wheelie_stationary_west',
              loop_mode: 'end_hold',
              frames: [
                { duration: 2, frame: 416, h_flip: false },
                { duration: 2, frame: 417, h_flip: false },
              ],
            },
            east: {
              action_id: 'acro_end_wheelie_stationary',
              anim_cmd_symbol: 'anim_acro_end_wheelie_stationary_east',
              loop_mode: 'end_hold',
              frames: [
                { duration: 2, frame: 410, h_flip: false },
                { duration: 2, frame: 411, h_flip: false },
              ],
            },
          },
          acro_pop_wheelie_moving: {
            south: {
              action_id: 'acro_pop_wheelie_moving',
              anim_cmd_symbol: 'anim_acro_pop_wheelie_moving_south',
              loop_mode: 'end_hold',
              frames: [
                { duration: 2, frame: 432, h_flip: false },
                { duration: 2, frame: 433, h_flip: false },
              ],
            },
            north: {
              action_id: 'acro_pop_wheelie_moving',
              anim_cmd_symbol: 'anim_acro_pop_wheelie_moving_north',
              loop_mode: 'end_hold',
              frames: [
                { duration: 2, frame: 434, h_flip: false },
                { duration: 2, frame: 435, h_flip: false },
              ],
            },
            west: {
              action_id: 'acro_pop_wheelie_moving',
              anim_cmd_symbol: 'anim_acro_pop_wheelie_moving_west',
              loop_mode: 'end_hold',
              frames: [
                { duration: 2, frame: 436, h_flip: false },
                { duration: 2, frame: 437, h_flip: false },
              ],
            },
            east: {
              action_id: 'acro_pop_wheelie_moving',
              anim_cmd_symbol: 'anim_acro_pop_wheelie_moving_east',
              loop_mode: 'end_hold',
              frames: [
                { duration: 2, frame: 430, h_flip: false },
                { duration: 2, frame: 431, h_flip: false },
              ],
            },
          },
          acro_end_wheelie_moving: {
            south: {
              action_id: 'acro_end_wheelie_moving',
              anim_cmd_symbol: 'anim_acro_end_wheelie_moving_south',
              loop_mode: 'end_hold',
              frames: [
                { duration: 2, frame: 442, h_flip: false },
                { duration: 2, frame: 443, h_flip: false },
              ],
            },
            north: {
              action_id: 'acro_end_wheelie_moving',
              anim_cmd_symbol: 'anim_acro_end_wheelie_moving_north',
              loop_mode: 'end_hold',
              frames: [
                { duration: 2, frame: 444, h_flip: false },
                { duration: 2, frame: 445, h_flip: false },
              ],
            },
            west: {
              action_id: 'acro_end_wheelie_moving',
              anim_cmd_symbol: 'anim_acro_end_wheelie_moving_west',
              loop_mode: 'end_hold',
              frames: [
                { duration: 2, frame: 446, h_flip: false },
                { duration: 2, frame: 447, h_flip: false },
              ],
            },
            east: {
              action_id: 'acro_end_wheelie_moving',
              anim_cmd_symbol: 'anim_acro_end_wheelie_moving_east',
              loop_mode: 'end_hold',
              frames: [
                { duration: 2, frame: 440, h_flip: false },
                { duration: 2, frame: 441, h_flip: false },
              ],
            },
          },
        },
      },
    },
    frameTextures,
  };
}

import { readFileSync } from 'node:fs';

import { beforeAll, describe, expect, it, vi } from 'vitest';

import { Direction } from './protocol_generated';

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
  directionalBindings: Record<string, Record<string, { anim_cmd_symbol: string; frames: Array<{ duration: number; frame: number; h_flip: boolean }> }> >;
  frameTextures: Map<number, unknown>;
};

type PlayerAnimationControllerCtor = new (assets: PlayerAnimationAssets) => {
  setFacing: (direction: Direction) => void;
  stopMoving: (direction: Direction) => void;
  startWalkStep: (direction: Direction) => void;
  startRunStep: (direction: Direction) => void;
  startStep: (direction: Direction, mode: 'walk' | 'run') => void;
  getDebugState: () => PlayerAnimationDebugState;
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
    directionalBindings: animation_bindings,
    frameTextures,
  };
}

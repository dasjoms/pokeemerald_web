import { readFileSync } from 'node:fs';

import { beforeAll, describe, expect, it, vi } from 'vitest';

import { Direction } from './protocol_generated';
import type {
  PlayerAnimationActionId,
  PlayerAnimationAssets,
  PlayerAnimationDebugState,
} from './playerAnimation';

type FixtureDirection = 'UP' | 'DOWN' | 'LEFT' | 'RIGHT';
type FixtureAction =
  | 'WALK'
  | 'RUN'
  | 'MACH_TRAVEL'
  | 'MACH_TURN'
  | 'ACRO_TRAVEL'
  | 'ACRO_TURN'
  | 'ACRO_WHEELIE'
  | 'ACRO_WHEELIE_MOVE'
  | 'ACRO_HOP';

type FixtureRoot = {
  tick_ms: number;
  scenarios: FixtureScenario[];
};

type FixtureScenario = {
  name: string;
  events: FixtureEvent[];
  expected: Array<{ anim_id: string; frame_index: number }>;
};

type FixtureEvent = {
  tick: number;
  action: FixtureAction;
  direction: FixtureDirection;
  cadence_ms?: number;
};

const fixture = loadFixture();
const fixtureDirections: Record<FixtureDirection, Direction> = {
  UP: Direction.UP,
  DOWN: Direction.DOWN,
  LEFT: Direction.LEFT,
  RIGHT: Direction.RIGHT,
};

let PlayerAnimationController: (new (assets: PlayerAnimationAssets) => {
  startActionStep: (direction: Direction, actionId: PlayerAnimationActionId, cadenceMs?: number) => void;
  applyPendingModeChanges: () => void;
  getDebugState: () => PlayerAnimationDebugState;
  tick: (deltaMs: number) => void;
});

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
  PlayerAnimationController = imported.PlayerAnimationController as typeof PlayerAnimationController;
});

describe('bike animation replay fixtures', () => {
  for (const scenario of fixture.scenarios) {
    it(`replays bike animation ids and frame progression: ${scenario.name}`, () => {
      const controller = new PlayerAnimationController(makeMockAssets());
      const eventsByTick = new Map<number, FixtureEvent[]>();
      for (const event of scenario.events) {
        const bucket = eventsByTick.get(event.tick);
        if (bucket) {
          bucket.push(event);
        } else {
          eventsByTick.set(event.tick, [event]);
        }
      }

      const actual = scenario.expected.map((_, tickIndex) => {
        const tickEvents = eventsByTick.get(tickIndex) ?? [];
        for (const event of tickEvents) {
          controller.startActionStep(
            fixtureDirections[event.direction],
            mapAction(event.action),
            event.cadence_ms,
          );
        }

        controller.applyPendingModeChanges();
        const debug = controller.getDebugState();
        controller.tick(fixture.tick_ms);
        return {
          anim_id: debug.animId,
          frame_index: debug.frameIndex,
        };
      });

      expect(actual).toEqual(scenario.expected);
    });
  }
});

function mapAction(action: FixtureAction): PlayerAnimationActionId {
  switch (action) {
    case 'WALK':
      return 'walk';
    case 'RUN':
      return 'run';
    case 'MACH_TRAVEL':
      return 'mach_travel';
    case 'MACH_TURN':
      return 'mach_turn';
    case 'ACRO_TRAVEL':
      return 'acro_travel';
    case 'ACRO_TURN':
      return 'acro_turn';
    case 'ACRO_WHEELIE':
      return 'acro_wheelie';
    case 'ACRO_WHEELIE_MOVE':
      return 'acro_wheelie_move';
    case 'ACRO_HOP':
      return 'acro_hop';
  }
}

function loadFixture(): FixtureRoot {
  const fixtureUrl = new URL('../../tests/fixtures/bike_animation_replay.json', import.meta.url);
  return JSON.parse(readFileSync(fixtureUrl, 'utf8')) as FixtureRoot;
}

function makeMockAssets(): PlayerAnimationAssets {
  const frameTextures = new Map<number, unknown>();
  for (const frame of [
    100, 101, 102, 103,
    200, 201, 202, 203,
    230, 231, 232, 233,
    300, 301, 302, 303,
    500, 501, 502, 503,
    510, 511, 512, 513,
    520, 521, 522, 523,
    530, 531, 532, 533,
    600, 601, 602, 603,
    620, 621, 622, 623,
    624, 625,
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
    directionalBindings: {
      face: {
        south: { anim_cmd_symbol: 'anim_face_south', frames: [{ duration: 16, frame: 100, h_flip: false }] },
        north: { anim_cmd_symbol: 'anim_face_north', frames: [{ duration: 16, frame: 101, h_flip: false }] },
        west: { anim_cmd_symbol: 'anim_face_west', frames: [{ duration: 16, frame: 102, h_flip: false }] },
        east: { anim_cmd_symbol: 'anim_face_east', frames: [{ duration: 16, frame: 103, h_flip: false }] },
      },
      walk: {
        south: { anim_cmd_symbol: 'anim_walk_south', frames: [{ duration: 2, frame: 200, h_flip: false }] },
        north: { anim_cmd_symbol: 'anim_walk_north', frames: [{ duration: 2, frame: 201, h_flip: false }] },
        west: { anim_cmd_symbol: 'anim_walk_west', frames: [{ duration: 2, frame: 202, h_flip: false }] },
        east: { anim_cmd_symbol: 'anim_walk_east', frames: [{ duration: 2, frame: 230, h_flip: false }, { duration: 2, frame: 231, h_flip: false }] },
      },
      run: {
        south: { anim_cmd_symbol: 'anim_run_south', frames: [{ duration: 1, frame: 300, h_flip: false }] },
        north: { anim_cmd_symbol: 'anim_run_north', frames: [{ duration: 1, frame: 301, h_flip: false }] },
        west: { anim_cmd_symbol: 'anim_run_west', frames: [{ duration: 1, frame: 302, h_flip: false }] },
        east: { anim_cmd_symbol: 'anim_run_east', frames: [{ duration: 1, frame: 303, h_flip: false }] },
      },
    },
    frameTextures: frameTextures as Map<number, never>,
    actionBindings: {
      mach_travel: {
        directionalBindings: {
          south: { anim_cmd_symbol: 'anim_mach_ride_south', frames: [{ duration: 1, frame: 500, h_flip: false }] },
          north: {
            anim_cmd_symbol: 'anim_mach_ride_north',
            frames: [
              { duration: 1, frame: 520, h_flip: false },
              { duration: 1, frame: 521, h_flip: false },
              { duration: 1, frame: 522, h_flip: false },
            ],
          },
          west: { anim_cmd_symbol: 'anim_mach_ride_west', frames: [{ duration: 1, frame: 502, h_flip: false }] },
          east: {
            anim_cmd_symbol: 'anim_mach_ride_east',
            frames: [
              { duration: 1, frame: 530, h_flip: false },
              { duration: 1, frame: 531, h_flip: false },
              { duration: 1, frame: 532, h_flip: false },
              { duration: 1, frame: 533, h_flip: false },
            ],
          },
        },
        frameTextures: frameTextures as Map<number, never>,
      },
      mach_turn: {
        directionalBindings: {
          south: { anim_cmd_symbol: 'anim_mach_face_south', frames: [{ duration: 2, frame: 510, h_flip: false }] },
          north: { anim_cmd_symbol: 'anim_mach_face_north', frames: [{ duration: 2, frame: 511, h_flip: false }] },
          west: { anim_cmd_symbol: 'anim_mach_face_west', frames: [{ duration: 2, frame: 512, h_flip: false }] },
          east: { anim_cmd_symbol: 'anim_mach_face_east', frames: [{ duration: 2, frame: 513, h_flip: false }] },
        },
        frameTextures: frameTextures as Map<number, never>,
      },
      acro_travel: {
        directionalBindings: {
          south: { anim_cmd_symbol: 'anim_acro_ride_south', frames: [{ duration: 1, frame: 620, h_flip: false }] },
          north: { anim_cmd_symbol: 'anim_acro_ride_north', frames: [{ duration: 1, frame: 621, h_flip: false }] },
          west: { anim_cmd_symbol: 'anim_acro_ride_west', frames: [{ duration: 1, frame: 622, h_flip: false }] },
          east: {
            anim_cmd_symbol: 'anim_acro_ride_east',
            frames: [
              { duration: 1, frame: 623, h_flip: false },
              { duration: 1, frame: 624, h_flip: false },
              { duration: 1, frame: 625, h_flip: false },
            ],
          },
        },
        frameTextures: frameTextures as Map<number, never>,
      },
      acro_turn: {
        directionalBindings: {
          south: { anim_cmd_symbol: 'anim_acro_face_south', frames: [{ duration: 2, frame: 600, h_flip: false }] },
          north: { anim_cmd_symbol: 'anim_acro_face_north', frames: [{ duration: 2, frame: 601, h_flip: false }] },
          west: { anim_cmd_symbol: 'anim_acro_face_west', frames: [{ duration: 2, frame: 602, h_flip: false }] },
          east: { anim_cmd_symbol: 'anim_acro_face_east', frames: [{ duration: 2, frame: 603, h_flip: false }] },
        },
        frameTextures: frameTextures as Map<number, never>,
      },
      acro_wheelie: {
        directionalBindings: {
          south: { anim_cmd_symbol: 'anim_acro_face_south', frames: [{ duration: 2, frame: 600, h_flip: false }] },
          north: { anim_cmd_symbol: 'anim_acro_face_north', frames: [{ duration: 2, frame: 601, h_flip: false }] },
          west: { anim_cmd_symbol: 'anim_acro_face_west', frames: [{ duration: 2, frame: 602, h_flip: false }] },
          east: { anim_cmd_symbol: 'anim_acro_face_east', frames: [{ duration: 2, frame: 603, h_flip: false }] },
        },
        frameTextures: frameTextures as Map<number, never>,
      },
      acro_wheelie_move: {
        directionalBindings: {
          south: { anim_cmd_symbol: 'anim_acro_ride_south', frames: [{ duration: 1, frame: 620, h_flip: false }] },
          north: { anim_cmd_symbol: 'anim_acro_ride_north', frames: [{ duration: 1, frame: 621, h_flip: false }] },
          west: { anim_cmd_symbol: 'anim_acro_ride_west', frames: [{ duration: 1, frame: 622, h_flip: false }] },
          east: { anim_cmd_symbol: 'anim_acro_ride_east', frames: [{ duration: 1, frame: 623, h_flip: false }, { duration: 1, frame: 624, h_flip: false }] },
        },
        frameTextures: frameTextures as Map<number, never>,
      },
      acro_hop: {
        directionalBindings: {
          south: { anim_cmd_symbol: 'anim_acro_face_south', frames: [{ duration: 2, frame: 600, h_flip: false }] },
          north: { anim_cmd_symbol: 'anim_acro_face_north', frames: [{ duration: 2, frame: 601, h_flip: false }] },
          west: { anim_cmd_symbol: 'anim_acro_face_west', frames: [{ duration: 2, frame: 602, h_flip: false }] },
          east: { anim_cmd_symbol: 'anim_acro_face_east', frames: [{ duration: 2, frame: 603, h_flip: false }] },
        },
        frameTextures: frameTextures as Map<number, never>,
      },
    },
  };
}

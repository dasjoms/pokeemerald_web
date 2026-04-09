import { beforeAll, describe, expect, it, vi } from 'vitest';

import type { PlayerAnimationAssets, PlayerAnimationDebugState } from './playerAnimation';
import {
  movementModeStepDurationMs,
  startAuthoritativeWalkTransition,
  tickWalkTransition,
  type WalkTransition,
  type WalkTransitionMutableState,
} from './walkTransitionPipeline';
import { Direction, MovementMode, RejectionReason, TraversalState, type WalkResult } from './protocol_generated';

type PipelineState = WalkTransitionMutableState & {
  facing: Direction;
};

type PlayerAnimationControllerCtor = new (assets: PlayerAnimationAssets) => {
  stopMoving: (direction: Direction) => void;
  startStep: (direction: Direction, mode: 'walk' | 'run') => void;
  getDebugState: () => PlayerAnimationDebugState;
  tick: (deltaMs: number) => void;
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

describe('main movement pipeline integration', () => {
  it.each([
    { label: 'walk', movementMode: MovementMode.WALK, expectedAnimId: 'anim_walk_east' },
    { label: 'run', movementMode: MovementMode.RUN, expectedAnimId: 'anim_run_east' },
  ])(
    'alternates stride phase and step-start frame for consecutive accepted $label results',
    ({ movementMode, expectedAnimId }) => {
      const playerAnimation = new PlayerAnimationController(makeMockAssets());
      const state: PipelineState = {
        playerTileX: 10,
        playerTileY: 7,
        renderTileX: 10,
        renderTileY: 7,
        facing: Direction.RIGHT,
      };

      const pendingMovementModesByInputSeq = new Map<number, MovementMode>([
        [1, movementMode],
        [2, movementMode],
        [3, movementMode],
      ]);

      const totalSteps = 3;
      let activeWalkTransition: WalkTransition | null = null;
      let completedTransitionCount = 0;
      let stopMovingCount = 0;
      const stepStartDebugStates: PlayerAnimationDebugState[] = [];

      playerAnimation.stopMoving(Direction.RIGHT);

      for (let seq = 1; seq <= totalSteps; seq += 1) {
        const result: WalkResult = {
          input_seq: seq,
          accepted: true,
          authoritative_pos: {
            x: 10 + seq,
            y: 7,
          },
          facing: Direction.RIGHT,
          reason: RejectionReason.NONE,
          server_frame: seq,
          traversal_state: TraversalState.ON_FOOT,
        };

        const acceptedMovementMode =
          pendingMovementModesByInputSeq.get(result.input_seq) ?? MovementMode.WALK;
        pendingMovementModesByInputSeq.delete(result.input_seq);

        state.playerTileX = result.authoritative_pos.x;
        state.playerTileY = result.authoritative_pos.y;
        state.facing = result.facing;

        activeWalkTransition = startAuthoritativeWalkTransition(
          state,
          result.facing,
          acceptedMovementMode,
        );
        playerAnimation.startStep(
          result.facing,
          acceptedMovementMode === MovementMode.RUN ? 'run' : 'walk',
        );
        stepStartDebugStates.push(playerAnimation.getDebugState());

        while (activeWalkTransition !== null) {
          const deltaMs = movementModeStepDurationMs(movementMode) / 4;
          activeWalkTransition = tickWalkTransition({
            activeWalkTransition,
            state,
            deltaMs,
            hasPendingAcceptedOrDispatchableStep: () => seq < totalSteps,
            markWalkTransitionCompleted: () => {
              completedTransitionCount += 1;
            },
            stopMoving: (direction) => {
              stopMovingCount += 1;
              playerAnimation.stopMoving(direction);
            },
          });
          playerAnimation.tick(deltaMs);
        }
      }

      expect(completedTransitionCount).toBe(totalSteps);
      expect(stopMovingCount).toBe(1);

      for (let index = 1; index < stepStartDebugStates.length; index += 1) {
        expect(stepStartDebugStates[index].animId).toBe(expectedAnimId);
        expect(stepStartDebugStates[index].frameIndex).not.toBe(
          stepStartDebugStates[index - 1].frameIndex,
        );
        expect(stepStartDebugStates[index].stridePhase).toBe(
          stepStartDebugStates[index - 1].stridePhase === 0 ? 1 : 0,
        );
      }

      expect(stepStartDebugStates[0].frameIndex).toBe(stepStartDebugStates[2].frameIndex);
      expect(stepStartDebugStates[0].stridePhase).toBe(stepStartDebugStates[2].stridePhase);
    },
  );
});

function makeMockAssets(): PlayerAnimationAssets {
  const directionalBindings = {
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
          { duration: 3, frame: 200, h_flip: false },
          { duration: 3, frame: 201, h_flip: false },
          { duration: 3, frame: 202, h_flip: false },
          { duration: 3, frame: 203, h_flip: false },
        ],
      },
      north: {
        anim_cmd_symbol: 'anim_walk_north',
        frames: [
          { duration: 3, frame: 210, h_flip: false },
          { duration: 3, frame: 211, h_flip: false },
          { duration: 3, frame: 212, h_flip: false },
          { duration: 3, frame: 213, h_flip: false },
        ],
      },
      west: {
        anim_cmd_symbol: 'anim_walk_west',
        frames: [
          { duration: 3, frame: 220, h_flip: false },
          { duration: 3, frame: 221, h_flip: false },
          { duration: 3, frame: 222, h_flip: false },
          { duration: 3, frame: 223, h_flip: false },
        ],
      },
      east: {
        anim_cmd_symbol: 'anim_walk_east',
        frames: [
          { duration: 3, frame: 230, h_flip: false },
          { duration: 3, frame: 231, h_flip: false },
          { duration: 3, frame: 232, h_flip: false },
          { duration: 3, frame: 233, h_flip: false },
        ],
      },
    },
    run: {
      south: {
        anim_cmd_symbol: 'anim_run_south',
        frames: [
          { duration: 5, frame: 300, h_flip: false },
          { duration: 5, frame: 301, h_flip: false },
          { duration: 5, frame: 302, h_flip: false },
          { duration: 5, frame: 303, h_flip: false },
        ],
      },
      north: {
        anim_cmd_symbol: 'anim_run_north',
        frames: [
          { duration: 5, frame: 310, h_flip: false },
          { duration: 5, frame: 311, h_flip: false },
          { duration: 5, frame: 312, h_flip: false },
          { duration: 5, frame: 313, h_flip: false },
        ],
      },
      west: {
        anim_cmd_symbol: 'anim_run_west',
        frames: [
          { duration: 5, frame: 320, h_flip: false },
          { duration: 5, frame: 321, h_flip: false },
          { duration: 5, frame: 322, h_flip: false },
          { duration: 5, frame: 323, h_flip: false },
        ],
      },
      east: {
        anim_cmd_symbol: 'anim_run_east',
        frames: [
          { duration: 5, frame: 330, h_flip: false },
          { duration: 5, frame: 331, h_flip: false },
          { duration: 5, frame: 332, h_flip: false },
          { duration: 5, frame: 333, h_flip: false },
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
    anchorY: 30,
    paletteColors: ['#000000'],
    reflectionPaletteColors: null,
    reflectionPaletteSourcePath: null,
    directionalBindings,
    frameTextures: frameTextures as PlayerAnimationAssets['frameTextures'],
  };
}

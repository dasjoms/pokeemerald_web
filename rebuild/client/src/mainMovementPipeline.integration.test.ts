import { beforeAll, describe, expect, it, vi } from "vitest";

import type {
  PlayerAnimationAssets,
  PlayerAnimationDebugState,
} from "./playerAnimation";
import {
  authoritativeStepDurationMs,
  startAuthoritativeWalkTransition,
  tickWalkTransition,
  type WalkTransition,
  type WalkTransitionMutableState,
} from "./walkTransitionPipeline";
import {
  createInitialFieldCameraOffset,
  updateFieldCameraPixelOffset,
} from "./cameraTilemap";
import { createWalkInputController } from "./input";
import {
  AcroBikeSubstate,
  BikeTransitionType,
  Direction,
  MovementMode,
  RejectionReason,
  TraversalState,
  type WalkResult,
} from "./protocol_generated";
import { PlayerMovementActionRuntime } from "./playerMovementActionRuntime";
import { HopShadowRenderer } from "./hopShadowRenderer";
import { resolveHopLandingPlacementTile } from "./hopLandingPlacement";

type PipelineState = WalkTransitionMutableState & {
  facing: Direction;
};

type PlayerAnimationControllerCtor = new (assets: PlayerAnimationAssets) => {
  stopMoving: (direction: Direction) => void;
  startStep: (direction: Direction, mode: "walk" | "run") => void;
  setTraversalState: (state: {
    traversalState: TraversalState;
    machSpeedStage?: number;
    acroSubstate?: AcroBikeSubstate;
    bikeTransition?: BikeTransitionType;
  }) => void;
  applyPendingModeChanges: () => void;
  getDebugState: () => PlayerAnimationDebugState;
  tick: (deltaMs: number) => void;
};

let PlayerAnimationController: PlayerAnimationControllerCtor;

beforeAll(async () => {
  vi.mock("pixi.js", () => ({
    Rectangle: class Rectangle {},
    Texture: class Texture {
      static from(): unknown {
        return {};
      }
    },
  }));

  const imported = await import("./playerAnimation");
  PlayerAnimationController =
    imported.PlayerAnimationController as PlayerAnimationControllerCtor;
});

describe("main movement pipeline integration", () => {
  it.each([
    {
      label: "walk",
      movementMode: MovementMode.WALK,
      expectedAnimId: "anim_walk_east",
    },
    {
      label: "run",
      movementMode: MovementMode.RUN,
      expectedAnimId: "anim_run_east",
    },
  ])(
    "alternates stride phase and step-start frame for consecutive accepted $label results",
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
          preferred_bike_type: TraversalState.MACH_BIKE,
          player_elevation: 0,
          bike_effect_flags: 0,
        };

        const acceptedMovementMode =
          pendingMovementModesByInputSeq.get(result.input_seq) ??
          MovementMode.WALK;
        pendingMovementModesByInputSeq.delete(result.input_seq);

        state.playerTileX = result.authoritative_pos.x;
        state.playerTileY = result.authoritative_pos.y;
        state.facing = result.facing;

        activeWalkTransition = startAuthoritativeWalkTransition(
          state,
          result.facing,
          {
            traversalState: result.traversal_state,
            movementMode: acceptedMovementMode,
          },
        );
        playerAnimation.startStep(
          result.facing,
          acceptedMovementMode === MovementMode.RUN ? "run" : "walk",
        );
        stepStartDebugStates.push(playerAnimation.getDebugState());

        while (activeWalkTransition !== null) {
          const deltaMs =
            authoritativeStepDurationMs({
              traversalState: result.traversal_state,
              movementMode: acceptedMovementMode,
            }) / 4;
          activeWalkTransition = tickWalkTransition({
            activeWalkTransition,
            state,
            deltaMs,
            hasPendingAcceptedOrDispatchableStep: () => seq < totalSteps,
            noteWalkTransitionProgress: () => {},
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

      expect(stepStartDebugStates[0].frameIndex).toBe(
        stepStartDebugStates[2].frameIndex,
      );
      expect(stepStartDebugStates[0].stridePhase).toBe(
        stepStartDebugStates[2].stridePhase,
      );
    },
  );

  it("keeps camera center monotonic during one accepted right-step interpolation", () => {
    const TILE_SIZE = 16;
    const state: PipelineState = {
      playerTileX: 10,
      playerTileY: 7,
      renderTileX: 10,
      renderTileY: 7,
      facing: Direction.RIGHT,
    };
    const cameraOffset = createInitialFieldCameraOffset();

    state.playerTileX = 11;
    let activeWalkTransition = startAuthoritativeWalkTransition(
      state,
      Direction.RIGHT,
      {
        traversalState: TraversalState.ON_FOOT,
        movementMode: MovementMode.WALK,
      },
    );

    const stepDurationMs = authoritativeStepDurationMs({
      traversalState: TraversalState.ON_FOOT,
      movementMode: MovementMode.WALK,
    });
    const frameDeltaMs = stepDurationMs / 16;
    const cameraCenters: Array<{ x: number; y: number }> = [];

    while (activeWalkTransition !== null) {
      activeWalkTransition = tickWalkTransition({
        activeWalkTransition,
        state,
        deltaMs: frameDeltaMs,
        hasPendingAcceptedOrDispatchableStep: () => false,
        noteWalkTransitionProgress: () => {},
        markWalkTransitionCompleted: () => {},
        stopMoving: () => {},
      });
      updateFieldCameraPixelOffset(
        cameraOffset,
        (state.renderTileX - state.playerTileX) * TILE_SIZE,
        (state.renderTileY - state.playerTileY) * TILE_SIZE,
        TILE_SIZE,
      );
      cameraCenters.push({
        x: state.playerTileX * TILE_SIZE + TILE_SIZE / 2 + cameraOffset.xPixelOffset,
        y: state.playerTileY * TILE_SIZE + TILE_SIZE / 2 + cameraOffset.yPixelOffset,
      });
    }

    expect(cameraCenters.length).toBeGreaterThan(0);
    for (let index = 1; index < cameraCenters.length; index += 1) {
      const prev = cameraCenters[index - 1];
      const next = cameraCenters[index];
      expect(next.x).toBeGreaterThanOrEqual(prev.x);
      expect(next.x - prev.x).toBeLessThanOrEqual(1);
      expect(next.y).toBe(prev.y);
    }
  });

  it("replays authoritative acro runtime states for animation ids without inferring from run mode", () => {
    const playerAnimation = new PlayerAnimationController(makeMockAssets());
    const direction = Direction.RIGHT;
    const sequence = [
      {
        traversalState: TraversalState.ACRO_BIKE,
        acroSubstate: AcroBikeSubstate.NONE,
        bikeTransition: BikeTransitionType.NONE,
        expectedAnimId: "anim_bike_walk_east",
      },
      {
        traversalState: TraversalState.ACRO_BIKE,
        acroSubstate: AcroBikeSubstate.MOVING_WHEELIE,
        bikeTransition: BikeTransitionType.NONE,
        expectedAnimId: "anim_acro_moving_wheelie_east",
      },
      {
        traversalState: TraversalState.ACRO_BIKE,
        acroSubstate: AcroBikeSubstate.NONE,
        bikeTransition: BikeTransitionType.HOP_MOVING,
        expectedAnimId: "anim_acro_ledge_hop_front_east",
      },
      {
        traversalState: TraversalState.ACRO_BIKE,
        acroSubstate: AcroBikeSubstate.BUNNY_HOP,
        bikeTransition: BikeTransitionType.HOP_STANDING,
        expectedAnimId: "anim_acro_bunny_hop_back_east",
        stationary: true,
      },
      {
        traversalState: TraversalState.ACRO_BIKE,
        acroSubstate: AcroBikeSubstate.STANDING_WHEELIE,
        bikeTransition: BikeTransitionType.WHEELIE_IDLE,
        expectedAnimId: "anim_acro_wheelie_face_east",
        stationary: true,
      },
    ] as const;

    const actualAnimIds: string[] = [];
    for (const entry of sequence) {
      playerAnimation.setTraversalState({
        traversalState: entry.traversalState,
        acroSubstate: entry.acroSubstate,
        bikeTransition: entry.bikeTransition,
      });
      if ("stationary" in entry && entry.stationary) {
        playerAnimation.stopMoving(direction);
        playerAnimation.applyPendingModeChanges();
      } else {
        playerAnimation.startStep(direction, "run");
      }
      actualAnimIds.push(playerAnimation.getDebugState().animId);
    }

    expect(actualAnimIds).toEqual(
      sequence.map((entry) => entry.expectedAnimId),
    );
  });

  it("renders idle acro held-B transition deltas without relying on accepted walk results", () => {
    const playerAnimation = new PlayerAnimationController(makeMockAssets());
    const startStepSpy = vi.spyOn(playerAnimation, "startStep");
    const direction = Direction.RIGHT;

    playerAnimation.stopMoving(direction);
    playerAnimation.applyPendingModeChanges();

    playerAnimation.setTraversalState({
      traversalState: TraversalState.ACRO_BIKE,
      acroSubstate: AcroBikeSubstate.STANDING_WHEELIE,
      bikeTransition: BikeTransitionType.NORMAL_TO_WHEELIE,
    });
    playerAnimation.stopMoving(direction);
    playerAnimation.applyPendingModeChanges();
    expect(playerAnimation.getDebugState().animId).toBe(
      "anim_acro_pop_wheelie_stationary_east",
    );

    for (let tick = 0; tick < 39; tick += 1) {
      playerAnimation.setTraversalState({
        traversalState: TraversalState.ACRO_BIKE,
        acroSubstate: AcroBikeSubstate.STANDING_WHEELIE,
        bikeTransition: BikeTransitionType.NONE,
      });
      playerAnimation.stopMoving(direction);
      playerAnimation.applyPendingModeChanges();
      playerAnimation.tick(1000 / 60);
    }
    expect(playerAnimation.getDebugState().animId).toBe(
      "anim_acro_wheelie_face_east",
    );

    playerAnimation.setTraversalState({
      traversalState: TraversalState.ACRO_BIKE,
      acroSubstate: AcroBikeSubstate.BUNNY_HOP,
      bikeTransition: BikeTransitionType.WHEELIE_HOPPING_STANDING,
    });
    playerAnimation.stopMoving(direction);
    playerAnimation.applyPendingModeChanges();
    expect(playerAnimation.getDebugState().animId).toBe(
      "anim_acro_bunny_hop_back_east",
    );
    expect(startStepSpy).not.toHaveBeenCalled();
  });

  it("keeps wheelie posture when stopMoving lands before authoritative wheelie-idle transition", () => {
    const playerAnimation = new PlayerAnimationController(makeMockAssets());
    const direction = Direction.RIGHT;

    playerAnimation.setTraversalState({
      traversalState: TraversalState.ACRO_BIKE,
      acroSubstate: AcroBikeSubstate.MOVING_WHEELIE,
      bikeTransition: BikeTransitionType.WHEELIE_MOVING,
    });
    playerAnimation.startStep(direction, "run");
    expect(playerAnimation.getDebugState().animId).toBe(
      "anim_acro_moving_wheelie_east",
    );

    playerAnimation.setTraversalState({
      traversalState: TraversalState.ACRO_BIKE,
      acroSubstate: AcroBikeSubstate.MOVING_WHEELIE,
      bikeTransition: BikeTransitionType.NONE,
    });
    playerAnimation.stopMoving(direction);
    playerAnimation.applyPendingModeChanges();
    expect(playerAnimation.getDebugState().animId).toBe(
      "anim_acro_wheelie_face_east",
    );

    playerAnimation.setTraversalState({
      traversalState: TraversalState.ACRO_BIKE,
      acroSubstate: AcroBikeSubstate.STANDING_WHEELIE,
      bikeTransition: BikeTransitionType.WHEELIE_IDLE,
    });
    playerAnimation.stopMoving(direction);
    playerAnimation.applyPendingModeChanges();
    expect(playerAnimation.getDebugState().animId).toBe(
      "anim_acro_wheelie_face_east",
    );
  });

  it("holds pop-wheelie action for full one-shot duration before returning to idle wheelie hold", () => {
    const playerAnimation = new PlayerAnimationController(makeMockAssets());
    const direction = Direction.RIGHT;
    const popWheelieDurationTicks = 6;

    playerAnimation.setTraversalState({
      traversalState: TraversalState.ACRO_BIKE,
      acroSubstate: AcroBikeSubstate.STANDING_WHEELIE,
      bikeTransition: BikeTransitionType.NORMAL_TO_WHEELIE,
    });
    playerAnimation.stopMoving(direction);
    playerAnimation.applyPendingModeChanges();
    expect(playerAnimation.getDebugState().animId).toBe(
      "anim_acro_pop_wheelie_stationary_east",
    );

    for (let tick = 0; tick < popWheelieDurationTicks - 1; tick += 1) {
      playerAnimation.setTraversalState({
        traversalState: TraversalState.ACRO_BIKE,
        acroSubstate: AcroBikeSubstate.STANDING_WHEELIE,
        bikeTransition: BikeTransitionType.NONE,
      });
      playerAnimation.stopMoving(direction);
      playerAnimation.applyPendingModeChanges();
      playerAnimation.tick(1000 / 60);
      expect(playerAnimation.getDebugState().animId).toBe(
        "anim_acro_pop_wheelie_stationary_east",
      );
    }

    let settledToWheelieIdle = false;
    for (let tick = 0; tick < 40; tick += 1) {
      playerAnimation.tick(1000 / 60);
      playerAnimation.setTraversalState({
        traversalState: TraversalState.ACRO_BIKE,
        acroSubstate: AcroBikeSubstate.STANDING_WHEELIE,
        bikeTransition: BikeTransitionType.NONE,
      });
      playerAnimation.stopMoving(direction);
      playerAnimation.applyPendingModeChanges();
      if (playerAnimation.getDebugState().animId === "anim_acro_wheelie_face_east") {
        settledToWheelieIdle = true;
        break;
      }
    }
    expect(settledToWheelieIdle).toBe(true);
  });

  it("does not let wheelie-idle updates interrupt a latched pop-wheelie one-shot", () => {
    const playerAnimation = new PlayerAnimationController(makeMockAssets());
    const direction = Direction.RIGHT;
    const popWheelieDurationTicks = 6;

    playerAnimation.setTraversalState({
      traversalState: TraversalState.ACRO_BIKE,
      acroSubstate: AcroBikeSubstate.STANDING_WHEELIE,
      bikeTransition: BikeTransitionType.NORMAL_TO_WHEELIE,
    });
    playerAnimation.stopMoving(direction);
    playerAnimation.applyPendingModeChanges();
    expect(playerAnimation.getDebugState().animId).toBe(
      "anim_acro_pop_wheelie_stationary_east",
    );

    for (let tick = 0; tick < popWheelieDurationTicks - 1; tick += 1) {
      playerAnimation.setTraversalState({
        traversalState: TraversalState.ACRO_BIKE,
        acroSubstate: AcroBikeSubstate.STANDING_WHEELIE,
        bikeTransition: BikeTransitionType.WHEELIE_IDLE,
      });
      playerAnimation.stopMoving(direction);
      playerAnimation.applyPendingModeChanges();
      playerAnimation.tick(1000 / 60);
      expect(playerAnimation.getDebugState().animId).toBe(
        "anim_acro_pop_wheelie_stationary_east",
      );
    }

    let settledToWheelieIdle = false;
    for (let tick = 0; tick < 3; tick += 1) {
      playerAnimation.tick(1000 / 60);
      playerAnimation.setTraversalState({
        traversalState: TraversalState.ACRO_BIKE,
        acroSubstate: AcroBikeSubstate.STANDING_WHEELIE,
        bikeTransition: BikeTransitionType.WHEELIE_IDLE,
      });
      playerAnimation.stopMoving(direction);
      playerAnimation.applyPendingModeChanges();
      if (playerAnimation.getDebugState().animId === "anim_acro_wheelie_face_east") {
        settledToWheelieIdle = true;
        break;
      }
    }
    expect(settledToWheelieIdle).toBe(true);
  });

  it("does not let wheelie-moving updates interrupt a latched moving pop-wheelie one-shot", () => {
    const playerAnimation = new PlayerAnimationController(makeMockAssets());
    const direction = Direction.RIGHT;
    const popWheelieDurationTicks = 6;

    playerAnimation.setTraversalState({
      traversalState: TraversalState.ACRO_BIKE,
      acroSubstate: AcroBikeSubstate.MOVING_WHEELIE,
      bikeTransition: BikeTransitionType.WHEELIE_RISING_MOVING,
    });
    playerAnimation.startStep(direction, "run");
    expect(playerAnimation.getDebugState().animId).toBe(
      "anim_acro_pop_wheelie_moving_east",
    );

    for (let tick = 0; tick < popWheelieDurationTicks - 1; tick += 1) {
      playerAnimation.setTraversalState({
        traversalState: TraversalState.ACRO_BIKE,
        acroSubstate: AcroBikeSubstate.MOVING_WHEELIE,
        bikeTransition: BikeTransitionType.WHEELIE_MOVING,
      });
      playerAnimation.applyPendingModeChanges();
      playerAnimation.tick(1000 / 60);
      expect(playerAnimation.getDebugState().animId).toBe(
        "anim_acro_pop_wheelie_moving_east",
      );
    }

    playerAnimation.setTraversalState({
      traversalState: TraversalState.ACRO_BIKE,
      acroSubstate: AcroBikeSubstate.MOVING_WHEELIE,
      bikeTransition: BikeTransitionType.WHEELIE_END,
    });
    playerAnimation.startStep(direction, "run");
    playerAnimation.applyPendingModeChanges();
    expect(playerAnimation.getDebugState().animId).not.toBe(
      "anim_acro_pop_wheelie_moving_east",
    );
  });

  it("keeps bunny-hop one-shot playback latched without looping during the 16-tick low-jump arc", () => {
    const playerAnimation = new PlayerAnimationController(makeMockAssets());
    const direction = Direction.RIGHT;

    playerAnimation.setTraversalState({
      traversalState: TraversalState.ACRO_BIKE,
      acroSubstate: AcroBikeSubstate.BUNNY_HOP,
      bikeTransition: BikeTransitionType.HOP_STANDING,
    });
    playerAnimation.stopMoving(direction);
    playerAnimation.applyPendingModeChanges();

    const firstFrame = playerAnimation.getDebugState().frameIndex;

    for (let tick = 0; tick < 16; tick += 1) {
      playerAnimation.setTraversalState({
        traversalState: TraversalState.ACRO_BIKE,
        acroSubstate: AcroBikeSubstate.BUNNY_HOP,
        bikeTransition: BikeTransitionType.NONE,
      });
      playerAnimation.stopMoving(direction);
      playerAnimation.applyPendingModeChanges();
      playerAnimation.tick(1000 / 60);
    }

    const afterArcState = playerAnimation.getDebugState();
    expect(afterArcState.animId).toBe("anim_acro_bunny_hop_back_east");
    expect(afterArcState.frameIndex).toBe(463);
    expect(afterArcState.frameIndex).not.toBe(firstFrame);

    playerAnimation.tick(1000 / 60);
    expect(playerAnimation.getDebugState().frameIndex).toBe(463);
  });

  it("keeps hop shadow active through consecutive stationary hops while held-B hop context remains active", () => {
    const movementRuntime = new PlayerMovementActionRuntime();
    const { fakeLayer, shadowRenderer } = createShadowHarness();

    movementRuntime.setAuthoritativeInput({
      traversalState: TraversalState.ACRO_BIKE,
      acroSubstate: AcroBikeSubstate.BUNNY_HOP,
      bikeTransition: BikeTransitionType.HOP_STANDING,
    });
    shadowRenderer.setAuthoritativeState({
      traversalState: TraversalState.ACRO_BIKE,
      bikeTransition: BikeTransitionType.HOP_STANDING,
      acroSubstate: AcroBikeSubstate.BUNNY_HOP,
    });

    shadowRenderer.presentFrame({
      tileX: 12,
      tileY: 9,
      visualState: movementRuntime.getVisualState(),
    });
    expect(shadowRenderer.hasActiveShadow()).toBe(true);
    expect(fakeLayer.addedCount).toBe(1);
    expect(fakeLayer.removedCount).toBe(0);

    for (let tick = 0; tick < 48; tick += 1) {
      movementRuntime.tickTicks(1);
      shadowRenderer.presentFrame({
        tileX: 12,
        tileY: 9,
        visualState: movementRuntime.getVisualState(),
      });
      expect(shadowRenderer.hasActiveShadow()).toBe(true);
      expect(fakeLayer.addedCount).toBe(1);
      expect(fakeLayer.removedCount).toBe(0);
    }
  });

  it("keeps hop shadow active through directional hop sequences without per-hop despawn churn", () => {
    const movementRuntime = new PlayerMovementActionRuntime();
    const { fakeLayer, shadowRenderer } = createShadowHarness();

    movementRuntime.setAuthoritativeInput({
      traversalState: TraversalState.ACRO_BIKE,
      acroSubstate: AcroBikeSubstate.BUNNY_HOP,
      bikeTransition: BikeTransitionType.HOP_STANDING,
    });
    shadowRenderer.setAuthoritativeState({
      traversalState: TraversalState.ACRO_BIKE,
      bikeTransition: BikeTransitionType.HOP_STANDING,
      acroSubstate: AcroBikeSubstate.BUNNY_HOP,
    });
    shadowRenderer.presentFrame({
      tileX: 12,
      tileY: 9,
      visualState: movementRuntime.getVisualState(),
    });
    expect(shadowRenderer.hasActiveShadow()).toBe(true);
    expect(fakeLayer.addedCount).toBe(1);
    expect(fakeLayer.removedCount).toBe(0);

    const directionalHopSequence = [
      BikeTransitionType.WHEELIE_HOPPING_MOVING,
      BikeTransitionType.NONE,
      BikeTransitionType.HOP_MOVING,
      BikeTransitionType.NONE,
      BikeTransitionType.WHEELIE_HOPPING_MOVING,
      BikeTransitionType.NONE,
    ] as const;

    for (const bikeTransition of directionalHopSequence) {
      movementRuntime.setAuthoritativeInput({
        traversalState: TraversalState.ACRO_BIKE,
        acroSubstate: AcroBikeSubstate.BUNNY_HOP,
        bikeTransition,
      });
      shadowRenderer.setAuthoritativeState({
        traversalState: TraversalState.ACRO_BIKE,
        bikeTransition,
        acroSubstate: AcroBikeSubstate.BUNNY_HOP,
      });
      movementRuntime.tickTicks(1);
      shadowRenderer.presentFrame({
        tileX: 12,
        tileY: 9,
        visualState: movementRuntime.getVisualState(),
      });
      expect(shadowRenderer.hasActiveShadow()).toBe(true);
      expect(fakeLayer.addedCount).toBe(1);
      expect(fakeLayer.removedCount).toBe(0);
    }
  });

  it("keeps hop shadow alive through mid-hop B release and despawns once after landing", () => {
    const movementRuntime = new PlayerMovementActionRuntime();
    const { fakeLayer, shadowRenderer } = createShadowHarness();

    movementRuntime.setAuthoritativeInput({
      traversalState: TraversalState.ACRO_BIKE,
      acroSubstate: AcroBikeSubstate.BUNNY_HOP,
      bikeTransition: BikeTransitionType.HOP_STANDING,
      bunnyHopCycleTick: 4,
    });
    shadowRenderer.setAuthoritativeState({
      traversalState: TraversalState.ACRO_BIKE,
      bikeTransition: BikeTransitionType.HOP_STANDING,
      acroSubstate: AcroBikeSubstate.BUNNY_HOP,
    });
    shadowRenderer.presentFrame({
      tileX: 12,
      tileY: 9,
      visualState: movementRuntime.getVisualState(),
    });
    expect(shadowRenderer.hasActiveShadow()).toBe(true);
    expect(fakeLayer.addedCount).toBe(1);
    expect(fakeLayer.removedCount).toBe(0);

    // Mid-hop B release exits authoritative hop-capable context while hop arc is still airborne.
    movementRuntime.setAuthoritativeInput({
      traversalState: TraversalState.ACRO_BIKE,
      acroSubstate: AcroBikeSubstate.STANDING_WHEELIE,
      bikeTransition: BikeTransitionType.WHEELIE_TO_NORMAL,
    });
    shadowRenderer.setAuthoritativeState({
      traversalState: TraversalState.ACRO_BIKE,
      bikeTransition: BikeTransitionType.NONE,
      acroSubstate: AcroBikeSubstate.NONE,
    });
    shadowRenderer.presentFrame({
      tileX: 12,
      tileY: 9,
      visualState: movementRuntime.getVisualState(),
    });

    expect(shadowRenderer.hasActiveShadow()).toBe(true);
    expect(fakeLayer.addedCount).toBe(1);
    expect(fakeLayer.removedCount).toBe(0);

    // Keep presenting while airborne under non-hop authoritative context.
    movementRuntime.tickTicks(8);
    shadowRenderer.presentFrame({
      tileX: 12,
      tileY: 9,
      visualState: movementRuntime.getVisualState(),
    });
    expect(shadowRenderer.hasActiveShadow()).toBe(true);
    expect(fakeLayer.addedCount).toBe(1);
    expect(fakeLayer.removedCount).toBe(0);

    // Landing frame: visual arc completes, so shadow despawns once.
    movementRuntime.tickTicks(1);
    shadowRenderer.presentFrame({
      tileX: 12,
      tileY: 9,
      visualState: movementRuntime.getVisualState(),
    });
    expect(shadowRenderer.hasActiveShadow()).toBe(false);
    expect(fakeLayer.removedCount).toBe(1);
  });

  it("suppresses hop shadow visibility on water/reflective/tall grass without destroying sprite", () => {
    const movementRuntime = new PlayerMovementActionRuntime();
    const { fakeLayer, createdSprites, shadowRenderer } = createShadowHarness();

    movementRuntime.setAuthoritativeInput({
      traversalState: TraversalState.ACRO_BIKE,
      acroSubstate: AcroBikeSubstate.BUNNY_HOP,
      bikeTransition: BikeTransitionType.HOP_STANDING,
    });
    shadowRenderer.setAuthoritativeState({
      traversalState: TraversalState.ACRO_BIKE,
      bikeTransition: BikeTransitionType.HOP_STANDING,
      acroSubstate: AcroBikeSubstate.BUNNY_HOP,
    });
    shadowRenderer.presentFrame({
      tileX: 12,
      tileY: 9,
      visualState: movementRuntime.getVisualState(),
    });

    expect(createdSprites).toHaveLength(1);
    expect(shadowRenderer.hasActiveShadow()).toBe(true);
    expect(createdSprites[0].visible).toBe(true);

    shadowRenderer.setSuppressionContext({ isWaterSurface: true });
    expect(shadowRenderer.hasActiveShadow()).toBe(true);
    expect(createdSprites[0].visible).toBe(false);
    expect(fakeLayer.addedCount).toBe(1);
    expect(fakeLayer.removedCount).toBe(0);

    shadowRenderer.setSuppressionContext({
      isWaterSurface: false,
      isReflectiveSurface: true,
    });
    expect(createdSprites[0].visible).toBe(false);
    expect(fakeLayer.addedCount).toBe(1);
    expect(fakeLayer.removedCount).toBe(0);

    shadowRenderer.setSuppressionContext({
      isReflectiveSurface: false,
      isPokeGrass: true,
    });
    expect(createdSprites[0].visible).toBe(false);
    expect(fakeLayer.addedCount).toBe(1);
    expect(fakeLayer.removedCount).toBe(0);

    shadowRenderer.setSuppressionContext({ isPokeGrass: false });
    expect(createdSprites[0].visible).toBe(true);
    expect(shadowRenderer.hasActiveShadow()).toBe(true);
    expect(fakeLayer.addedCount).toBe(1);
    expect(fakeLayer.removedCount).toBe(0);
  });

  it("spawns hop shadow from bunny-hop continuity even when transition is NONE", () => {
    const movementRuntime = new PlayerMovementActionRuntime();
    const { fakeLayer, shadowRenderer } = createShadowHarness();

    shadowRenderer.setAuthoritativeState({
      traversalState: TraversalState.ACRO_BIKE,
      bikeTransition: BikeTransitionType.NONE,
      acroSubstate: AcroBikeSubstate.BUNNY_HOP,
    });
    shadowRenderer.presentFrame({
      tileX: 7,
      tileY: 4,
      visualState: movementRuntime.getVisualState(),
    });

    expect(shadowRenderer.hasActiveShadow()).toBe(true);
    expect(fakeLayer.addedCount).toBe(1);
    expect(fakeLayer.removedCount).toBe(0);
  });

  it("keeps stationary hop arc in-flight on mid-hop B release until landing", () => {
    const movementRuntime = new PlayerMovementActionRuntime();

    movementRuntime.setAuthoritativeInput({
      traversalState: TraversalState.ACRO_BIKE,
      acroSubstate: AcroBikeSubstate.BUNNY_HOP,
      bikeTransition: BikeTransitionType.HOP_STANDING,
      bunnyHopCycleTick: 4,
    });
    expect(movementRuntime.getVisualState()).toEqual({
      yOffsetPx: -5,
      activeAction: "acro_wheelie_hop_face",
    });

    movementRuntime.setAuthoritativeInput({
      traversalState: TraversalState.ACRO_BIKE,
      acroSubstate: AcroBikeSubstate.STANDING_WHEELIE,
      bikeTransition: BikeTransitionType.WHEELIE_TO_NORMAL,
    });
    expect(movementRuntime.getVisualState()).toEqual({
      yOffsetPx: -5,
      activeAction: "acro_wheelie_hop_face",
    });

    movementRuntime.tickTicks(8);
    expect(movementRuntime.getVisualState()).toEqual({
      yOffsetPx: -2,
      activeAction: "acro_wheelie_hop_face",
    });

    movementRuntime.tickTicks(1);
    expect(movementRuntime.getVisualState()).toEqual({
      yOffsetPx: 0,
      activeAction: "none",
    });
  });

  it("keeps moving bunny-hop animation when authoritative transition clears to NONE mid-hop", () => {
    const playerAnimation = new PlayerAnimationController(makeMockAssets());

    playerAnimation.setTraversalState({
      traversalState: TraversalState.ACRO_BIKE,
      acroSubstate: AcroBikeSubstate.BUNNY_HOP,
      bikeTransition: BikeTransitionType.NONE,
    });
    playerAnimation.startStep(Direction.RIGHT, "run");

    expect(playerAnimation.getDebugState().animId).toBe(
      "anim_acro_bunny_hop_back_east",
    );
    expect(playerAnimation.getDebugState().animId).not.toBe(
      "anim_bike_walk_east",
    );
  });

  it("does not flash neutral bike ride animation while progressing from stationary hop hold into directional hop", () => {
    const playerAnimation = new PlayerAnimationController(makeMockAssets());
    const direction = Direction.RIGHT;

    playerAnimation.setTraversalState({
      traversalState: TraversalState.ACRO_BIKE,
      acroSubstate: AcroBikeSubstate.BUNNY_HOP,
      bikeTransition: BikeTransitionType.HOP_STANDING,
    });
    playerAnimation.stopMoving(direction);
    playerAnimation.applyPendingModeChanges();
    expect(playerAnimation.getDebugState().animId).toBe(
      "anim_acro_bunny_hop_back_east",
    );

    const directionalHopSequence = [
      BikeTransitionType.WHEELIE_HOPPING_MOVING,
      BikeTransitionType.NONE,
      BikeTransitionType.NONE,
    ] as const;

    for (const bikeTransition of directionalHopSequence) {
      playerAnimation.setTraversalState({
        traversalState: TraversalState.ACRO_BIKE,
        acroSubstate: AcroBikeSubstate.BUNNY_HOP,
        bikeTransition,
      });
      playerAnimation.startStep(direction, "run");
      const animId = playerAnimation.getDebugState().animId;
      expect(animId).toBe("anim_acro_bunny_hop_back_east");
      expect(animId).not.toBe("anim_bike_walk_east");
    }
  });

  it("does not dip into grounded bike/end-wheelie frames on held-B reverse turn when transition is NONE", () => {
    const playerAnimation = new PlayerAnimationController(makeMockAssets());
    const reverseTurnSequence = [
      {
        direction: Direction.LEFT,
        acroSubstate: AcroBikeSubstate.MOVING_WHEELIE,
        bikeTransition: BikeTransitionType.WHEELIE_MOVING,
      },
      {
        direction: Direction.RIGHT,
        acroSubstate: AcroBikeSubstate.STANDING_WHEELIE,
        bikeTransition: BikeTransitionType.NONE,
      },
      {
        direction: Direction.RIGHT,
        acroSubstate: AcroBikeSubstate.MOVING_WHEELIE,
        bikeTransition: BikeTransitionType.WHEELIE_MOVING,
      },
    ] as const;

    const observedAnimIds: string[] = [];
    for (const frame of reverseTurnSequence) {
      playerAnimation.setTraversalState({
        traversalState: TraversalState.ACRO_BIKE,
        acroSubstate: frame.acroSubstate,
        bikeTransition: frame.bikeTransition,
      });
      playerAnimation.startStep(frame.direction, "run");
      observedAnimIds.push(playerAnimation.getDebugState().animId);
    }

    expect(observedAnimIds[1]).toBe("anim_acro_wheelie_face_east");
    for (const animId of observedAnimIds) {
      expect(animId).not.toMatch(/^anim_acro_end_wheelie_/);
      expect(animId).not.toMatch(/^anim_bike_(walk|fast)_/);
    }
  });

  it("drops stale hop latch immediately when authoritative wheelie-rise-moving transition arrives", () => {
    const playerAnimation = new PlayerAnimationController(makeMockAssets());
    const direction = Direction.RIGHT;

    playerAnimation.setTraversalState({
      traversalState: TraversalState.ACRO_BIKE,
      acroSubstate: AcroBikeSubstate.BUNNY_HOP,
      bikeTransition: BikeTransitionType.WHEELIE_HOPPING_MOVING,
    });
    playerAnimation.startStep(direction, "run");
    expect(playerAnimation.getDebugState().animId).toBe(
      "anim_acro_bunny_hop_back_east",
    );

    playerAnimation.setTraversalState({
      traversalState: TraversalState.ACRO_BIKE,
      acroSubstate: AcroBikeSubstate.MOVING_WHEELIE,
      bikeTransition: BikeTransitionType.WHEELIE_RISING_MOVING,
    });
    playerAnimation.startStep(direction, "run");

    const animId = playerAnimation.getDebugState().animId;
    expect(animId).toBe("anim_acro_pop_wheelie_moving_east");
    expect(animId).not.toBe("anim_acro_bunny_hop_back_east");
  });

  it("resolves moving bunny-hop parity action after standing wheelie hop transitions into directional hold", () => {
    const playerAnimation = new PlayerAnimationController(makeMockAssets());
    const direction = Direction.RIGHT;

    playerAnimation.setTraversalState({
      traversalState: TraversalState.ACRO_BIKE,
      acroSubstate: AcroBikeSubstate.STANDING_WHEELIE,
      bikeTransition: BikeTransitionType.WHEELIE_IDLE,
    });
    playerAnimation.stopMoving(direction);
    playerAnimation.applyPendingModeChanges();
    expect(playerAnimation.getDebugState().animId).toBe(
      "anim_acro_wheelie_face_east",
    );

    playerAnimation.setTraversalState({
      traversalState: TraversalState.ACRO_BIKE,
      acroSubstate: AcroBikeSubstate.BUNNY_HOP,
      bikeTransition: BikeTransitionType.HOP_STANDING,
    });
    playerAnimation.stopMoving(direction);
    playerAnimation.applyPendingModeChanges();
    expect(playerAnimation.getDebugState().animId).toBe(
      "anim_acro_bunny_hop_back_east",
    );

    const movingHoldSequence = [
      BikeTransitionType.WHEELIE_HOPPING_MOVING,
      BikeTransitionType.NONE,
      BikeTransitionType.NONE,
    ] as const;

    for (const bikeTransition of movingHoldSequence) {
      playerAnimation.setTraversalState({
        traversalState: TraversalState.ACRO_BIKE,
        acroSubstate: AcroBikeSubstate.BUNNY_HOP,
        bikeTransition,
      });
      playerAnimation.startStep(direction, "run");
      const animId = playerAnimation.getDebugState().animId;
      expect(animId).toBe("anim_acro_bunny_hop_back_east");
      expect(animId).not.toBe("anim_acro_bunny_hop_front_east");
    }
  });

  it("aligns hop landing particle placement to the current rendered tile during directional hop interpolation", () => {
    const directionalHopVisualState = {
      renderTileX: 10.625,
      renderTileY: 7,
    };

    const fallbackPlacement = resolveHopLandingPlacementTile(
      directionalHopVisualState,
      {},
    );
    expect(fallbackPlacement).toEqual({
      tileX: 10.625,
      tileY: 7,
    });

    const authoritativeLandingPlacement = resolveHopLandingPlacementTile(
      directionalHopVisualState,
      {
        hopLandingTileX: 11,
        hopLandingTileY: 7,
      },
    );
    expect(authoritativeLandingPlacement).toEqual({
      tileX: 11,
      tileY: 7,
    });
  });

  it("does not drift landing particle placement by tiles across consecutive directional hops", () => {
    const renderedLandingSamples = [
      { renderTileX: 14.125, renderTileY: 8 },
      { renderTileX: 14.625, renderTileY: 8 },
      { renderTileX: 15.125, renderTileY: 8 },
    ];

    const placements = renderedLandingSamples.map((sample) =>
      resolveHopLandingPlacementTile(sample, {}),
    );

    expect(placements).toEqual([
      { tileX: 14.125, tileY: 8 },
      { tileX: 14.625, tileY: 8 },
      { tileX: 15.125, tileY: 8 },
    ]);
  });

  it("keeps landing particle placement anchored to explicit landing tile across mixed WalkResult and BikeRuntimeDelta ordering", () => {
    const authoritativeLandingHint = {
      hopLandingTileX: 19,
      hopLandingTileY: 11,
    };
    const deliveryOrders = [
      ["walk_result", "bike_runtime_delta"],
      ["bike_runtime_delta", "walk_result"],
    ] as const;

    for (const order of deliveryOrders) {
      const placements = order.map((source, index) =>
        resolveHopLandingPlacementTile(
          {
            // Simulate local render state continuing to interpolate between packet deliveries.
            renderTileX: 18.25 + index * 0.5,
            renderTileY: 11,
          },
          authoritativeLandingHint,
        ),
      );
      expect(placements).toEqual([
        { tileX: 19, tileY: 11 },
        { tileX: 19, tileY: 11 },
      ]);
      expect(order).toContain("walk_result");
      expect(order).toContain("bike_runtime_delta");
    }
  });

  it("locks directional bunny-hop landing frame to authoritative tile center, zero Y offset, and authoritative landing tile", () => {
    const state: WalkTransitionMutableState = {
      playerTileX: 12,
      playerTileY: 9,
      renderTileX: 11.625,
      renderTileY: 9,
    };
    const authoritativePreviousTile = { tileX: 11, tileY: 9 };
    const transition = startAuthoritativeWalkTransition(
      state,
      Direction.RIGHT,
      {
        traversalState: TraversalState.ACRO_BIKE,
        movementMode: MovementMode.WALK,
      },
      authoritativePreviousTile,
    );
    expect(transition.startX).toBe(authoritativePreviousTile.tileX);
    expect(transition.startY).toBe(authoritativePreviousTile.tileY);

    tickWalkTransition({
      activeWalkTransition: transition,
      state,
      deltaMs: transition.durationMs,
      hasPendingAcceptedOrDispatchableStep: () => false,
      noteWalkTransitionProgress: () => {},
      markWalkTransitionCompleted: () => {},
      stopMoving: () => {},
    });

    const movementActionRuntime = new PlayerMovementActionRuntime();
    movementActionRuntime.setAuthoritativeInput({
      traversalState: TraversalState.ACRO_BIKE,
      acroSubstate: AcroBikeSubstate.BUNNY_HOP,
      bikeTransition: BikeTransitionType.WHEELIE_HOPPING_MOVING,
      bunnyHopCycleTick: 13,
    });

    const landingPlacement = resolveHopLandingPlacementTile(
      {
        renderTileX: state.renderTileX,
        renderTileY: state.renderTileY,
      },
      {
        hopLandingTileX: 12,
        hopLandingTileY: 9,
      },
    );

    expect(state.renderTileX).toBe(12);
    expect(state.renderTileY).toBe(9);
    expect(movementActionRuntime.getVisualState().yOffsetPx).toBe(0);
    expect(landingPlacement).toEqual({ tileX: 12, tileY: 9 });
  });

  it.each([
    {
      bikeTransition: BikeTransitionType.NONE,
      acroSubstate: AcroBikeSubstate.NONE,
      shouldStep: false,
      expectedAnimId: "anim_face_east",
    },
    {
      bikeTransition: BikeTransitionType.WHEELIE_IDLE,
      acroSubstate: AcroBikeSubstate.STANDING_WHEELIE,
      shouldStep: false,
      expectedAnimId: "anim_acro_wheelie_face_east",
    },
    {
      bikeTransition: BikeTransitionType.WHEELIE_POP,
      acroSubstate: AcroBikeSubstate.NONE,
      shouldStep: false,
      expectedAnimId: "anim_acro_pop_wheelie_stationary_east",
    },
    {
      bikeTransition: BikeTransitionType.WHEELIE_END,
      acroSubstate: AcroBikeSubstate.STANDING_WHEELIE,
      shouldStep: false,
      expectedAnimId: "anim_acro_end_wheelie_stationary_east",
    },
    {
      bikeTransition: BikeTransitionType.HOP_STANDING,
      acroSubstate: AcroBikeSubstate.BUNNY_HOP,
      shouldStep: false,
      expectedAnimId: "anim_acro_bunny_hop_back_east",
    },
    {
      bikeTransition: BikeTransitionType.HOP,
      acroSubstate: AcroBikeSubstate.NONE,
      shouldStep: false,
      expectedAnimId: "anim_acro_bunny_hop_back_east",
    },
    {
      bikeTransition: BikeTransitionType.WHEELIE_HOPPING_STANDING,
      acroSubstate: AcroBikeSubstate.BUNNY_HOP,
      shouldStep: false,
      expectedAnimId: "anim_acro_bunny_hop_back_east",
    },
    {
      bikeTransition: BikeTransitionType.HOP_MOVING,
      acroSubstate: AcroBikeSubstate.NONE,
      shouldStep: true,
      expectedAnimId: "anim_acro_ledge_hop_front_east",
    },
    {
      bikeTransition: BikeTransitionType.SIDE_JUMP,
      acroSubstate: AcroBikeSubstate.NONE,
      shouldStep: true,
      expectedAnimId: "anim_acro_side_jump_east",
    },
    {
      bikeTransition: BikeTransitionType.TURN_JUMP,
      acroSubstate: AcroBikeSubstate.NONE,
      shouldStep: true,
      expectedAnimId: "anim_acro_turn_jump_east",
    },
    {
      bikeTransition: BikeTransitionType.WHEELIE_HOPPING_MOVING,
      acroSubstate: AcroBikeSubstate.NONE,
      shouldStep: true,
      expectedAnimId: "anim_acro_bunny_hop_back_east",
    },
    {
      bikeTransition: BikeTransitionType.WHEELIE_MOVING,
      acroSubstate: AcroBikeSubstate.MOVING_WHEELIE,
      shouldStep: true,
      expectedAnimId: "anim_acro_moving_wheelie_east",
    },
    {
      bikeTransition: BikeTransitionType.WHEELIE_RISING_MOVING,
      acroSubstate: AcroBikeSubstate.NONE,
      shouldStep: true,
      expectedAnimId: "anim_acro_pop_wheelie_moving_east",
    },
    {
      bikeTransition: BikeTransitionType.WHEELIE_LOWERING_MOVING,
      acroSubstate: AcroBikeSubstate.NONE,
      shouldStep: true,
      expectedAnimId: "anim_acro_end_wheelie_moving_east",
    },
    {
      bikeTransition: BikeTransitionType.NORMAL_TO_WHEELIE,
      acroSubstate: AcroBikeSubstate.NONE,
      shouldStep: true,
      expectedAnimId: "anim_acro_pop_wheelie_moving_east",
    },
    {
      bikeTransition: BikeTransitionType.WHEELIE_TO_NORMAL,
      acroSubstate: AcroBikeSubstate.NONE,
      shouldStep: true,
      expectedAnimId: "anim_acro_end_wheelie_moving_east",
    },
    {
      bikeTransition: BikeTransitionType.ENTER_WHEELIE,
      acroSubstate: AcroBikeSubstate.NONE,
      shouldStep: false,
      expectedAnimId: "anim_acro_pop_wheelie_stationary_east",
    },
    {
      bikeTransition: BikeTransitionType.EXIT_WHEELIE,
      acroSubstate: AcroBikeSubstate.STANDING_WHEELIE,
      shouldStep: false,
      expectedAnimId: "anim_acro_end_wheelie_stationary_east",
    },
    {
      bikeTransition: BikeTransitionType.MOUNT,
      acroSubstate: AcroBikeSubstate.NONE,
      shouldStep: true,
      expectedAnimId: "anim_bike_walk_east",
    },
    {
      bikeTransition: BikeTransitionType.DISMOUNT,
      acroSubstate: AcroBikeSubstate.NONE,
      shouldStep: false,
      expectedAnimId: "anim_face_east",
    },
  ])(
    "maps acro bike transition $bikeTransition and substate $acroSubstate to explicit animation ids",
    ({ bikeTransition, acroSubstate, shouldStep, expectedAnimId }) => {
      const playerAnimation = new PlayerAnimationController(makeMockAssets());
      playerAnimation.setTraversalState({
        traversalState: TraversalState.ACRO_BIKE,
        acroSubstate,
        bikeTransition,
      });
      if (shouldStep) {
        playerAnimation.startStep(Direction.RIGHT, "run");
      } else {
        playerAnimation.stopMoving(Direction.RIGHT);
        playerAnimation.applyPendingModeChanges();
      }
      expect(playerAnimation.getDebugState().animId).toBe(expectedAnimId);
    },
  );

  it.each([
    {
      label: "Mach bike",
      speed: {
        traversalState: TraversalState.MACH_BIKE,
        movementMode: MovementMode.WALK,
        machSpeedStage: 2,
      },
    },
    {
      label: "Acro bike",
      speed: {
        traversalState: TraversalState.ACRO_BIKE,
        movementMode: MovementMode.WALK,
      },
    },
  ])(
    "dispatches follow-up inputs at authoritative $label ack cadence, independent from local interpolation completion",
    ({ speed }) => {
      const nowSpy = vi.spyOn(performance, "now");
      const sentDirections: Direction[] = [];
      let nowMs = 10_000;
      nowSpy.mockImplementation(() => nowMs);

      const controller = createWalkInputController({
        sendWalkInput: (direction) => {
          sentDirections.push(direction);
        },
        sendHeldInputState: () => null,
        isMovementLocked: () => false,
        onFacingIntent: () => {},
      });

      controller.handleKeyDown({
        key: "ArrowRight",
        repeat: false,
        preventDefault: () => {},
      } as KeyboardEvent);

      nowMs += 100;
      controller.tick();
      expect(sentDirections).toEqual([Direction.RIGHT]);

      const footWalkDurationMs = authoritativeStepDurationMs({
        traversalState: TraversalState.ON_FOOT,
        movementMode: MovementMode.WALK,
      });
      const bikeDurationMs = authoritativeStepDurationMs(speed);
      expect(bikeDurationMs).toBeLessThan(footWalkDurationMs);

      nowMs += bikeDurationMs;
      controller.noteWalkTransitionProgress(0.9);
      controller.markWalkResultReceived({
        input_seq: 0,
        accepted: true,
        authoritative_pos: { x: 6, y: 8 },
        facing: Direction.RIGHT,
        reason: RejectionReason.NONE,
        server_frame: 42,
        traversal_state: speed.traversalState,
        preferred_bike_type: TraversalState.MACH_BIKE,
        player_elevation: 0,
        mach_speed_stage:
          speed.traversalState === TraversalState.MACH_BIKE ? 2 : undefined,
        bike_effect_flags: 0,
      });
      expect(sentDirections).toEqual([Direction.RIGHT, Direction.RIGHT]);

      // Local interpolation completion callback may run later, but should not gate dispatch cadence.
      nowMs += footWalkDurationMs - bikeDurationMs;
      controller.markWalkTransitionCompleted();
      expect(sentDirections).toEqual([Direction.RIGHT, Direction.RIGHT]);

      nowSpy.mockRestore();
    },
  );
});

class FakeShadowLayer {
  addedCount = 0;
  removedCount = 0;

  addChild(): void {
    this.addedCount += 1;
  }

  removeChild(): void {
    this.removedCount += 1;
  }
}

function createShadowHarness(): {
  fakeLayer: FakeShadowLayer;
  shadowRenderer: HopShadowRenderer;
  createdSprites: Array<{ x: number; y: number; visible: boolean }>;
} {
  const fakeLayer = new FakeShadowLayer();
  const createdSprites: Array<{ x: number; y: number; visible: boolean }> = [];
  const shadowRenderer = new HopShadowRenderer(() => fakeLayer, 16, () => {
    const sprite = {
      x: 0,
      y: 0,
      visible: true,
    };
    createdSprites.push(sprite);
    return sprite;
  });

  return {
    fakeLayer,
    shadowRenderer,
    createdSprites,
  };
}

function makeMockAssets(): PlayerAnimationAssets {
  const directionalBindings = {
    face: {
      south: {
        anim_cmd_symbol: "anim_face_south",
        frames: [{ duration: 16, frame: 100, h_flip: false }],
      },
      north: {
        anim_cmd_symbol: "anim_face_north",
        frames: [{ duration: 16, frame: 101, h_flip: false }],
      },
      west: {
        anim_cmd_symbol: "anim_face_west",
        frames: [{ duration: 16, frame: 102, h_flip: false }],
      },
      east: {
        anim_cmd_symbol: "anim_face_east",
        frames: [{ duration: 16, frame: 103, h_flip: false }],
      },
    },
    walk: {
      south: {
        anim_cmd_symbol: "anim_walk_south",
        frames: [
          { duration: 3, frame: 200, h_flip: false },
          { duration: 3, frame: 201, h_flip: false },
          { duration: 3, frame: 202, h_flip: false },
          { duration: 3, frame: 203, h_flip: false },
        ],
      },
      north: {
        anim_cmd_symbol: "anim_walk_north",
        frames: [
          { duration: 3, frame: 210, h_flip: false },
          { duration: 3, frame: 211, h_flip: false },
          { duration: 3, frame: 212, h_flip: false },
          { duration: 3, frame: 213, h_flip: false },
        ],
      },
      west: {
        anim_cmd_symbol: "anim_walk_west",
        frames: [
          { duration: 3, frame: 220, h_flip: false },
          { duration: 3, frame: 221, h_flip: false },
          { duration: 3, frame: 222, h_flip: false },
          { duration: 3, frame: 223, h_flip: false },
        ],
      },
      east: {
        anim_cmd_symbol: "anim_walk_east",
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
        anim_cmd_symbol: "anim_run_south",
        frames: [
          { duration: 5, frame: 300, h_flip: false },
          { duration: 5, frame: 301, h_flip: false },
          { duration: 5, frame: 302, h_flip: false },
          { duration: 5, frame: 303, h_flip: false },
        ],
      },
      north: {
        anim_cmd_symbol: "anim_run_north",
        frames: [
          { duration: 5, frame: 310, h_flip: false },
          { duration: 5, frame: 311, h_flip: false },
          { duration: 5, frame: 312, h_flip: false },
          { duration: 5, frame: 313, h_flip: false },
        ],
      },
      west: {
        anim_cmd_symbol: "anim_run_west",
        frames: [
          { duration: 5, frame: 320, h_flip: false },
          { duration: 5, frame: 321, h_flip: false },
          { duration: 5, frame: 322, h_flip: false },
          { duration: 5, frame: 323, h_flip: false },
        ],
      },
      east: {
        anim_cmd_symbol: "anim_run_east",
        frames: [
          { duration: 5, frame: 330, h_flip: false },
          { duration: 5, frame: 331, h_flip: false },
          { duration: 5, frame: 332, h_flip: false },
          { duration: 5, frame: 333, h_flip: false },
        ],
      },
    },
    bike_walk: {
      south: {
        anim_cmd_symbol: "anim_bike_walk_south",
        frames: [{ duration: 3, frame: 400, h_flip: false }],
      },
      north: {
        anim_cmd_symbol: "anim_bike_walk_north",
        frames: [{ duration: 3, frame: 401, h_flip: false }],
      },
      west: {
        anim_cmd_symbol: "anim_bike_walk_west",
        frames: [{ duration: 3, frame: 402, h_flip: false }],
      },
      east: {
        anim_cmd_symbol: "anim_bike_walk_east",
        frames: [{ duration: 3, frame: 403, h_flip: false }],
      },
    },
    bike_fast: {
      south: {
        anim_cmd_symbol: "anim_bike_fast_south",
        frames: [{ duration: 2, frame: 410, h_flip: false }],
      },
      north: {
        anim_cmd_symbol: "anim_bike_fast_north",
        frames: [{ duration: 2, frame: 411, h_flip: false }],
      },
      west: {
        anim_cmd_symbol: "anim_bike_fast_west",
        frames: [{ duration: 2, frame: 412, h_flip: false }],
      },
      east: {
        anim_cmd_symbol: "anim_bike_fast_east",
        frames: [{ duration: 2, frame: 413, h_flip: false }],
      },
    },
    bike_faster: {
      south: {
        anim_cmd_symbol: "anim_bike_faster_south",
        frames: [{ duration: 2, frame: 420, h_flip: false }],
      },
      north: {
        anim_cmd_symbol: "anim_bike_faster_north",
        frames: [{ duration: 2, frame: 421, h_flip: false }],
      },
      west: {
        anim_cmd_symbol: "anim_bike_faster_west",
        frames: [{ duration: 2, frame: 422, h_flip: false }],
      },
      east: {
        anim_cmd_symbol: "anim_bike_faster_east",
        frames: [{ duration: 2, frame: 423, h_flip: false }],
      },
    },
    bike_fastest: {
      south: {
        anim_cmd_symbol: "anim_bike_fastest_south",
        frames: [{ duration: 1, frame: 430, h_flip: false }],
      },
      north: {
        anim_cmd_symbol: "anim_bike_fastest_north",
        frames: [{ duration: 1, frame: 431, h_flip: false }],
      },
      west: {
        anim_cmd_symbol: "anim_bike_fastest_west",
        frames: [{ duration: 1, frame: 432, h_flip: false }],
      },
      east: {
        anim_cmd_symbol: "anim_bike_fastest_east",
        frames: [{ duration: 1, frame: 433, h_flip: false }],
      },
    },
    acro_moving_wheelie: {
      south: {
        anim_cmd_symbol: "anim_acro_moving_wheelie_south",
        frames: [{ duration: 2, frame: 440, h_flip: false }],
      },
      north: {
        anim_cmd_symbol: "anim_acro_moving_wheelie_north",
        frames: [{ duration: 2, frame: 441, h_flip: false }],
      },
      west: {
        anim_cmd_symbol: "anim_acro_moving_wheelie_west",
        frames: [{ duration: 2, frame: 442, h_flip: false }],
      },
      east: {
        anim_cmd_symbol: "anim_acro_moving_wheelie_east",
        frames: [{ duration: 2, frame: 443, h_flip: false }],
      },
    },
    acro_bunny_hop_front_wheel: {
      south: {
        anim_cmd_symbol: "anim_acro_bunny_hop_front_south",
        frames: [{ duration: 2, frame: 450, h_flip: false }],
      },
      north: {
        anim_cmd_symbol: "anim_acro_bunny_hop_front_north",
        frames: [{ duration: 2, frame: 451, h_flip: false }],
      },
      west: {
        anim_cmd_symbol: "anim_acro_bunny_hop_front_west",
        frames: [{ duration: 2, frame: 452, h_flip: false }],
      },
      east: {
        anim_cmd_symbol: "anim_acro_bunny_hop_front_east",
        frames: [{ duration: 2, frame: 453, h_flip: false }],
      },
    },
    acro_side_jump_front_wheel: {
      south: {
        anim_cmd_symbol: "anim_acro_side_jump_south",
        frames: [{ duration: 2, frame: 454, h_flip: false }],
      },
      north: {
        anim_cmd_symbol: "anim_acro_side_jump_north",
        frames: [{ duration: 2, frame: 455, h_flip: false }],
      },
      west: {
        anim_cmd_symbol: "anim_acro_side_jump_west",
        frames: [{ duration: 2, frame: 456, h_flip: false }],
      },
      east: {
        anim_cmd_symbol: "anim_acro_side_jump_east",
        frames: [{ duration: 2, frame: 457, h_flip: false }],
      },
    },
    acro_turn_jump_front_wheel: {
      south: {
        anim_cmd_symbol: "anim_acro_turn_jump_south",
        frames: [{ duration: 2, frame: 458, h_flip: false }],
      },
      north: {
        anim_cmd_symbol: "anim_acro_turn_jump_north",
        frames: [{ duration: 2, frame: 459, h_flip: false }],
      },
      west: {
        anim_cmd_symbol: "anim_acro_turn_jump_west",
        frames: [{ duration: 2, frame: 464, h_flip: false }],
      },
      east: {
        anim_cmd_symbol: "anim_acro_turn_jump_east",
        frames: [{ duration: 2, frame: 465, h_flip: false }],
      },
    },
    acro_ledge_hop_front_wheel: {
      south: {
        anim_cmd_symbol: "anim_acro_ledge_hop_front_south",
        frames: [{ duration: 2, frame: 466, h_flip: false }],
      },
      north: {
        anim_cmd_symbol: "anim_acro_ledge_hop_front_north",
        frames: [{ duration: 2, frame: 467, h_flip: false }],
      },
      west: {
        anim_cmd_symbol: "anim_acro_ledge_hop_front_west",
        frames: [{ duration: 2, frame: 468, h_flip: false }],
      },
      east: {
        anim_cmd_symbol: "anim_acro_ledge_hop_front_east",
        frames: [{ duration: 2, frame: 469, h_flip: false }],
      },
    },
    acro_bunny_hop_back_wheel: {
      south: {
        anim_cmd_symbol: "anim_acro_bunny_hop_back_south",
        loop_mode: "end_hold",
        frames: [
          { duration: 4, frame: 460, h_flip: false },
          { duration: 4, frame: 461, h_flip: false },
          { duration: 4, frame: 462, h_flip: false },
          { duration: 4, frame: 463, h_flip: false },
        ],
      },
      north: {
        anim_cmd_symbol: "anim_acro_bunny_hop_back_north",
        loop_mode: "end_hold",
        frames: [
          { duration: 4, frame: 460, h_flip: false },
          { duration: 4, frame: 461, h_flip: false },
          { duration: 4, frame: 462, h_flip: false },
          { duration: 4, frame: 463, h_flip: false },
        ],
      },
      west: {
        anim_cmd_symbol: "anim_acro_bunny_hop_back_west",
        loop_mode: "end_hold",
        frames: [
          { duration: 4, frame: 460, h_flip: false },
          { duration: 4, frame: 461, h_flip: false },
          { duration: 4, frame: 462, h_flip: false },
          { duration: 4, frame: 463, h_flip: false },
        ],
      },
      east: {
        anim_cmd_symbol: "anim_acro_bunny_hop_back_east",
        loop_mode: "end_hold",
        frames: [
          { duration: 4, frame: 460, h_flip: false },
          { duration: 4, frame: 461, h_flip: false },
          { duration: 4, frame: 462, h_flip: false },
          { duration: 4, frame: 463, h_flip: false },
        ],
      },
    },
    acro_ledge_hop_back_wheel: {
      south: {
        anim_cmd_symbol: "anim_acro_ledge_hop_back_south",
        frames: [{ duration: 2, frame: 474, h_flip: false }],
      },
      north: {
        anim_cmd_symbol: "anim_acro_ledge_hop_back_north",
        frames: [{ duration: 2, frame: 475, h_flip: false }],
      },
      west: {
        anim_cmd_symbol: "anim_acro_ledge_hop_back_west",
        frames: [{ duration: 2, frame: 476, h_flip: false }],
      },
      east: {
        anim_cmd_symbol: "anim_acro_ledge_hop_back_east",
        frames: [{ duration: 2, frame: 477, h_flip: false }],
      },
    },
    acro_standing_wheelie_front_wheel: {
      south: {
        anim_cmd_symbol: "anim_acro_standing_wheelie_front_south",
        frames: [{ duration: 2, frame: 470, h_flip: false }],
      },
      north: {
        anim_cmd_symbol: "anim_acro_standing_wheelie_front_north",
        frames: [{ duration: 2, frame: 471, h_flip: false }],
      },
      west: {
        anim_cmd_symbol: "anim_acro_standing_wheelie_front_west",
        frames: [{ duration: 2, frame: 472, h_flip: false }],
      },
      east: {
        anim_cmd_symbol: "anim_acro_standing_wheelie_front_east",
        frames: [{ duration: 2, frame: 473, h_flip: false }],
      },
    },
    acro_standing_wheelie_back_wheel: {
      south: {
        anim_cmd_symbol: "anim_acro_standing_wheelie_back_south",
        frames: [{ duration: 2, frame: 480, h_flip: false }],
      },
      north: {
        anim_cmd_symbol: "anim_acro_standing_wheelie_back_north",
        frames: [{ duration: 2, frame: 481, h_flip: false }],
      },
      west: {
        anim_cmd_symbol: "anim_acro_standing_wheelie_back_west",
        frames: [{ duration: 2, frame: 482, h_flip: false }],
      },
      east: {
        anim_cmd_symbol: "anim_acro_standing_wheelie_back_east",
        frames: [{ duration: 2, frame: 483, h_flip: false }],
      },
    },
    acro_wheelie_in_place: {
      south: {
        anim_cmd_symbol: "anim_acro_wheelie_in_place_south",
        frames: [{ duration: 2, frame: 484, h_flip: false }],
      },
      north: {
        anim_cmd_symbol: "anim_acro_wheelie_in_place_north",
        frames: [{ duration: 2, frame: 485, h_flip: false }],
      },
      west: {
        anim_cmd_symbol: "anim_acro_wheelie_in_place_west",
        frames: [{ duration: 2, frame: 486, h_flip: false }],
      },
      east: {
        anim_cmd_symbol: "anim_acro_wheelie_in_place_east",
        frames: [{ duration: 2, frame: 487, h_flip: false }],
      },
    },
    acro_wheelie_face: {
      south: {
        anim_cmd_symbol: "anim_acro_wheelie_face_south",
        frames: [{ duration: 2, frame: 440, h_flip: false }],
      },
      north: {
        anim_cmd_symbol: "anim_acro_wheelie_face_north",
        frames: [{ duration: 2, frame: 441, h_flip: false }],
      },
      west: {
        anim_cmd_symbol: "anim_acro_wheelie_face_west",
        frames: [{ duration: 2, frame: 442, h_flip: false }],
      },
      east: {
        anim_cmd_symbol: "anim_acro_wheelie_face_east",
        frames: [{ duration: 2, frame: 443, h_flip: false }],
      },
    },
    acro_pop_wheelie_stationary: {
      south: {
        anim_cmd_symbol: "anim_acro_pop_wheelie_stationary_south",
        loop_mode: "end_hold",
        frames: [
          { duration: 2, frame: 488, h_flip: false },
          { duration: 2, frame: 489, h_flip: false },
          { duration: 2, frame: 490, h_flip: false },
        ],
      },
      north: {
        anim_cmd_symbol: "anim_acro_pop_wheelie_stationary_north",
        loop_mode: "end_hold",
        frames: [
          { duration: 2, frame: 488, h_flip: false },
          { duration: 2, frame: 489, h_flip: false },
          { duration: 2, frame: 490, h_flip: false },
        ],
      },
      west: {
        anim_cmd_symbol: "anim_acro_pop_wheelie_stationary_west",
        loop_mode: "end_hold",
        frames: [
          { duration: 2, frame: 488, h_flip: false },
          { duration: 2, frame: 489, h_flip: false },
          { duration: 2, frame: 490, h_flip: false },
        ],
      },
      east: {
        anim_cmd_symbol: "anim_acro_pop_wheelie_stationary_east",
        loop_mode: "end_hold",
        frames: [
          { duration: 2, frame: 488, h_flip: false },
          { duration: 2, frame: 489, h_flip: false },
          { duration: 2, frame: 490, h_flip: false },
        ],
      },
    },
    acro_pop_wheelie_moving: {
      south: {
        anim_cmd_symbol: "anim_acro_pop_wheelie_moving_south",
        frames: [{ duration: 2, frame: 492, h_flip: false }],
      },
      north: {
        anim_cmd_symbol: "anim_acro_pop_wheelie_moving_north",
        frames: [{ duration: 2, frame: 493, h_flip: false }],
      },
      west: {
        anim_cmd_symbol: "anim_acro_pop_wheelie_moving_west",
        frames: [{ duration: 2, frame: 494, h_flip: false }],
      },
      east: {
        anim_cmd_symbol: "anim_acro_pop_wheelie_moving_east",
        frames: [{ duration: 2, frame: 495, h_flip: false }],
      },
    },
    acro_end_wheelie_stationary: {
      south: {
        anim_cmd_symbol: "anim_acro_end_wheelie_stationary_south",
        frames: [{ duration: 2, frame: 496, h_flip: false }],
      },
      north: {
        anim_cmd_symbol: "anim_acro_end_wheelie_stationary_north",
        frames: [{ duration: 2, frame: 497, h_flip: false }],
      },
      west: {
        anim_cmd_symbol: "anim_acro_end_wheelie_stationary_west",
        frames: [{ duration: 2, frame: 498, h_flip: false }],
      },
      east: {
        anim_cmd_symbol: "anim_acro_end_wheelie_stationary_east",
        frames: [{ duration: 2, frame: 499, h_flip: false }],
      },
    },
    acro_end_wheelie_moving: {
      south: {
        anim_cmd_symbol: "anim_acro_end_wheelie_moving_south",
        frames: [{ duration: 2, frame: 500, h_flip: false }],
      },
      north: {
        anim_cmd_symbol: "anim_acro_end_wheelie_moving_north",
        frames: [{ duration: 2, frame: 501, h_flip: false }],
      },
      west: {
        anim_cmd_symbol: "anim_acro_end_wheelie_moving_west",
        frames: [{ duration: 2, frame: 502, h_flip: false }],
      },
      east: {
        anim_cmd_symbol: "anim_acro_end_wheelie_moving_east",
        frames: [{ duration: 2, frame: 503, h_flip: false }],
      },
    },
  } satisfies PlayerAnimationAssets["animationSets"]["on_foot"]["actions"];

  const frameTextures = new Map<number, unknown>();
  for (const frame of [
    100, 101, 102, 103, 200, 201, 202, 203, 210, 211, 212, 213, 220, 221, 222,
    223, 230, 231, 232, 233, 300, 301, 302, 303, 310, 311, 312, 313, 320, 321,
    322, 323, 330, 331, 332, 333, 400, 401, 402, 403, 410, 411, 412, 413, 420,
    421, 422, 423, 430, 431, 432, 433, 440, 441, 442, 443, 450, 451, 452, 453,
    460, 461, 462, 463, 454, 455, 456, 457, 458, 459, 464, 465, 466, 467, 468,
    469, 470, 471, 472, 473, 474, 475, 476, 477, 480, 481, 482, 483, 484, 485,
    486, 487, 488, 489, 490, 491, 492, 493, 494, 495, 496, 497, 498, 499, 500,
    501, 502, 503,
  ]) {
    frameTextures.set(frame, {});
  }

  return {
    avatarId: "test-avatar",
    frameWidth: 16,
    frameHeight: 32,
    anchorX: 8,
    anchorY: 30,
    paletteColors: ["#000000"],
    reflectionPaletteColors: null,
    reflectionPaletteSourcePath: null,
    animationSets: {
      on_foot: {
        anim_table_symbol: "sAnimTable_BrendanMayNormal",
        actions: directionalBindings,
      },
      mach_bike: {
        anim_table_symbol: "sAnimTable_Standard",
        actions: {
          bike_walk: directionalBindings.bike_walk,
          bike_fast: directionalBindings.bike_fast,
          bike_faster: directionalBindings.bike_faster,
          bike_fastest: directionalBindings.bike_fastest,
          face: directionalBindings.face,
        },
      },
      acro_bike: {
        anim_table_symbol: "sAnimTable_AcroBike",
        actions: {
          bike_walk: directionalBindings.bike_walk,
          bike_fast: directionalBindings.bike_fast,
          bike_faster: directionalBindings.bike_faster,
          bike_fastest: directionalBindings.bike_fastest,
          acro_moving_wheelie: directionalBindings.acro_moving_wheelie,
          acro_bunny_hop_front_wheel:
            directionalBindings.acro_bunny_hop_front_wheel,
          acro_side_jump_front_wheel:
            directionalBindings.acro_side_jump_front_wheel,
          acro_turn_jump_front_wheel:
            directionalBindings.acro_turn_jump_front_wheel,
          acro_ledge_hop_front_wheel:
            directionalBindings.acro_ledge_hop_front_wheel,
          acro_bunny_hop_back_wheel:
            directionalBindings.acro_bunny_hop_back_wheel,
          acro_ledge_hop_back_wheel:
            directionalBindings.acro_ledge_hop_back_wheel,
          acro_standing_wheelie_front_wheel:
            directionalBindings.acro_standing_wheelie_front_wheel,
          acro_standing_wheelie_back_wheel:
            directionalBindings.acro_standing_wheelie_back_wheel,
          acro_wheelie_face: directionalBindings.acro_wheelie_face,
          acro_wheelie_in_place: directionalBindings.acro_wheelie_in_place,
          acro_pop_wheelie_stationary:
            directionalBindings.acro_pop_wheelie_stationary,
          acro_pop_wheelie_moving: directionalBindings.acro_pop_wheelie_moving,
          acro_end_wheelie_stationary:
            directionalBindings.acro_end_wheelie_stationary,
          acro_end_wheelie_moving: directionalBindings.acro_end_wheelie_moving,
          face: directionalBindings.face,
        },
      },
    },
    frameTextures: frameTextures as PlayerAnimationAssets["frameTextures"],
  };
}

import {
  AcroBikeSubstate,
  BikeTransitionType,
  TraversalState,
} from './protocol_generated';

export type PlayerMovementActionVisualInput = {
  traversalState: TraversalState;
  acroSubstate?: AcroBikeSubstate;
  bikeTransition?: BikeTransitionType;
};

export type PlayerMovementActionVisualState = {
  yOffsetPx: number;
  activeAction: 'none' | 'acro_wheelie_hop_face';
};

const ACRO_STATIONARY_HOP_TRANSITIONS = new Set<BikeTransitionType>([
  BikeTransitionType.HOP,
  BikeTransitionType.HOP_STANDING,
  BikeTransitionType.WHEELIE_HOPPING_MOVING,
  BikeTransitionType.WHEELIE_HOPPING_STANDING,
]);

// ROM parity reference: src/event_object_movement.c::sJumpY_Low (JUMP_TYPE_LOW).
const ACRO_JUMP_Y_LOW: readonly number[] = [
  0, -2, -3, -4, -5, -6, -6, -6,
  -5, -5, -4, -3, -2, 0, 0, 0,
];

const ACRO_STATIONARY_HOP_TICKS = ACRO_JUMP_Y_LOW.length;

export class PlayerMovementActionRuntime {
  private authoritativeInput: PlayerMovementActionVisualInput = {
    traversalState: TraversalState.ON_FOOT,
    acroSubstate: AcroBikeSubstate.NONE,
    bikeTransition: BikeTransitionType.NONE,
  };

  private activeAction: PlayerMovementActionVisualState['activeAction'] = 'none';
  private yOffsetPx = 0;
  private jumpTimer = 0;
  private hopCycleActive = false;

  setAuthoritativeInput(input: PlayerMovementActionVisualInput): void {
    const wasHopCapable = this.shouldRunAcroHop();
    this.authoritativeInput = {
      traversalState: input.traversalState,
      acroSubstate: input.acroSubstate ?? AcroBikeSubstate.NONE,
      bikeTransition: input.bikeTransition ?? BikeTransitionType.NONE,
    };

    const isHopCapable = this.shouldRunAcroHop();
    if (!isHopCapable) {
      this.resetActionState();
      return;
    }

    // Treat authoritative bike runtime updates as state corrections only.
    // Once we are in a stationary hop-capable transition, hop phase progression
    // is locally clocked by the client tick loop and must not depend on
    // receiving repeated BikeRuntimeDelta packets.
    if (!wasHopCapable && isHopCapable) {
      this.hopCycleActive = true;
    }
  }

  tickTicks(ticks: number): void {
    const clampedTicks = Math.max(0, Math.min(256, Math.floor(ticks)));
    for (let index = 0; index < clampedTicks; index += 1) {
      this.stepOneTick();
    }
  }

  getVisualState(): PlayerMovementActionVisualState {
    return {
      yOffsetPx: this.yOffsetPx,
      activeAction: this.activeAction,
    };
  }

  private stepOneTick(): void {
    if (!this.shouldRunAcroHop()) {
      this.resetActionState();
      return;
    }

    if (!this.hopCycleActive) {
      this.hopCycleActive = true;
      this.activeAction = 'none';
      this.jumpTimer = 0;
      this.yOffsetPx = 0;
    }

    if (this.activeAction === 'none') {
      this.activeAction = 'acro_wheelie_hop_face';
      this.jumpTimer = 0;
    }

    this.yOffsetPx = ACRO_JUMP_Y_LOW[this.jumpTimer] ?? 0;
    this.jumpTimer += 1;

    if (this.jumpTimer >= ACRO_STATIONARY_HOP_TICKS) {
      // Match ROM completion semantics: action reports finished, then can restart.
      this.activeAction = 'none';
      this.jumpTimer = 0;
      this.yOffsetPx = 0;
    }
  }

  private shouldRunAcroHop(): boolean {
    if (this.authoritativeInput.traversalState !== TraversalState.ACRO_BIKE) {
      return false;
    }
    return (
      ACRO_STATIONARY_HOP_TRANSITIONS.has(
        this.authoritativeInput.bikeTransition ?? BikeTransitionType.NONE,
      ) ||
      this.authoritativeInput.acroSubstate === AcroBikeSubstate.BUNNY_HOP
    );
  }

  private resetActionState(): void {
    this.hopCycleActive = false;
    this.activeAction = 'none';
    this.jumpTimer = 0;
    this.yOffsetPx = 0;
  }
}

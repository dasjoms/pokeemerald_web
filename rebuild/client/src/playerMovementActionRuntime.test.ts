import { describe, expect, it } from 'vitest';

import {
  AcroBikeSubstate,
  BikeTransitionType,
  TraversalState,
} from './protocol_generated';
import { PlayerMovementActionRuntime } from './playerMovementActionRuntime';

describe('PlayerMovementActionRuntime', () => {
  it('maps authoritative bunny-hop phase stream onto ROM low-jump Y offsets', () => {
    const runtime = new PlayerMovementActionRuntime();
    const samples: number[] = [];
    for (let tick = 0; tick < 16; tick += 1) {
      runtime.setAuthoritativeInput({
        traversalState: TraversalState.ACRO_BIKE,
        bikeTransition: BikeTransitionType.WHEELIE_HOPPING_STANDING,
        bunnyHopCycleTick: tick,
      });
      samples.push(runtime.getVisualState().yOffsetPx);
    }

    expect(samples).toEqual([0, -2, -3, -4, -5, -6, -6, -6, -5, -5, -4, -3, -2, 0, 0, 0]);
  });

  it('does not autonomously advance hop phase between authoritative updates', () => {
    const runtime = new PlayerMovementActionRuntime();
    runtime.setAuthoritativeInput({
      traversalState: TraversalState.ACRO_BIKE,
      bikeTransition: BikeTransitionType.HOP_STANDING,
      bunnyHopCycleTick: 5,
    });
    const first = runtime.getVisualState();

    runtime.tickTicks(16);
    expect(runtime.getVisualState()).toEqual(first);
  });

  it('clears y offset when leaving stationary hop transitions', () => {
    const runtime = new PlayerMovementActionRuntime();
    runtime.setAuthoritativeInput({
      traversalState: TraversalState.ACRO_BIKE,
      bikeTransition: BikeTransitionType.HOP,
      bunnyHopCycleTick: 4,
    });

    expect(runtime.getVisualState().yOffsetPx).toBeLessThan(0);

    runtime.setAuthoritativeInput({
      traversalState: TraversalState.ACRO_BIKE,
      bikeTransition: BikeTransitionType.WHEELIE_IDLE,
    });
    expect(runtime.getVisualState()).toEqual({
      yOffsetPx: 0,
      activeAction: 'none',
    });
  });

  it('matches ROM alignment at hop start, halfway, and landing', () => {
    const runtime = new PlayerMovementActionRuntime();
    runtime.setAuthoritativeInput({
      traversalState: TraversalState.ACRO_BIKE,
      bikeTransition: BikeTransitionType.WHEELIE_HOPPING_MOVING,
      bunnyHopCycleTick: 0,
    });
    expect(runtime.getVisualState().yOffsetPx).toBe(0);
    runtime.setAuthoritativeInput({
      traversalState: TraversalState.ACRO_BIKE,
      bikeTransition: BikeTransitionType.WHEELIE_HOPPING_MOVING,
      bunnyHopCycleTick: 8,
    });
    expect(runtime.getVisualState().yOffsetPx).toBe(-5);
    runtime.setAuthoritativeInput({
      traversalState: TraversalState.ACRO_BIKE,
      bikeTransition: BikeTransitionType.WHEELIE_HOPPING_MOVING,
      bunnyHopCycleTick: 15,
    });
    expect(runtime.getVisualState().yOffsetPx).toBe(0);
  });

  it('maintains hop arc continuity when transition clears but acro substate remains bunny hop', () => {
    const runtime = new PlayerMovementActionRuntime();
    runtime.setAuthoritativeInput({
      traversalState: TraversalState.ACRO_BIKE,
      acroSubstate: AcroBikeSubstate.BUNNY_HOP,
      bikeTransition: BikeTransitionType.WHEELIE_HOPPING_MOVING,
    });

    runtime.setAuthoritativeInput({
      traversalState: TraversalState.ACRO_BIKE,
      acroSubstate: AcroBikeSubstate.BUNNY_HOP,
      bikeTransition: BikeTransitionType.WHEELIE_HOPPING_MOVING,
      bunnyHopCycleTick: 5,
    });
    expect(runtime.getVisualState().yOffsetPx).toBe(-6);

    runtime.setAuthoritativeInput({
      traversalState: TraversalState.ACRO_BIKE,
      acroSubstate: AcroBikeSubstate.BUNNY_HOP,
      bikeTransition: BikeTransitionType.NONE,
      bunnyHopCycleTick: 6,
    });

    expect(runtime.getVisualState().yOffsetPx).toBe(-6);
  });
});

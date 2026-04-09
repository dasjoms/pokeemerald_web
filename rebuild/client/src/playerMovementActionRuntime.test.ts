import { describe, expect, it } from 'vitest';

import {
  BikeTransitionType,
  TraversalState,
} from './protocol_generated';
import { PlayerMovementActionRuntime } from './playerMovementActionRuntime';

describe('PlayerMovementActionRuntime', () => {
  it('runs a 16-tick stationary acro hop arc with ROM low-jump Y offsets', () => {
    const runtime = new PlayerMovementActionRuntime();
    runtime.setAuthoritativeInput({
      traversalState: TraversalState.ACRO_BIKE,
      bikeTransition: BikeTransitionType.WHEELIE_HOPPING_STANDING,
    });

    const samples: number[] = [];
    for (let tick = 0; tick < 16; tick += 1) {
      runtime.tickTicks(1);
      samples.push(runtime.getVisualState().yOffsetPx);
    }

    expect(samples).toEqual([0, -2, -3, -4, -5, -6, -6, -6, -5, -5, -4, -3, -2, 0, 0, 0]);
    expect(runtime.getVisualState().activeAction).toBe('none');
  });

  it('only restarts hop after action completion when transition remains active', () => {
    const runtime = new PlayerMovementActionRuntime();
    runtime.setAuthoritativeInput({
      traversalState: TraversalState.ACRO_BIKE,
      bikeTransition: BikeTransitionType.HOP_STANDING,
    });

    runtime.tickTicks(16);
    expect(runtime.getVisualState().activeAction).toBe('none');
    expect(runtime.getVisualState().yOffsetPx).toBe(0);

    runtime.tickTicks(1);
    expect(runtime.getVisualState().activeAction).toBe('acro_wheelie_hop_face');
    expect(runtime.getVisualState().yOffsetPx).toBe(0);
  });

  it('clears y offset when leaving stationary hop transitions', () => {
    const runtime = new PlayerMovementActionRuntime();
    runtime.setAuthoritativeInput({
      traversalState: TraversalState.ACRO_BIKE,
      bikeTransition: BikeTransitionType.HOP,
    });

    runtime.tickTicks(4);
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
});

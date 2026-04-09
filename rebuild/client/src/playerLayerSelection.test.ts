import { describe, expect, it } from 'vitest';
import {
  resolvePlayerLayerSampleTile,
  resolvePlayerRenderPriorityAtTile,
  type PlayerLayerTileContext,
} from './playerLayerSelection';

describe('resolvePlayerLayerSampleTile', () => {
  it('keeps the layer sample on the start foot tile until the walk step completes', () => {
    const inFlightSample = resolvePlayerLayerSampleTile({
      playerTileX: 11,
      playerTileY: 14,
      activeWalkTransition: {
        startX: 10,
        startY: 14,
        targetX: 11,
        targetY: 14,
        elapsedMs: 120,
        durationMs: 267,
      },
    });

    expect(inFlightSample).toEqual({ x: 10, y: 14 });

    const completeSample = resolvePlayerLayerSampleTile({
      playerTileX: 11,
      playerTileY: 14,
      activeWalkTransition: {
        startX: 10,
        startY: 14,
        targetX: 11,
        targetY: 14,
        elapsedMs: 267,
        durationMs: 267,
      },
    });

    expect(completeSample).toEqual({ x: 11, y: 14 });
  });
});

describe('Littleroot walk transition layer regression', () => {
  const COVERED_LAYER_TYPE = 1;
  const normalTile: PlayerLayerTileContext = {
    metatileLayerType: undefined,
    behaviorId: 0,
    layer1SubtileMask: 0,
  };
  const coveredTile: PlayerLayerTileContext = {
    metatileLayerType: COVERED_LAYER_TYPE,
    behaviorId: 0,
    layer1SubtileMask: 0,
  };
  const decorativeCoveredAdjacentTile: PlayerLayerTileContext = {
    metatileLayerType: COVERED_LAYER_TYPE,
    behaviorId: 33,
    layer1SubtileMask: 0b0001,
  };

  function resolveStratumForRoundedRenderTile(renderTileX: number): 'below-bg2' | 'between-bg2-bg1' {
    const sampledTileContext = Math.round(renderTileX) >= 11 ? coveredTile : normalTile;
    return resolvePlayerRenderPriorityAtTile(sampledTileContext, COVERED_LAYER_TYPE);
  }

  it('does not drop the full player below BG2 mid-step when crossing a covered/decorative-adjacent edge', () => {
    // Regression setup based on a Littleroot edge case: moving from a normal foot tile
    // into a covered tile with nearby decorative covered metatiles can flap strata when
    // sampling via Math.round(renderTileX).
    expect(resolveStratumForRoundedRenderTile(10.51)).toBe('below-bg2');
    expect(
      resolvePlayerRenderPriorityAtTile(decorativeCoveredAdjacentTile, COVERED_LAYER_TYPE),
    ).toBe('between-bg2-bg1');

    const sampleDuringStep = resolvePlayerLayerSampleTile({
      playerTileX: 11,
      playerTileY: 14,
      activeWalkTransition: {
        startX: 10,
        startY: 14,
        targetX: 11,
        targetY: 14,
        elapsedMs: 120,
        durationMs: 267,
      },
    });
    const stratumDuringStep = resolvePlayerRenderPriorityAtTile(normalTile, COVERED_LAYER_TYPE);
    expect(sampleDuringStep).toEqual({ x: 10, y: 14 });
    expect(stratumDuringStep).toBe('between-bg2-bg1');

    const sampleAfterStep = resolvePlayerLayerSampleTile({
      playerTileX: 11,
      playerTileY: 14,
      activeWalkTransition: null,
    });
    const stratumAfterStep = resolvePlayerRenderPriorityAtTile(coveredTile, COVERED_LAYER_TYPE);
    expect(sampleAfterStep).toEqual({ x: 11, y: 14 });
    expect(stratumAfterStep).toBe('below-bg2');
  });
});

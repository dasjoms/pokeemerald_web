import { describe, expect, it } from 'vitest';
import {
  buildLayerSubtileOccupancy,
  encodeSubtileSlotBit,
  resolvePlayerLayerSampleTile,
  resolvePlayerRenderPriority,
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
  const normalTile: PlayerLayerTileContext = {
    metatileLayerType: undefined,
    behaviorId: 0,
    layer0SubtileMask: 0,
    layer1SubtileMask: 0,
    hasLayer0: false,
    hasLayer1: false,
  };
  const coveredTile: PlayerLayerTileContext = {
    metatileLayerType: 1,
    behaviorId: 0,
    layer0SubtileMask: 0,
    layer1SubtileMask: 0,
    hasLayer0: false,
    hasLayer1: false,
  };
  const decorativeCoveredAdjacentTile: PlayerLayerTileContext = {
    metatileLayerType: 1,
    behaviorId: 33,
    layer0SubtileMask: 0,
    layer1SubtileMask: 0b0001,
    hasLayer0: false,
    hasLayer1: true,
  };

  function resolveStratumForRoundedRenderTile(renderTileX: number): 'below-bg2' | 'between-bg2-bg1' {
    const sampledTileContext = Math.round(renderTileX) >= 11 ? coveredTile : normalTile;
    return resolvePlayerRenderPriority({
      objectPriorityState: 'normal',
      tileContext: sampledTileContext,
    });
  }

  it('does not drop the full player below BG2 mid-step when crossing a covered/decorative-adjacent edge', () => {
    // Regression setup based on a Littleroot edge case: moving from a normal foot tile
    // into a covered tile with nearby decorative covered metatiles can flap strata when
    // sampling via Math.round(renderTileX).
    expect(resolveStratumForRoundedRenderTile(10.51)).toBe('between-bg2-bg1');
    expect(
      resolvePlayerRenderPriority({
        objectPriorityState: 'normal',
        tileContext: decorativeCoveredAdjacentTile,
      }),
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
    const stratumDuringStep = resolvePlayerRenderPriority({
      objectPriorityState: 'normal',
      tileContext: normalTile,
    });
    expect(sampleDuringStep).toEqual({ x: 10, y: 14 });
    expect(stratumDuringStep).toBe('between-bg2-bg1');

    const sampleAfterStep = resolvePlayerLayerSampleTile({
      playerTileX: 11,
      playerTileY: 14,
      activeWalkTransition: null,
    });
    const stratumAfterStep = resolvePlayerRenderPriority({
      objectPriorityState: 'normal',
      tileContext: coveredTile,
    });
    expect(sampleAfterStep).toEqual({ x: 11, y: 14 });
    expect(stratumAfterStep).toBe('between-bg2-bg1');
  });

  it('keeps the player visible on Littleroot covered tiles with behavior 0', () => {
    const littlerootCoveredBehavior0: PlayerLayerTileContext = {
      metatileLayerType: 1,
      behaviorId: 0,
      layer0SubtileMask: 0,
      layer1SubtileMask: 0b0011,
      hasLayer0: false,
      hasLayer1: true,
    };

    expect(
      resolvePlayerRenderPriority({
        objectPriorityState: 'normal',
        tileContext: littlerootCoveredBehavior0,
      }),
    ).toBe('between-bg2-bg1');
  });
});

describe('subtile occupancy encoding', () => {
  it('keeps subtile slots 4..7 distinct from 0..3', () => {
    const occupancy = buildLayerSubtileOccupancy([
      { subtile_index: 0, layer: 0 },
      { subtile_index: 4, layer: 0 },
      { subtile_index: 7, layer: 1 },
    ]);

    expect(occupancy.layer0SubtileMask).toBe(encodeSubtileSlotBit(0) | encodeSubtileSlotBit(4));
    expect(occupancy.layer1SubtileMask).toBe(encodeSubtileSlotBit(7));
    expect(occupancy.hasLayer0).toBe(true);
    expect(occupancy.hasLayer1).toBe(true);
  });

  it('does not merge layer slots that share the same low two bits', () => {
    const occupancy = buildLayerSubtileOccupancy([
      { subtile_index: 1, layer: 0 },
      { subtile_index: 5, layer: 0 },
      { subtile_index: 1, layer: 1 },
      { subtile_index: 5, layer: 1 },
    ]);

    expect(occupancy.layer0SubtileMask).toBe(encodeSubtileSlotBit(1) | encodeSubtileSlotBit(5));
    expect(occupancy.layer1SubtileMask).toBe(encodeSubtileSlotBit(1) | encodeSubtileSlotBit(5));
    expect(occupancy.layer0SubtileMask & encodeSubtileSlotBit(5)).not.toBe(0);
    expect(occupancy.layer1SubtileMask & encodeSubtileSlotBit(5)).not.toBe(0);
  });
});

describe('resolvePlayerRenderPriority', () => {
  it('renders below BG2 only for explicit object priority state', () => {
    expect(
      resolvePlayerRenderPriority({
        objectPriorityState: 'below-bg2',
      }),
    ).toBe('below-bg2');
    expect(
      resolvePlayerRenderPriority({
        objectPriorityState: 'normal',
      }),
    ).toBe('between-bg2-bg1');
  });
});

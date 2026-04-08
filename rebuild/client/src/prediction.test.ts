import { describe, expect, it } from 'vitest';
import { Direction, RejectionReason, type WalkResult } from './protocol_generated';
import { applyPredictedStep, clampToMapBounds, reconcilePredictions } from './prediction';

describe('client prediction helpers', () => {
  it('clamps predicted steps to map bounds', () => {
    expect(applyPredictedStep({ x: 0, y: 0 }, Direction.LEFT, 4, 3)).toEqual({ x: 0, y: 0 });
    expect(applyPredictedStep({ x: 0, y: 0 }, Direction.UP, 4, 3)).toEqual({ x: 0, y: 0 });
    expect(applyPredictedStep({ x: 3, y: 2 }, Direction.RIGHT, 4, 3)).toEqual({ x: 3, y: 2 });
    expect(applyPredictedStep({ x: 3, y: 2 }, Direction.DOWN, 4, 3)).toEqual({ x: 3, y: 2 });
  });

  it('reconciles accepted authoritative result and reapplies pending inputs', () => {
    const pendingInputs = new Map<number, Direction>([
      [1, Direction.RIGHT],
      [2, Direction.DOWN],
      [3, Direction.DOWN],
    ]);

    const result = makeWalkResult({
      input_seq: 1,
      accepted: true,
      authoritative_pos: { x: 3, y: 0 },
      facing: Direction.RIGHT,
    });

    const reconciled = reconcilePredictions({
      result,
      pendingInputs,
      mapWidth: 4,
      mapHeight: 3,
    });

    expect(reconciled).toEqual({ tile: { x: 3, y: 2 }, facing: Direction.DOWN });
    expect([...pendingInputs.entries()]).toEqual([
      [2, Direction.DOWN],
      [3, Direction.DOWN],
    ]);
  });

  it('snaps to rejected authoritative result and clears incompatible predictions', () => {
    const pendingInputs = new Map<number, Direction>([
      [10, Direction.RIGHT],
      [11, Direction.UP],
      [12, Direction.LEFT],
    ]);

    const result = makeWalkResult({
      input_seq: 10,
      accepted: false,
      authoritative_pos: { x: 0, y: 1 },
      facing: Direction.LEFT,
      reason: RejectionReason.COLLISION,
    });

    const reconciled = reconcilePredictions({
      result,
      pendingInputs,
      mapWidth: 4,
      mapHeight: 3,
    });

    expect(reconciled).toEqual({ tile: { x: 0, y: 1 }, facing: Direction.LEFT });
    expect([...pendingInputs.entries()]).toEqual([]);
  });

  it('clamps authoritative coordinates during reconciliation', () => {
    const pendingInputs = new Map<number, Direction>();
    const result = makeWalkResult({
      input_seq: 2,
      accepted: true,
      authoritative_pos: { x: 999, y: 999 },
      facing: Direction.DOWN,
    });

    const reconciled = reconcilePredictions({
      result,
      pendingInputs,
      mapWidth: 4,
      mapHeight: 3,
    });

    expect(reconciled.tile).toEqual(clampToMapBounds({ x: 999, y: 999 }, 4, 3));
  });
});

function makeWalkResult(partial: Partial<WalkResult>): WalkResult {
  return {
    input_seq: 0,
    accepted: true,
    authoritative_pos: { x: 0, y: 0 },
    facing: Direction.DOWN,
    reason: RejectionReason.NONE,
    server_frame: 1,
    ...partial,
  };
}

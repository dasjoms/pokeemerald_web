import { Direction, type WalkResult } from './protocol_generated';

export type TilePos = {
  x: number;
  y: number;
};

export type PredictionReconcileInput = {
  result: WalkResult;
  pendingInputs: Map<number, Direction>;
  mapWidth: number;
  mapHeight: number;
};

export type PredictionReconcileOutput = {
  tile: TilePos;
  facing: Direction;
};

export function clampToMapBounds(position: TilePos, mapWidth: number, mapHeight: number): TilePos {
  const maxX = Math.max(0, mapWidth - 1);
  const maxY = Math.max(0, mapHeight - 1);
  return {
    x: clamp(position.x, 0, maxX),
    y: clamp(position.y, 0, maxY),
  };
}

export function applyPredictedStep(
  position: TilePos,
  direction: Direction,
  mapWidth: number,
  mapHeight: number,
): TilePos {
  const { dx, dy } = directionToDelta(direction);
  return clampToMapBounds(
    {
      x: position.x + dx,
      y: position.y + dy,
    },
    mapWidth,
    mapHeight,
  );
}

export function reconcilePredictions({
  result,
  pendingInputs,
  mapWidth,
  mapHeight,
}: PredictionReconcileInput): PredictionReconcileOutput {
  clearAcknowledgedInputs(pendingInputs, result.input_seq);

  let tile = clampToMapBounds(
    {
      x: result.authoritative_pos.x,
      y: result.authoritative_pos.y,
    },
    mapWidth,
    mapHeight,
  );
  let facing = result.facing;

  if (!result.accepted) {
    clearInputsAfter(pendingInputs, result.input_seq);
    return { tile, facing };
  }

  const orderedPendingSeqs = [...pendingInputs.keys()].sort((a, b) => a - b);
  for (const seq of orderedPendingSeqs) {
    const direction = pendingInputs.get(seq);
    if (direction === undefined) {
      continue;
    }

    tile = applyPredictedStep(tile, direction, mapWidth, mapHeight);
    facing = direction;
  }

  return { tile, facing };
}

function clearAcknowledgedInputs(pendingInputs: Map<number, Direction>, acknowledgedSeq: number): void {
  for (const seq of pendingInputs.keys()) {
    if (seq <= acknowledgedSeq) {
      pendingInputs.delete(seq);
    }
  }
}

function clearInputsAfter(pendingInputs: Map<number, Direction>, inputSeq: number): void {
  for (const seq of pendingInputs.keys()) {
    if (seq > inputSeq) {
      pendingInputs.delete(seq);
    }
  }
}

function directionToDelta(direction: Direction): { dx: number; dy: number } {
  switch (direction) {
    case Direction.UP:
      return { dx: 0, dy: -1 };
    case Direction.DOWN:
      return { dx: 0, dy: 1 };
    case Direction.LEFT:
      return { dx: -1, dy: 0 };
    case Direction.RIGHT:
      return { dx: 1, dy: 0 };
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

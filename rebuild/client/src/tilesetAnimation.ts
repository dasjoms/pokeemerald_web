export type CopyTilesOp = {
  kind: 'copy_tiles';
  pageId: number;
  destLocalTileIndex: number;
  sourceFrameLocalTileIndex: number;
  tileCount: number;
};

export type CopyPaletteOp = {
  kind: 'copy_palette';
  tilesetName: string;
  destPaletteIndex: number;
  sourcePaletteIndex: number;
};

export type BlendPaletteOp = {
  kind: 'blend_palette';
  tilesetName: string;
  destPaletteIndex: number;
  sourcePaletteAIndex: number;
  sourcePaletteBIndex: number;
  coeffA: number;
  coeffB: number;
};

export type TilesetAnimOp = CopyTilesOp | CopyPaletteOp | BlendPaletteOp;
export type TilesetAnimCallback = (counter: number, primaryCounterMax: number) => { ops?: TilesetAnimOp[] };

type ProgramRole = 'primary' | 'secondary';

type TilesetAnimGate = { mod: number; eq: number };
type TilesetAnimCopyDef = {
  source_expr: string;
  frame_array: string | null;
  dest_tile_indices: number[];
  size_tiles: number | null;
};
type TilesetAnimPaletteDef = {
  source_expr: string;
  palette_slot: number;
  frame_array: string | null;
};
type TilesetAnimAction = {
  args: string;
  copy_ops: TilesetAnimCopyDef[];
  palette_ops: TilesetAnimPaletteDef[];
};

type TilesetAnimEvent = {
  gate: TilesetAnimGate;
  actions: TilesetAnimAction[];
};

type TilesetAnimProgram = {
  source_tileset: string;
  counter_max_expr: string | null;
  events: TilesetAnimEvent[];
};

export type TileAnimsFile = {
  tile_anims_version: number;
  pair_id: string;
  programs: {
    primary: TilesetAnimProgram;
    secondary: TilesetAnimProgram;
  };
  frame_arrays: Record<string, number[]>;
  frame_payloads?: Array<{
    payload_id: number;
    symbol_name: string;
    payload_offset: number;
    tile_count: number | null;
    byte_count: number;
    expected_copy_size_tiles: number[];
  }>;
  frame_payload_blob?: string;
};

const SUPPORTED_TILE_ANIMS_VERSION = 2;

export type TilesetAnimationState = {
  pairId: string;
  primaryTileset: string;
  secondaryTileset: string;
  primaryCounter: number;
  primaryCounterMax: number;
  secondaryCounter: number;
  secondaryCounterMax: number;
  primaryCallback: TilesetAnimCallback | null;
  secondaryCallback: TilesetAnimCallback | null;
  queuedTileCopies: Map<string, CopyTilesOp>;
  queuedPaletteCopies: Map<string, CopyPaletteOp>;
  queuedPaletteBlends: Map<string, BlendPaletteOp>;
  accumulatorMs: number;
  tickSerial: number;
};

function logParityError(message: string): void {
  if (import.meta.env.DEV) {
    console.error(`[tileset-parity] ${message}`);
  }
}

function parseCounterMax(expr: string | null | undefined, primaryCounterMax: number): number {
  if (!expr) return primaryCounterMax;
  if (expr === 'sPrimaryTilesetAnimCounterMax') return primaryCounterMax;
  const parsed = Number.parseInt(expr, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : primaryCounterMax;
}

function parseActionArgs(args: string, counter: number): Record<string, number> {
  const vars: Record<string, number> = { timer: counter };
  const tokens = args.split(',').map((token) => token.trim()).filter(Boolean);
  if (tokens.length > 0) {
    vars.i = evaluateExpression(tokens[0]!, vars, 1) ?? 0;
    vars.timer_div = vars.i;
  }
  if (tokens.length > 1) {
    vars.timer_mod = evaluateExpression(tokens[1]!, vars, 1) ?? 0;
  }
  return vars;
}

function evaluateExpression(expr: string, vars: Record<string, number>, frameArrayLength: number): number | null {
  const withArrayCount = expr.replace(/ARRAY_COUNT\([^)]*\)/g, `${frameArrayLength}`);
  const replacedVars = withArrayCount.replace(/\b[a-zA-Z_][a-zA-Z0-9_]*\b/g, (name) => {
    if (Object.hasOwn(vars, name)) {
      return `${vars[name]}`;
    }
    return name;
  });
  if (!/^[0-9+\-*/%()\s]+$/.test(replacedVars)) {
    return null;
  }
  try {
    const value = Function(`"use strict"; return (${replacedVars});`)();
    if (typeof value !== 'number' || !Number.isFinite(value)) return null;
    return Math.floor(value);
  } catch {
    return null;
  }
}

function normalizeFrameIndex(frameIndex: number, frameArrayLength: number): number {
  if (frameArrayLength <= 0) return 0;
  const mod = frameIndex % frameArrayLength;
  return mod < 0 ? mod + frameArrayLength : mod;
}

function compileProgramCallback(
  tileAnims: TileAnimsFile,
  role: ProgramRole,
  primaryTileCount: number,
): TilesetAnimCallback | null {
  const program = tileAnims.programs[role];
  if (!program?.events?.length) return null;

  const pageId = role === 'primary' ? 0 : 1;
  const sourceTileset = program.source_tileset;

  return (counter) => {
    const ops: TilesetAnimOp[] = [];

    for (const event of program.events) {
      if (counter % event.gate.mod !== event.gate.eq) continue;

      for (const action of event.actions) {
        const vars = parseActionArgs(action.args, counter);

        for (const copyOp of action.copy_ops) {
          if (!copyOp.frame_array || !copyOp.dest_tile_indices.length || !copyOp.size_tiles) {
            continue;
          }
          const frameArray = tileAnims.frame_arrays[copyOp.frame_array];
          if (!frameArray?.length) {
            logParityError(`${tileAnims.pair_id} missing frame array ${copyOp.frame_array}`);
            continue;
          }

          const sourceExprMatch = copyOp.source_expr.match(/\[[^\]]+\]/);
          const rawFrameExpr = sourceExprMatch?.[0]?.slice(1, -1) ?? '0';
          const frameIndexRaw = evaluateExpression(rawFrameExpr, vars, frameArray.length);
          if (frameIndexRaw === null) {
            logParityError(`${tileAnims.pair_id} unable to parse frame expr '${rawFrameExpr}'`);
            continue;
          }
          const frameEntry = frameArray[normalizeFrameIndex(frameIndexRaw, frameArray.length)];
          if (frameEntry === null || frameEntry === undefined) {
            logParityError(`${tileAnims.pair_id} missing frame source for ${copyOp.frame_array}[${frameIndexRaw}]`);
            continue;
          }

          for (const destTileIndex of copyOp.dest_tile_indices) {
            const localDest = role === 'primary' ? destTileIndex : destTileIndex - primaryTileCount;
            if (localDest < 0) {
              logParityError(`${tileAnims.pair_id} invalid destination tile index ${destTileIndex} for ${role}`);
              continue;
            }
            ops.push({
              kind: 'copy_tiles',
              pageId,
              destLocalTileIndex: localDest,
              sourceFrameLocalTileIndex: localDest + frameEntry * copyOp.size_tiles,
              tileCount: copyOp.size_tiles,
            });
          }
        }

        for (const paletteOp of action.palette_ops) {
          if (!paletteOp.frame_array) continue;
          const frameArray = tileAnims.frame_arrays[paletteOp.frame_array];
          if (!frameArray?.length) {
            logParityError(`${tileAnims.pair_id} missing palette frame array ${paletteOp.frame_array}`);
            continue;
          }
          const sourceExprMatch = paletteOp.source_expr.match(/\[[^\]]+\]/);
          const rawFrameExpr = sourceExprMatch?.[0]?.slice(1, -1) ?? '0';
          const frameIndexRaw = evaluateExpression(rawFrameExpr, vars, frameArray.length);
          if (frameIndexRaw === null) {
            logParityError(`${tileAnims.pair_id} unable to parse palette frame expr '${rawFrameExpr}'`);
            continue;
          }
          const frameEntry = frameArray[normalizeFrameIndex(frameIndexRaw, frameArray.length)];
          if (frameEntry === null || frameEntry === undefined) {
            logParityError(`${tileAnims.pair_id} missing palette frame source for ${paletteOp.frame_array}[${frameIndexRaw}]`);
            continue;
          }

          ops.push({
            kind: 'copy_palette',
            tilesetName: sourceTileset,
            destPaletteIndex: paletteOp.palette_slot,
            sourcePaletteIndex: paletteOp.palette_slot + frameEntry,
          });
        }
      }
    }

    return ops.length > 0 ? { ops } : {};
  };
}

export function createTilesetAnimationState(
  tileAnims: TileAnimsFile,
  primaryTileCount: number,
): TilesetAnimationState {
  if (tileAnims.tile_anims_version !== SUPPORTED_TILE_ANIMS_VERSION) {
    throw new Error(
      `Unsupported tile_anims_version=${tileAnims.tile_anims_version} for ${tileAnims.pair_id}; expected ${SUPPORTED_TILE_ANIMS_VERSION}`,
    );
  }
  const primaryCounterMax = parseCounterMax(tileAnims.programs.primary.counter_max_expr, 256);
  const secondaryExpr = tileAnims.programs.secondary.counter_max_expr;
  const secondaryCounterMax = parseCounterMax(secondaryExpr, primaryCounterMax);

  return {
    pairId: tileAnims.pair_id,
    primaryTileset: tileAnims.programs.primary.source_tileset,
    secondaryTileset: tileAnims.programs.secondary.source_tileset,
    primaryCounter: 0,
    primaryCounterMax,
    secondaryCounter: secondaryExpr === 'sPrimaryTilesetAnimCounterMax' ? 0 : 0,
    secondaryCounterMax,
    primaryCallback: compileProgramCallback(tileAnims, 'primary', primaryTileCount),
    secondaryCallback: compileProgramCallback(tileAnims, 'secondary', primaryTileCount),
    queuedTileCopies: new Map(),
    queuedPaletteCopies: new Map(),
    queuedPaletteBlends: new Map(),
    accumulatorMs: 0,
    tickSerial: 0,
  };
}

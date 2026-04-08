export type CopyTilesOp = {
  kind: 'copy_tiles';
  pageId: number;
  destLocalTileIndex: number;
  sourcePayloadOffsetTiles: number;
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
  framePayloadTileIndices: Uint8Array | null;
  framePayloadTileCount: number;
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

type FramePayloadRef = { offsetTiles: number; tileCount: number };
type PreparedProgram = { callback: TilesetAnimCallback | null; validationErrors: string[] };

function decode4bppTilePayload(payloadBlob: Uint8Array): Uint8Array {
  const tileCount = Math.floor(payloadBlob.length / 32);
  const decoded = new Uint8Array(tileCount * 64);
  for (let tile = 0; tile < tileCount; tile += 1) {
    const byteBase = tile * 32;
    const outBase = tile * 64;
    for (let i = 0; i < 32; i += 1) {
      const packed = payloadBlob[byteBase + i] ?? 0;
      decoded[outBase + i * 2] = packed & 0x0f;
      decoded[outBase + i * 2 + 1] = (packed >> 4) & 0x0f;
    }
  }
  return decoded;
}

function prepareFramePayloadRefs(
  tileAnims: TileAnimsFile,
  role: ProgramRole,
  payloadBlob: Uint8Array | null,
): {
  frameArrayPayloadRefs: Map<string, FramePayloadRef[]>;
  validationErrors: string[];
} {
  const program = tileAnims.programs[role];
  const refsById = new Map<number, FramePayloadRef>();
  const validationErrors: string[] = [];
  const frameArrayPayloadRefs = new Map<string, FramePayloadRef[]>();
  const payloadTileCapacity = payloadBlob ? Math.floor(payloadBlob.length / 32) : 0;

  for (const payload of tileAnims.frame_payloads ?? []) {
    const derivedTileCount = payload.tile_count ?? Math.floor(payload.byte_count / 32);
    if (derivedTileCount <= 0) {
      validationErrors.push(`payload_id=${payload.payload_id} has invalid tile_count`);
      continue;
    }
    const offsetTiles = Math.floor(payload.payload_offset / 32);
    if ((payload.payload_offset % 32) !== 0) {
      validationErrors.push(`payload_id=${payload.payload_id} has unaligned payload_offset=${payload.payload_offset}`);
      continue;
    }
    if (payloadBlob && offsetTiles + derivedTileCount > payloadTileCapacity) {
      validationErrors.push(`payload_id=${payload.payload_id} exceeds blob tile capacity (${payloadTileCapacity})`);
      continue;
    }
    refsById.set(payload.payload_id, { offsetTiles, tileCount: derivedTileCount });
  }

  for (const event of program.events) {
    for (const action of event.actions) {
      for (const copyOp of action.copy_ops) {
        if (!copyOp.frame_array || !copyOp.size_tiles) continue;
        const frameArray = tileAnims.frame_arrays[copyOp.frame_array];
        if (!frameArray?.length) {
          validationErrors.push(`missing frame array ${copyOp.frame_array}`);
          continue;
        }
        const refs: FramePayloadRef[] = [];
        for (let i = 0; i < frameArray.length; i += 1) {
          const payloadId = frameArray[i];
          const payloadRef = payloadId === null || payloadId === undefined ? null : refsById.get(payloadId);
          if (!payloadRef) {
            validationErrors.push(`frame ${copyOp.frame_array}[${i}] does not resolve to payload_id=${payloadId}`);
            continue;
          }
          if (copyOp.size_tiles > payloadRef.tileCount) {
            validationErrors.push(
              `copy size_tiles=${copyOp.size_tiles} exceeds payload_id=${payloadId} capacity=${payloadRef.tileCount}`,
            );
            continue;
          }
          refs.push(payloadRef);
        }
        if (refs.length === frameArray.length) {
          frameArrayPayloadRefs.set(copyOp.frame_array, refs);
        }
      }
    }
  }

  return { frameArrayPayloadRefs, validationErrors };
}

function compileProgramCallback(
  tileAnims: TileAnimsFile,
  role: ProgramRole,
  primaryTileCount: number,
  frameArrayPayloadRefs: Map<string, FramePayloadRef[]>,
): PreparedProgram {
  const program = tileAnims.programs[role];
  if (!program?.events?.length) return { callback: null, validationErrors: [] };

  const pageId = role === 'primary' ? 0 : 1;
  const sourceTileset = program.source_tileset;
  const validationErrors: string[] = [];

  const callback: TilesetAnimCallback = (counter) => {
    const ops: TilesetAnimOp[] = [];

    for (const event of program.events) {
      if (counter % event.gate.mod !== event.gate.eq) continue;

      for (const action of event.actions) {
        const vars = parseActionArgs(action.args, counter);

        for (const copyOp of action.copy_ops) {
          if (!copyOp.frame_array || !copyOp.dest_tile_indices.length || !copyOp.size_tiles) {
            continue;
          }
          const framePayloadRefs = frameArrayPayloadRefs.get(copyOp.frame_array);
          if (!framePayloadRefs?.length) {
            validationErrors.push(`missing resolved frame payload refs for ${copyOp.frame_array}`);
            continue;
          }

          const sourceExprMatch = copyOp.source_expr.match(/\[[^\]]+\]/);
          const rawFrameExpr = sourceExprMatch?.[0]?.slice(1, -1) ?? '0';
          const frameIndexRaw = evaluateExpression(rawFrameExpr, vars, framePayloadRefs.length);
          if (frameIndexRaw === null) {
            logParityError(`${tileAnims.pair_id} unable to parse frame expr '${rawFrameExpr}'`);
            continue;
          }
          const framePayload = framePayloadRefs[normalizeFrameIndex(frameIndexRaw, framePayloadRefs.length)];
          if (!framePayload) {
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
              sourcePayloadOffsetTiles: framePayload.offsetTiles,
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
  return { callback, validationErrors };
}

export function createTilesetAnimationState(
  tileAnims: TileAnimsFile,
  primaryTileCount: number,
  framePayloadBlob: Uint8Array | null = null,
): TilesetAnimationState {
  if (tileAnims.tile_anims_version !== SUPPORTED_TILE_ANIMS_VERSION) {
    throw new Error(
      `Unsupported tile_anims_version=${tileAnims.tile_anims_version} for ${tileAnims.pair_id}; expected ${SUPPORTED_TILE_ANIMS_VERSION}`,
    );
  }
  const primaryCounterMax = parseCounterMax(tileAnims.programs.primary.counter_max_expr, 256);
  const secondaryExpr = tileAnims.programs.secondary.counter_max_expr;
  const secondaryCounterMax = parseCounterMax(secondaryExpr, primaryCounterMax);
  const decodedFramePayloadTileIndices = framePayloadBlob ? decode4bppTilePayload(framePayloadBlob) : null;

  const primaryPayloadRefs = prepareFramePayloadRefs(tileAnims, 'primary', framePayloadBlob);
  const secondaryPayloadRefs = prepareFramePayloadRefs(tileAnims, 'secondary', framePayloadBlob);
  const primaryPrepared = compileProgramCallback(
    tileAnims,
    'primary',
    primaryTileCount,
    primaryPayloadRefs.frameArrayPayloadRefs,
  );
  const secondaryPrepared = compileProgramCallback(
    tileAnims,
    'secondary',
    primaryTileCount,
    secondaryPayloadRefs.frameArrayPayloadRefs,
  );
  const primaryErrors = [...primaryPayloadRefs.validationErrors, ...primaryPrepared.validationErrors];
  const secondaryErrors = [...secondaryPayloadRefs.validationErrors, ...secondaryPrepared.validationErrors];
  if (primaryErrors.length > 0) {
    logParityError(`${tileAnims.pair_id} disabled primary program after parity validation errors: ${[...new Set(primaryErrors)].join('; ')}`);
  }
  if (secondaryErrors.length > 0) {
    logParityError(`${tileAnims.pair_id} disabled secondary program after parity validation errors: ${[...new Set(secondaryErrors)].join('; ')}`);
  }

  return {
    pairId: tileAnims.pair_id,
    primaryTileset: tileAnims.programs.primary.source_tileset,
    secondaryTileset: tileAnims.programs.secondary.source_tileset,
    primaryCounter: 0,
    primaryCounterMax,
    secondaryCounter: secondaryExpr === 'sPrimaryTilesetAnimCounterMax' ? 0 : 0,
    secondaryCounterMax,
    primaryCallback: primaryErrors.length > 0 ? null : primaryPrepared.callback,
    secondaryCallback: secondaryErrors.length > 0 ? null : secondaryPrepared.callback,
    queuedTileCopies: new Map(),
    queuedPaletteCopies: new Map(),
    queuedPaletteBlends: new Map(),
    accumulatorMs: 0,
    tickSerial: 0,
    framePayloadTileIndices: decodedFramePayloadTileIndices,
    framePayloadTileCount: decodedFramePayloadTileIndices ? Math.floor(decodedFramePayloadTileIndices.length / 64) : 0,
  };
}

import { Rectangle, Texture } from 'pixi.js';
import {
  AcroBikeSubstate,
  BikeTransitionType,
  Direction,
  TraversalState,
} from './protocol_generated';
import { decodeIndexed4bppPngFromUrl } from './metatileRenderer';

type Cardinal = 'south' | 'north' | 'west' | 'east';
type AnimationKind = 'face' | 'walk' | 'run';
type TraversalMode = 'on_foot' | 'mach_bike' | 'acro_bike';

type AnimationFrameMeta = {
  duration: number;
  frame: number;
  h_flip: boolean;
};

type AnimationLoopMode = 'loop' | 'end_hold';

type DirectionalAnimationMeta = {
  action_id?: string;
  anim_cmd_symbol: string;
  loop_mode?: AnimationLoopMode;
  frames: AnimationFrameMeta[];
};

type AvatarDefinition = {
  avatar_id: string;
  animation_sets: Record<
    TraversalMode,
    {
      anim_table_symbol: string;
      actions: Record<string, Record<Cardinal, DirectionalAnimationMeta>>;
    }
  >;
  frame_atlas: Record<
    string,
    {
      rect: { x: number; y: number; w: number; h: number };
      sheet_symbol: string;
    }
  >;
  graphics: {
    width: number;
    height: number;
    anchor: {
      mode: 'bottom_center';
      x: number;
      y: number;
    };
  };
  palettes: {
    normal: {
      colors: string[];
      symbol: string;
    };
    reflection?: {
      colors: string[];
      symbol: string;
      source_path?: string;
    };
  };
  sheet_sources: Record<
    'normal' | 'running' | 'mach_bike' | 'acro_bike',
    {
      source_path: string;
      symbol: string;
    }
  >;
};

type PlayerManifest = {
  avatars: AvatarDefinition[];
};

export type PlayerFrameSelection = {
  texture: Texture;
  hFlip: boolean;
};

export type PlayerAnimationDebugState = {
  animId: string;
  frameIndex: number;
  stridePhase: 0 | 1;
  mode: AnimationKind;
  direction: Cardinal;
};

export type PlayerAnimationAssets = {
  avatarId: string;
  frameWidth: number;
  frameHeight: number;
  anchorX: number;
  anchorY: number;
  paletteColors: string[];
  reflectionPaletteColors: string[] | null;
  reflectionPaletteSourcePath: string | null;
  animationSets: AvatarDefinition['animation_sets'];
  frameTextures: Map<number, Texture>;
};

type PlayerAnimationLoadOptions = {
  avatarId: 'brendan' | 'may';
  loadJsonFromAssets: <T>(repoRelativePath: string) => Promise<T>;
  resolveImageUrlFromAssets: (repoRelativePath: string) => Promise<string>;
};

type PlayerAnimationMode = {
  kind: AnimationKind;
  direction: Cardinal;
};

const WALK_ALTERNATION_REMAP = new Map<number, number>([
  [1, 2],
  [3, 0],
]);

const TICK_60HZ_MS = 1000 / 60;

export async function loadPlayerAnimationAssets(
  options: PlayerAnimationLoadOptions,
): Promise<PlayerAnimationAssets> {
  const manifest = await options.loadJsonFromAssets<PlayerManifest>('players/players_manifest.json');
  const avatar = manifest.avatars.find((entry) => entry.avatar_id === options.avatarId);
  if (!avatar) {
    throw new Error(`missing player avatar metadata for avatar_id=${options.avatarId}`);
  }

  const sheetTexturesBySymbol = new Map<string, Texture>();
  await Promise.all(
    Object.values(avatar.sheet_sources).map(async (source) => {
      const texture = await loadBaseTexture(
        options.resolveImageUrlFromAssets,
        resolveSheetPngPathFromManifest(source.source_path),
        avatar.palettes.normal.colors,
      );
      sheetTexturesBySymbol.set(source.symbol, texture);
    }),
  );

  const frameTextures = new Map<number, Texture>();
  for (const [frameIdRaw, atlasEntry] of Object.entries(avatar.frame_atlas)) {
    const frameId = Number(frameIdRaw);
    if (Number.isNaN(frameId)) {
      continue;
    }

    const baseTexture = sheetTexturesBySymbol.get(atlasEntry.sheet_symbol);
    if (!baseTexture) {
      throw new Error(
        `missing sheet texture binding for symbol=${atlasEntry.sheet_symbol} frame=${frameId}`,
      );
    }
    const texture = new Texture({
      source: baseTexture.source,
      frame: new Rectangle(
        atlasEntry.rect.x,
        atlasEntry.rect.y,
        atlasEntry.rect.w,
        atlasEntry.rect.h,
      ),
    });
    frameTextures.set(frameId, texture);
  }

  return {
    avatarId: avatar.avatar_id,
    frameWidth: avatar.graphics.width,
    frameHeight: avatar.graphics.height,
    anchorX: avatar.graphics.anchor.x,
    anchorY: avatar.graphics.anchor.y,
    paletteColors: avatar.palettes.normal.colors,
    reflectionPaletteColors: avatar.palettes.reflection?.colors ?? null,
    reflectionPaletteSourcePath: avatar.palettes.reflection?.source_path ?? null,
    animationSets: avatar.animation_sets,
    frameTextures,
  };
}

function resolveSheetPngPathFromManifest(sourcePath: string): string {
  return sourcePath
    .replace(/^graphics\/object_events\/pics\/people\//, 'players/')
    .replace(/\.4bpp$/i, '.png');
}

async function loadBaseTexture(
  resolveImageUrlFromAssets: PlayerAnimationLoadOptions['resolveImageUrlFromAssets'],
  repoRelativePath: string,
  paletteColors: string[],
): Promise<Texture> {
  const imageUrl = await resolveImageUrlFromAssets(repoRelativePath);
  const decodedSheet = await decodeIndexed4bppPngFromUrl(imageUrl, Number.MAX_SAFE_INTEGER);
  const texture = bakeIndexedPlayerSheetTexture(
    decodedSheet.width,
    decodedSheet.height,
    decodedSheet.tileIndices,
    paletteColors,
  );
  return texture;
}

export function buildPlayerSheetRgba(
  width: number,
  height: number,
  indices: Uint8Array,
  paletteColors: string[],
): Uint8ClampedArray<ArrayBuffer> {
  const expectedSize = width * height;
  if (indices.length !== expectedSize) {
    throw new Error(`player sheet indices length mismatch: expected=${expectedSize}, actual=${indices.length}`);
  }

  const rgba = new Uint8ClampedArray(new ArrayBuffer(expectedSize * 4));
  for (let index = 0; index < indices.length; index += 1) {
    const paletteIndex = indices[index] ?? 0;
    const [r, g, b] = parseHexPaletteColor(paletteColors[paletteIndex]);
    const outOffset = index * 4;
    rgba[outOffset] = r;
    rgba[outOffset + 1] = g;
    rgba[outOffset + 2] = b;
    rgba[outOffset + 3] = paletteIndex === 0 ? 0 : 0xff;
  }
  return rgba;
}

function bakeIndexedPlayerSheetTexture(
  width: number,
  height: number,
  indices: Uint8Array,
  paletteColors: string[],
): Texture {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('Failed to create 2D context for player sheet texture baking');
  }

  ctx.imageSmoothingEnabled = false;
  const rgba = buildPlayerSheetRgba(width, height, indices, paletteColors);
  ctx.putImageData(new ImageData(rgba, width, height), 0, 0);
  const texture = Texture.from(canvas);
  texture.source.scaleMode = 'nearest';
  return texture;
}

function parseHexPaletteColor(color: string | undefined): [number, number, number] {
  if (!color) {
    return [0, 0, 0];
  }

  const match = /^#?([0-9a-f]{6})$/i.exec(color.trim());
  if (!match) {
    return [0, 0, 0];
  }

  const packed = Number.parseInt(match[1], 16);
  return [(packed >> 16) & 0xff, (packed >> 8) & 0xff, packed & 0xff];
}

export class PlayerAnimationController {
  private readonly assets: PlayerAnimationAssets;
  private mode: PlayerAnimationMode = { kind: 'face', direction: 'south' };
  private traversalState: TraversalState = TraversalState.ON_FOOT;
  private machSpeedStage = 0;
  private acroSubstate: AcroBikeSubstate = AcroBikeSubstate.NONE;
  private bikeTransition: BikeTransitionType = BikeTransitionType.NONE;
  private pendingMode: PlayerAnimationMode | null = null;
  private frameCommandIndex = 0;
  private ticksUntilAdvance = 0;
  private tickAccumulatorMs = 0;
  private stridePhase: 0 | 1 = 0;

  constructor(assets: PlayerAnimationAssets) {
    this.assets = assets;
    this.resetFrameTimer();
  }

  setFacing(direction: Direction): void {
    this.mode.direction = mapDirection(direction);
    this.resetFrameTimer();
  }

  stopMoving(direction: Direction): void {
    this.pendingMode = {
      kind: 'face',
      direction: mapDirection(direction),
    };
  }

  setTraversalState(state: {
    traversalState: TraversalState;
    machSpeedStage?: number;
    acroSubstate?: AcroBikeSubstate;
    bikeTransition?: BikeTransitionType;
  }): void {
    this.traversalState = state.traversalState;
    this.machSpeedStage = state.machSpeedStage ?? 0;
    this.acroSubstate = state.acroSubstate ?? AcroBikeSubstate.NONE;
    this.bikeTransition = state.bikeTransition ?? BikeTransitionType.NONE;
    this.resetFrameTimer();
  }

  applyPendingModeChanges(): void {
    if (!this.pendingMode) {
      return;
    }

    this.mode = this.pendingMode;
    this.pendingMode = null;
    this.stridePhase = 0;
    const frameCount = this.currentDirectionalAnimation().frames.length;
    if (this.frameCommandIndex >= frameCount) {
      this.frameCommandIndex = 0;
    }
    this.resetFrameTimer();
  }

  startWalkStep(direction: Direction): void {
    this.startStep(direction, 'walk');
  }

  startRunStep(direction: Direction): void {
    this.startStep(direction, 'run');
  }

  startStep(direction: Direction, mode: 'walk' | 'run'): void {
    this.pendingMode = null;
    const cardinal = mapDirection(direction);
    if (this.mode.kind === mode) {
      this.frameCommandIndex =
        WALK_ALTERNATION_REMAP.get(this.frameCommandIndex) ?? this.frameCommandIndex;
      this.stridePhase = this.stridePhase === 0 ? 1 : 0;
    }

    this.mode = {
      kind: mode,
      direction: cardinal,
    };
    this.resetFrameTimer();
  }

  tick(deltaMs: number): void {
    this.tickAccumulatorMs += Math.max(0, deltaMs);
    let ticksToRun = Math.floor(this.tickAccumulatorMs / TICK_60HZ_MS);
    if (ticksToRun <= 0) {
      return;
    }

    this.tickAccumulatorMs -= ticksToRun * TICK_60HZ_MS;
    this.tickTicks(Math.min(ticksToRun, 8));
  }

  tickTicks(ticksToRun: number): void {
    const clampedTicksToRun = Math.max(0, Math.min(256, ticksToRun));
    for (let tick = 0; tick < clampedTicksToRun; tick += 1) {
      this.stepOneTick();
    }
  }

  getCurrentFrame(): PlayerFrameSelection {
    const command = this.currentCommand();
    const texture = this.assets.frameTextures.get(command.frame);
    if (!texture) {
      throw new Error(`missing texture for player frame ${command.frame}`);
    }

    return {
      texture,
      hFlip: command.h_flip,
    };
  }

  getDebugState(): PlayerAnimationDebugState {
    return {
      animId: this.currentDirectionalAnimation().anim_cmd_symbol,
      frameIndex: this.currentCommand().frame,
      stridePhase: this.stridePhase,
      mode: this.mode.kind,
      direction: this.mode.direction,
    };
  }

  private stepOneTick(): void {
    this.ticksUntilAdvance -= 1;
    if (this.ticksUntilAdvance > 0) {
      return;
    }

    const directionalAnimation = this.currentDirectionalAnimation();
    const commands = directionalAnimation.frames;
    const isEndHold = directionalAnimation.loop_mode === 'end_hold';
    const lastCommandIndex = commands.length - 1;
    if (isEndHold && this.frameCommandIndex >= lastCommandIndex) {
      this.frameCommandIndex = lastCommandIndex;
      this.ticksUntilAdvance = Number.MAX_SAFE_INTEGER;
      return;
    }

    this.frameCommandIndex = (this.frameCommandIndex + 1) % commands.length;
    this.resetFrameTimer();
  }

  private resetFrameTimer(): void {
    this.ticksUntilAdvance = Math.max(1, this.currentCommand().duration);
  }

  private currentCommand(): AnimationFrameMeta {
    const commands = this.currentDirectionalAnimation().frames;
    const command = commands[this.frameCommandIndex] ?? commands[0];
    if (!command) {
      throw new Error('player animation command list is empty');
    }
    return command;
  }

  private currentDirectionalAnimation(): DirectionalAnimationMeta {
    const modeSet = this.resolveCurrentAnimationSet();
    const action = modeSet.actions[this.resolveCurrentActionId()] ?? modeSet.actions.face;
    const directional = action?.[this.mode.direction] ?? modeSet.actions.face?.south;
    if (!directional) {
      throw new Error('player directional animation binding is missing');
    }
    return directional;
  }

  private resolveCurrentAnimationSet(): PlayerAnimationAssets['animationSets'][TraversalMode] {
    if (this.traversalState === TraversalState.MACH_BIKE) {
      return this.assets.animationSets.mach_bike;
    }
    if (this.traversalState === TraversalState.ACRO_BIKE) {
      return this.assets.animationSets.acro_bike;
    }
    return this.assets.animationSets.on_foot;
  }

  private resolveCurrentActionId(): string {
    if (this.mode.kind === 'face') {
      if (this.traversalState !== TraversalState.ACRO_BIKE) {
        return 'face';
      }
      return this.resolveAcroStationaryActionId();
    }

    if (this.traversalState === TraversalState.ACRO_BIKE) {
      return this.resolveAcroMovingActionId();
    }

    if (this.traversalState === TraversalState.MACH_BIKE) {
      return this.resolveBikeSpeedActionId();
    }

    return this.mode.kind;
  }

  private resolveBikeSpeedActionId(): string {
    if (this.machSpeedStage >= 3) {
      return 'bike_fastest';
    }
    if (this.machSpeedStage === 2) {
      return 'bike_faster';
    }
    if (this.machSpeedStage === 1) {
      return 'bike_fast';
    }
    return 'bike_walk';
  }

  private resolveAcroStationaryActionId(): string {
    switch (this.bikeTransition) {
      case BikeTransitionType.WHEELIE_IDLE:
        return 'acro_wheelie_face';
      case BikeTransitionType.WHEELIE_POP:
      case BikeTransitionType.NORMAL_TO_WHEELIE:
      case BikeTransitionType.ENTER_WHEELIE:
        return 'acro_pop_wheelie_stationary';
      case BikeTransitionType.WHEELIE_END:
      case BikeTransitionType.WHEELIE_TO_NORMAL:
      case BikeTransitionType.EXIT_WHEELIE:
        return 'acro_end_wheelie_stationary';
      case BikeTransitionType.HOP:
      case BikeTransitionType.HOP_STANDING:
        return 'acro_bunny_hop_back_wheel';
      case BikeTransitionType.WHEELIE_HOPPING_STANDING:
        return 'acro_bunny_hop_back_wheel';
      default:
        break;
    }

    if (this.acroSubstate === AcroBikeSubstate.STANDING_WHEELIE) {
      return 'acro_wheelie_face';
    }
    if (this.acroSubstate === AcroBikeSubstate.BUNNY_HOP) {
      return 'acro_bunny_hop_back_wheel';
    }
    return 'face';
  }

  private resolveAcroMovingActionId(): string {
    switch (this.bikeTransition) {
      case BikeTransitionType.HOP_MOVING:
        return 'acro_ledge_hop_front_wheel';
      case BikeTransitionType.WHEELIE_HOPPING_MOVING:
        return 'acro_bunny_hop_front_wheel';
      case BikeTransitionType.SIDE_JUMP:
        return 'acro_side_jump_front_wheel';
      case BikeTransitionType.TURN_JUMP:
        return 'acro_turn_jump_front_wheel';
      case BikeTransitionType.WHEELIE_POP:
      case BikeTransitionType.NORMAL_TO_WHEELIE:
      case BikeTransitionType.WHEELIE_RISING_MOVING:
        return 'acro_pop_wheelie_moving';
      case BikeTransitionType.WHEELIE_END:
      case BikeTransitionType.WHEELIE_TO_NORMAL:
      case BikeTransitionType.WHEELIE_LOWERING_MOVING:
        return 'acro_end_wheelie_moving';
      case BikeTransitionType.WHEELIE_MOVING:
        return 'acro_moving_wheelie';
      default:
        break;
    }

    if (this.acroSubstate === AcroBikeSubstate.MOVING_WHEELIE) {
      return 'acro_moving_wheelie';
    }
    return this.resolveBikeSpeedActionId();
  }
}

function mapDirection(direction: Direction): Cardinal {
  switch (direction) {
    case Direction.UP:
      return 'north';
    case Direction.LEFT:
      return 'west';
    case Direction.RIGHT:
      return 'east';
    case Direction.DOWN:
    default:
      return 'south';
  }
}

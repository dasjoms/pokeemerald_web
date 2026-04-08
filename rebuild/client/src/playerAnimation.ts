import { Rectangle, Texture } from 'pixi.js';
import { Direction } from './protocol_generated';

type Cardinal = 'south' | 'north' | 'west' | 'east';
type AnimationKind = 'face' | 'walk';
type SpriteSheetKind = 'normal' | 'running';

type AnimationFrameMeta = {
  duration: number;
  frame: number;
  h_flip: boolean;
};

type DirectionalAnimationMeta = {
  anim_cmd_symbol: string;
  frames: AnimationFrameMeta[];
};

type AvatarDefinition = {
  avatar_id: string;
  animation_bindings: Record<AnimationKind, Record<Cardinal, DirectionalAnimationMeta>>;
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
    SpriteSheetKind,
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

export type PlayerAnimationAssets = {
  avatarId: string;
  frameWidth: number;
  frameHeight: number;
  anchorX: number;
  anchorY: number;
  paletteColors: string[];
  reflectionPaletteColors: string[] | null;
  reflectionPaletteSourcePath: string | null;
  directionalBindings: AvatarDefinition['animation_bindings'];
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

  const [walkingBaseTexture, runningBaseTexture] = await Promise.all([
    loadBaseTexture(
      options.resolveImageUrlFromAssets,
      resolveSheetPngPathFromManifest(avatar.sheet_sources.normal.source_path),
    ),
    loadBaseTexture(
      options.resolveImageUrlFromAssets,
      resolveSheetPngPathFromManifest(avatar.sheet_sources.running.source_path),
    ),
  ]);

  const frameTextures = new Map<number, Texture>();
  for (const [frameIdRaw, atlasEntry] of Object.entries(avatar.frame_atlas)) {
    const frameId = Number(frameIdRaw);
    if (Number.isNaN(frameId)) {
      continue;
    }

    const baseTexture = atlasEntry.sheet_symbol.includes('Running')
      ? runningBaseTexture
      : walkingBaseTexture;
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
    directionalBindings: avatar.animation_bindings,
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
): Promise<Texture> {
  const imageUrl = await resolveImageUrlFromAssets(repoRelativePath);
  return Texture.from(imageUrl);
}

export class PlayerAnimationController {
  private readonly assets: PlayerAnimationAssets;
  private mode: PlayerAnimationMode = { kind: 'face', direction: 'south' };
  private frameCommandIndex = 0;
  private ticksUntilAdvance = 0;
  private tickAccumulatorMs = 0;

  constructor(assets: PlayerAnimationAssets) {
    this.assets = assets;
    this.resetFrameTimer();
  }

  setIdle(direction: Direction): void {
    this.mode = {
      kind: 'face',
      direction: mapDirection(direction),
    };
    this.frameCommandIndex = 0;
    this.resetFrameTimer();
  }

  startWalkStep(direction: Direction): void {
    const cardinal = mapDirection(direction);
    if (this.mode.kind === 'walk') {
      this.frameCommandIndex =
        WALK_ALTERNATION_REMAP.get(this.frameCommandIndex) ?? this.frameCommandIndex;
    }

    this.mode = {
      kind: 'walk',
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
    ticksToRun = Math.min(ticksToRun, 8);
    for (let tick = 0; tick < ticksToRun; tick += 1) {
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

  private stepOneTick(): void {
    this.ticksUntilAdvance -= 1;
    if (this.ticksUntilAdvance > 0) {
      return;
    }

    const commands = this.currentDirectionalAnimation().frames;
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
    return this.assets.directionalBindings[this.mode.kind][this.mode.direction];
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

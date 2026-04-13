import { Rectangle, Sprite, Texture } from 'pixi.js';
import { decodeIndexed4bppPngFromUrl } from './metatileRenderer';
import { buildPlayerSheetRgba } from './playerAnimation';
import { Direction, HopLandingParticleClass } from './protocol_generated';
import {
  FIELD_EFFECTS_MANIFEST_PATH,
  type FieldEffectsManifest,
  type FieldEffectTemplate,
} from './fieldEffectsManifest';
import type { ContainerChild } from 'pixi.js';

type EffectKey =
  | 'ground_impact_dust'
  | 'jump_tall_grass'
  | 'jump_long_grass'
  | 'jump_small_splash'
  | 'jump_big_splash';

type RendererAssetLoaders = {
  loadJsonFromAssets: <T>(repoRelativePath: string) => Promise<T>;
  resolveImageUrlFromAssets: (repoRelativePath: string) => Promise<string>;
  loadJascPaletteHexColorsFromAssets: (repoRelativePath: string) => Promise<string[]>;
};

type SpawnEvent = {
  tileX: number;
  tileY: number;
  elevation: number;
  particleClass: HopLandingParticleClass;
  serverFrame: number;
  facing: Direction;
  useFieldEffectPriority: boolean;
};

type AnimationStep = {
  texture: Texture;
  durationMs: number;
};

type LoadedEffect = {
  steps: AnimationStep[];
};

type ActiveEffect = {
  sprite: Sprite;
  layer: HopParticleLayer;
  tileX: number;
  tileY: number;
  elevation: number;
  facing: Direction;
  useFieldEffectPriority: boolean;
  particleClass: HopLandingParticleClass;
  steps: AnimationStep[];
  stepIndex: number;
  stepElapsedMs: number;
};

type HopParticleLayer = {
  addChild: (...children: ContainerChild[]) => unknown;
  removeChild: (...children: ContainerChild[]) => unknown;
};

export type HopParticleDepthSample = {
  sprite: Sprite;
  screenY: number;
  halfHeightPx: number;
  elevation: number;
  facing: Direction;
  useFieldEffectPriority: boolean;
  particleClass: HopLandingParticleClass;
};

const ROM_TICK_MS = 1000 / 60;

const PALETTE_PATH_BY_EFFECT: Record<EffectKey, string> = {
  ground_impact_dust: 'field_effects/acro_bike/palettes/general_0.pal',
  jump_tall_grass: 'field_effects/acro_bike/palettes/general_1.pal',
  jump_long_grass: 'field_effects/acro_bike/palettes/general_1.pal',
  jump_small_splash: 'field_effects/acro_bike/palettes/general_0.pal',
  jump_big_splash: 'field_effects/acro_bike/palettes/general_0.pal',
};

const EFFECT_BY_CLASS: Record<HopLandingParticleClass, EffectKey> = {
  [HopLandingParticleClass.NORMAL_GROUND_DUST]: 'ground_impact_dust',
  [HopLandingParticleClass.TALL_GRASS_JUMP]: 'jump_tall_grass',
  [HopLandingParticleClass.LONG_GRASS_JUMP]: 'jump_long_grass',
  [HopLandingParticleClass.SHALLOW_WATER_SPLASH]: 'jump_small_splash',
  [HopLandingParticleClass.DEEP_WATER_SPLASH]: 'jump_big_splash',
};

const ROM_CENTER_Y_OFFSET_BY_CLASS: Record<HopLandingParticleClass, number> = {
  [HopLandingParticleClass.NORMAL_GROUND_DUST]: 12,
  [HopLandingParticleClass.TALL_GRASS_JUMP]: 12,
  [HopLandingParticleClass.LONG_GRASS_JUMP]: 8,
  [HopLandingParticleClass.SHALLOW_WATER_SPLASH]: 12,
  [HopLandingParticleClass.DEEP_WATER_SPLASH]: 8,
};

export class HopParticleRenderer {
  private readonly loadedEffectsByKey = new Map<EffectKey, LoadedEffect>();
  private readonly activeEffects: ActiveEffect[] = [];
  private lastConsumedServerFrame: number | null = null;

  constructor(
    private readonly resolveLayerForTile: (tileX: number, tileY: number) => HopParticleLayer,
    private readonly tileSize: number,
    private readonly assets: RendererAssetLoaders,
  ) {}

  async init(): Promise<void> {
    const manifest = await this.assets.loadJsonFromAssets<FieldEffectsManifest>(
      FIELD_EFFECTS_MANIFEST_PATH,
    );

    await Promise.all(
      Object.keys(PALETTE_PATH_BY_EFFECT).map(async (keyRaw) => {
        const key = keyRaw as EffectKey;
        const effect = manifest.effects[key]?.template;
        if (!effect) {
          throw new Error(`missing hop particle metadata for effect=${key}`);
        }
        const loaded = await this.loadEffect(effect, PALETTE_PATH_BY_EFFECT[key]);
        this.loadedEffectsByKey.set(key, loaded);
      }),
    );
  }

  onLandingEvent(input: SpawnEvent): void {
    if (this.lastConsumedServerFrame === input.serverFrame) {
      return;
    }
    this.lastConsumedServerFrame = input.serverFrame;

    const effectKey = EFFECT_BY_CLASS[input.particleClass] ?? 'ground_impact_dust';
    const effect = this.loadedEffectsByKey.get(effectKey);
    if (!effect || effect.steps.length === 0) {
      return;
    }

    const sprite = new Sprite(effect.steps[0].texture);
    sprite.anchor.set(0.5, 1);
    sprite.x = input.tileX * this.tileSize + this.tileSize / 2;
    const romCenterYOffset = ROM_CENTER_Y_OFFSET_BY_CLASS[input.particleClass] ?? 12;
    const spawnBottomYOffset = romCenterYOffset + sprite.texture.height / 2;
    sprite.y = input.tileY * this.tileSize + spawnBottomYOffset;
    const layer = this.resolveLayerForTile(input.tileX, input.tileY);
    layer.addChild(sprite as unknown as ContainerChild);
    const activeEffect: ActiveEffect = {
      sprite,
      layer,
      tileX: input.tileX,
      tileY: input.tileY,
      elevation: input.elevation,
      facing: input.facing,
      useFieldEffectPriority: input.useFieldEffectPriority,
      particleClass: input.particleClass,
      steps: effect.steps,
      stepIndex: 0,
      stepElapsedMs: 0,
    };
    this.activeEffects.push(activeEffect);
  }

  tick(deltaMs: number): void {
    if (this.activeEffects.length === 0) {
      return;
    }

    const safeDeltaMs = Math.max(0, deltaMs);
    for (let i = this.activeEffects.length - 1; i >= 0; i -= 1) {
      const active = this.activeEffects[i];
      this.ensureLayer(active);
      active.stepElapsedMs += safeDeltaMs;

      while (active.stepIndex < active.steps.length) {
        const currentStep = active.steps[active.stepIndex];
        if (active.stepElapsedMs < currentStep.durationMs) {
          break;
        }
        active.stepElapsedMs -= currentStep.durationMs;
        active.stepIndex += 1;
        if (active.stepIndex >= active.steps.length) {
          active.layer.removeChild(active.sprite as unknown as ContainerChild);
          active.sprite.destroy();
          this.activeEffects.splice(i, 1);
          break;
        }
        active.sprite.texture = active.steps[active.stepIndex].texture;
      }
    }
  }

  getDepthSamples(): HopParticleDepthSample[] {
    return this.activeEffects.map((active) => ({
      sprite: active.sprite,
      screenY: active.sprite.y,
      halfHeightPx: active.sprite.height * 0.5,
      elevation: active.elevation,
      facing: active.facing,
      useFieldEffectPriority: active.useFieldEffectPriority,
      particleClass: active.particleClass,
    }));
  }

  clear(): void {
    for (const active of this.activeEffects) {
      active.layer.removeChild(active.sprite as unknown as ContainerChild);
      active.sprite.destroy();
    }
    this.activeEffects.length = 0;
    this.lastConsumedServerFrame = null;
  }

  private async loadEffect(template: FieldEffectTemplate, palettePath: string): Promise<LoadedEffect> {
    const sourcePath = template.sources[0]?.source_path;
    if (!sourcePath) {
      throw new Error('missing particle source image path in effect template');
    }
    const pngPath = sourcePath
      .replace(/^graphics\/field_effects\/pics\//, 'field_effects/acro_bike/pics/')
      .replace(/\.4bpp$/i, '.png');
    const imageUrl = await this.assets.resolveImageUrlFromAssets(pngPath);
    const decodedSheet = await decodeIndexed4bppPngFromUrl(imageUrl, Number.MAX_SAFE_INTEGER);
    const paletteColors = await this.assets.loadJascPaletteHexColorsFromAssets(palettePath);
    const sheetRgba = buildPlayerSheetRgba(
      decodedSheet.width,
      decodedSheet.height,
      decodedSheet.tileIndices,
      paletteColors,
    );
    const baseTexture = bakeRgbaTexture(decodedSheet.width, decodedSheet.height, sheetRgba);

    const frameTextures = template.pic_table_entries.map((entry) => {
      const frameWidthPx = entry.tile_width * 8;
      const frameHeightPx = entry.tile_height * 8;
      const columns = Math.max(1, Math.floor(decodedSheet.width / frameWidthPx));
      const frameX = (entry.frame_index % columns) * frameWidthPx;
      const frameY = Math.floor(entry.frame_index / columns) * frameHeightPx;
      return new Texture({
        source: baseTexture.source,
        frame: new Rectangle(frameX, frameY, frameWidthPx, frameHeightPx),
      });
    });

    const animSymbol = template.anim_table.anim_cmd_symbols[0];
    const animFrames = template.anim_table.sequences[animSymbol] ?? [];
    return {
      steps: animFrames
        .map((frame) => ({
          texture: frameTextures[frame.frame],
          durationMs: frame.duration * ROM_TICK_MS,
        }))
        .filter((step) => step.texture !== undefined),
    };
  }

  private ensureLayer(active: ActiveEffect): void {
    const nextLayer = this.resolveLayerForTile(active.tileX, active.tileY);
    if (active.layer !== nextLayer) {
      active.layer.removeChild(active.sprite as unknown as ContainerChild);
      nextLayer.addChild(active.sprite as unknown as ContainerChild);
      active.layer = nextLayer;
    }
  }
}

function bakeRgbaTexture(width: number, height: number, rgba: Uint8ClampedArray<ArrayBufferLike>): Texture {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('failed to acquire 2d context while baking indexed texture');
  }
  ctx.putImageData(new ImageData(new Uint8ClampedArray(rgba), width, height), 0, 0);
  const texture = Texture.from(canvas);
  texture.source.scaleMode = 'nearest';
  return texture;
}

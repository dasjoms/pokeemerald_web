import { Container, Sprite, Texture } from 'pixi.js';
import type { ContainerChild } from 'pixi.js';
import { Direction, TraversalState } from './protocol_generated';
import {
  createBikeTireTrackVariantResolver,
  type BikeTireTrackAnimId,
  type BikeTireTrackManifestMetadata,
  type BikeTireTrackVariantResolver,
} from './bikeTireTrackTransitionResolver';

export const BIKE_EFFECT_TIRE_TRACKS = 1 << 0;
export const BIKE_EFFECT_HOP_SFX = 1 << 1;
export const BIKE_EFFECT_COLLISION_SFX = 1 << 2;
export const BIKE_EFFECT_CYCLING_BGM_MOUNT = 1 << 3;
export const BIKE_EFFECT_CYCLING_BGM_DISMOUNT = 1 << 4;

type BikeStepEffectEvent = {
  fromX: number;
  fromY: number;
  previousFacing: Direction;
  currentFacing: Direction;
  traversalState: TraversalState;
  bikeEffectFlags: number;
  serverFrame: number;
};

export type BikeTireTrackAtlasEntry = {
  texture: Texture;
  hFlip: boolean;
  vFlip: boolean;
};

export type BikeTireTrackAtlas = Record<BikeTireTrackAnimId, BikeTireTrackAtlasEntry>;

type ActiveTrackEffect = {
  sprite: Sprite;
  ageMs: number;
  lifetimeMs: number;
};

const TRACK_LIFETIME_MS = 420;
const TRACK_ALPHA = 0.52;

export class BikeEffectRenderer {
  private readonly effects: ActiveTrackEffect[] = [];
  private readonly variantResolver: BikeTireTrackVariantResolver;

  constructor(
    private readonly layer: Container,
    private readonly tileSize: number,
    private readonly tireTrackAtlas: BikeTireTrackAtlas,
    metadata: BikeTireTrackManifestMetadata,
  ) {
    this.variantResolver = createBikeTireTrackVariantResolver(metadata);
  }

  onAuthoritativeStep(event: BikeStepEffectEvent): void {
    if ((event.bikeEffectFlags & BIKE_EFFECT_TIRE_TRACKS) !== 0 && this.isBike(event.traversalState)) {
      this.spawnTireTrack(event);
    }

    if ((event.bikeEffectFlags & BIKE_EFFECT_HOP_SFX) !== 0) {
      console.debug(`[bike-sfx] SE_BIKE_HOP frame=${event.serverFrame}`);
    }
    if ((event.bikeEffectFlags & BIKE_EFFECT_COLLISION_SFX) !== 0) {
      console.debug(`[bike-sfx] wall-hit collision frame=${event.serverFrame}`);
    }
    if ((event.bikeEffectFlags & BIKE_EFFECT_CYCLING_BGM_MOUNT) !== 0) {
      console.debug(`[bike-bgm] transition=mount frame=${event.serverFrame}`);
    }
    if ((event.bikeEffectFlags & BIKE_EFFECT_CYCLING_BGM_DISMOUNT) !== 0) {
      console.debug(`[bike-bgm] transition=dismount frame=${event.serverFrame}`);
    }
  }

  tick(deltaMs: number): void {
    for (let i = this.effects.length - 1; i >= 0; i -= 1) {
      const effect = this.effects[i];
      effect.ageMs += Math.max(0, deltaMs);
      const t = Math.min(1, effect.ageMs / effect.lifetimeMs);
      effect.sprite.alpha = TRACK_ALPHA * (1 - t);
      if (t >= 1) {
        this.layer.removeChild(effect.sprite as unknown as ContainerChild);
        effect.sprite.destroy();
        this.effects.splice(i, 1);
      }
    }
  }

  clear(): void {
    for (const effect of this.effects) {
      this.layer.removeChild(effect.sprite as unknown as ContainerChild);
      effect.sprite.destroy();
    }
    this.effects.length = 0;
  }

  private isBike(traversalState: TraversalState): boolean {
    return (
      traversalState === TraversalState.MACH_BIKE || traversalState === TraversalState.ACRO_BIKE
    );
  }

  private spawnTireTrack(event: BikeStepEffectEvent): void {
    const variant = this.variantResolver(event.previousFacing, event.currentFacing);
    if (!variant) {
      console.warn(
        `[bike-effects] skipping tire track due to missing transition metadata previous=${event.previousFacing} current=${event.currentFacing}`,
      );
      return;
    }
    const atlasEntry = this.tireTrackAtlas[variant];
    const sprite = new Sprite(atlasEntry.texture);
    sprite.anchor.set(0.5, 0.5);
    sprite.scale.x = atlasEntry.hFlip ? -1 : 1;
    sprite.scale.y = atlasEntry.vFlip ? -1 : 1;
    sprite.alpha = TRACK_ALPHA;
    sprite.x = event.fromX * this.tileSize + this.tileSize / 2;
    sprite.y = event.fromY * this.tileSize + this.tileSize / 2;
    this.layer.addChild(sprite as unknown as ContainerChild);
    this.effects.push({ sprite, ageMs: 0, lifetimeMs: TRACK_LIFETIME_MS });
  }
}

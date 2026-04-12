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

type TrackEffectPhase = 'step0_hold' | 'step1_blink';

type ActiveTrackEffect = {
  sprite: Sprite;
  phase: TrackEffectPhase;
  timerFrames: number;
  visible: boolean;
};

const TRACK_ALPHA = 0.52;
const SIMULATION_FRAME_MS = 1000 / 60;

export class BikeEffectRenderer {
  private readonly effects: ActiveTrackEffect[] = [];
  private readonly variantResolver: BikeTireTrackVariantResolver;
  private readonly step0VisibleHoldThreshold: number;
  private readonly step1StopThreshold: number;
  private simulationFrameRemainder = 0;

  constructor(
    private readonly resolveLayerForTile: (tileX: number, tileY: number) => Container,
    private readonly tileSize: number,
    private readonly tireTrackAtlas: BikeTireTrackAtlas,
    metadata: BikeTireTrackManifestMetadata,
  ) {
    this.variantResolver = createBikeTireTrackVariantResolver(metadata);
    this.step0VisibleHoldThreshold = metadata.fade_timing.step0_wait_until_timer_gt;
    this.step1StopThreshold = metadata.fade_timing.step1_stop_when_timer_gt;
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
    const elapsedFrames = this.simulationFrameRemainder + Math.max(0, deltaMs) / SIMULATION_FRAME_MS;
    const wholeFrameTicks = Math.floor(elapsedFrames);
    this.simulationFrameRemainder = elapsedFrames - wholeFrameTicks;
    for (let frameTick = 0; frameTick < wholeFrameTicks; frameTick += 1) {
      this.tickOneFrame();
    }
  }

  clear(): void {
    for (const effect of this.effects) {
      this.removeSpriteFromParent(effect.sprite);
      effect.sprite.destroy();
    }
    this.effects.length = 0;
    this.simulationFrameRemainder = 0;
  }

  private isBike(traversalState: TraversalState): boolean {
    return (
      traversalState === TraversalState.MACH_BIKE || traversalState === TraversalState.ACRO_BIKE
    );
  }

  private tickOneFrame(): void {
    for (let i = this.effects.length - 1; i >= 0; i -= 1) {
      const effect = this.effects[i];
      effect.timerFrames += 1;

      if (effect.phase === 'step0_hold') {
        effect.visible = true;
        effect.sprite.visible = true;
        if (effect.timerFrames > this.step0VisibleHoldThreshold) {
          effect.phase = 'step1_blink';
        }
        continue;
      }

      effect.visible = !effect.visible;
      effect.sprite.visible = effect.visible;
      if (effect.timerFrames > this.step1StopThreshold) {
        this.removeSpriteFromParent(effect.sprite);
        effect.sprite.destroy();
        this.effects.splice(i, 1);
      }
    }
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
    sprite.visible = true;
    sprite.x = event.fromX * this.tileSize + this.tileSize / 2;
    sprite.y = event.fromY * this.tileSize + this.tileSize / 2;
    const layer = this.resolveLayerForTile(event.fromX, event.fromY);
    layer.addChild(sprite as unknown as ContainerChild);
    this.effects.push({
      sprite,
      phase: 'step0_hold',
      timerFrames: 0,
      visible: true,
    });
  }

  private removeSpriteFromParent(sprite: Sprite): void {
    const parent = sprite.parent;
    if (parent) {
      parent.removeChild(sprite as unknown as ContainerChild);
    }
  }
}

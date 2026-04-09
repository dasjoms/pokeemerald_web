import { Container, Graphics } from 'pixi.js';
import { Direction, TraversalState } from './protocol_generated';
import {
  BIKE_TIRE_TRACK_METADATA,
  type BikeTireTrackAnimId,
} from './bikeTireTracksMetadata';

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

type ActiveTrackEffect = {
  sprite: Graphics;
  ageMs: number;
  lifetimeMs: number;
};

const TRACK_LIFETIME_MS = 420;
const TRACK_STROKE_COLOR = 0x222222;
const TRACK_ALPHA = 0.52;

export class BikeEffectRenderer {
  private readonly effects: ActiveTrackEffect[] = [];

  constructor(
    private readonly layer: Container,
    private readonly tileSize: number,
  ) {}

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
        this.layer.removeChild(effect.sprite);
        effect.sprite.destroy();
        this.effects.splice(i, 1);
      }
    }
  }

  clear(): void {
    for (const effect of this.effects) {
      this.layer.removeChild(effect.sprite);
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
    const sprite = new Graphics();
    const variant = selectVariant(event.previousFacing, event.currentFacing);
    drawVariant(sprite, variant, this.tileSize);
    sprite.alpha = TRACK_ALPHA;
    sprite.x = event.fromX * this.tileSize + this.tileSize / 2;
    sprite.y = event.fromY * this.tileSize + this.tileSize / 2;
    this.layer.addChild(sprite);
    this.effects.push({ sprite, ageMs: 0, lifetimeMs: TRACK_LIFETIME_MS });
  }
}

function selectVariant(previousFacing: Direction, currentFacing: Direction): BikeTireTrackAnimId {
  if (previousFacing === currentFacing) {
    switch (currentFacing) {
      case Direction.UP:
        return 'north';
      case Direction.DOWN:
        return 'south';
      case Direction.LEFT:
        return 'west';
      case Direction.RIGHT:
        return 'east';
      default:
        return 'south';
    }
  }

  if (
    (previousFacing === Direction.DOWN && currentFacing === Direction.RIGHT) ||
    (previousFacing === Direction.LEFT && currentFacing === Direction.UP)
  ) {
    return 'se_corner_turn';
  }
  if (
    (previousFacing === Direction.DOWN && currentFacing === Direction.LEFT) ||
    (previousFacing === Direction.RIGHT && currentFacing === Direction.UP)
  ) {
    return 'sw_corner_turn';
  }
  if (
    (previousFacing === Direction.UP && currentFacing === Direction.LEFT) ||
    (previousFacing === Direction.RIGHT && currentFacing === Direction.DOWN)
  ) {
    return 'nw_corner_turn';
  }
  return 'ne_corner_turn';
}

function drawVariant(graphics: Graphics, variant: BikeTireTrackAnimId, tileSize: number): void {
  const half = tileSize / 2;
  const edge = tileSize * 0.22;
  graphics.clear();
  switch (variant) {
    case 'east':
    case 'west':
      graphics.moveTo(-half + 2, -edge);
      graphics.lineTo(half - 2, -edge);
      graphics.moveTo(-half + 2, edge);
      graphics.lineTo(half - 2, edge);
      break;
    case 'north':
    case 'south':
      graphics.moveTo(-edge, -half + 2);
      graphics.lineTo(-edge, half - 2);
      graphics.moveTo(edge, -half + 2);
      graphics.lineTo(edge, half - 2);
      break;
    case 'se_corner_turn':
    case 'sw_corner_turn':
    case 'nw_corner_turn':
    case 'ne_corner_turn':
      graphics.arc(0, 0, tileSize * 0.36, 0, Math.PI / 2);
      graphics.arc(0, 0, tileSize * 0.2, 0, Math.PI / 2);
      break;
    default:
      graphics.moveTo(0, -half + 2);
      graphics.lineTo(0, half - 2);
  }
  graphics.stroke({ width: 2, color: TRACK_STROKE_COLOR });
  // Reference to extracted frame table keeps metadata reachable in runtime code.
  void BIKE_TIRE_TRACK_METADATA.animations[variant];
}

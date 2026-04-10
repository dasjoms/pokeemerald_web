import { Container, Graphics } from 'pixi.js';
import { HopLandingParticleClass } from './protocol_generated';

type HopLandingBurst = {
  tileX: number;
  tileY: number;
  particleClass: HopLandingParticleClass;
  elapsedMs: number;
  lifetimeMs: number;
  sprite: Graphics;
};

const BASE_LIFETIME_MS = 190;

export class HopLandingParticleRenderer {
  private readonly activeBursts: HopLandingBurst[] = [];
  private lastConsumedServerFrame: number | null = null;

  constructor(
    private readonly layer: Container,
    private readonly tileSize: number,
  ) {}

  onLandingEvent(input: {
    tileX: number;
    tileY: number;
    particleClass: HopLandingParticleClass;
    serverFrame: number;
  }): void {
    if (this.lastConsumedServerFrame === input.serverFrame) {
      return;
    }
    this.lastConsumedServerFrame = input.serverFrame;

    const sprite = new Graphics();
    const color = this.colorForClass(input.particleClass);
    const radius = this.radiusForClass(input.particleClass);
    sprite.circle(0, 0, radius).fill({ color, alpha: 0.95 });
    sprite.x = input.tileX * this.tileSize + this.tileSize / 2;
    sprite.y = input.tileY * this.tileSize + this.tileSize;
    this.layer.addChild(sprite);
    this.activeBursts.push({
      tileX: input.tileX,
      tileY: input.tileY,
      particleClass: input.particleClass,
      elapsedMs: 0,
      lifetimeMs: BASE_LIFETIME_MS,
      sprite,
    });
  }

  tick(deltaMs: number): void {
    if (this.activeBursts.length === 0) {
      return;
    }

    for (let idx = this.activeBursts.length - 1; idx >= 0; idx -= 1) {
      const burst = this.activeBursts[idx];
      burst.elapsedMs += deltaMs;
      const progress = Math.min(1, burst.elapsedMs / burst.lifetimeMs);
      burst.sprite.alpha = 1 - progress;
      burst.sprite.scale.set(1 + progress * 0.7);
      burst.sprite.y =
        burst.tileY * this.tileSize + this.tileSize - progress * this.tileSize * 0.45;

      if (progress >= 1) {
        burst.sprite.destroy();
        this.activeBursts.splice(idx, 1);
      }
    }
  }

  clear(): void {
    for (const burst of this.activeBursts) {
      burst.sprite.destroy();
    }
    this.activeBursts.length = 0;
    this.lastConsumedServerFrame = null;
  }

  private colorForClass(particleClass: HopLandingParticleClass): number {
    switch (particleClass) {
      case HopLandingParticleClass.TALL_GRASS_JUMP:
      case HopLandingParticleClass.LONG_GRASS_JUMP:
        return 0x6ea14a;
      case HopLandingParticleClass.SHALLOW_WATER_SPLASH:
      case HopLandingParticleClass.DEEP_WATER_SPLASH:
        return 0x7cc8ff;
      case HopLandingParticleClass.NORMAL_GROUND_DUST:
      default:
        return 0xc3a57a;
    }
  }

  private radiusForClass(particleClass: HopLandingParticleClass): number {
    switch (particleClass) {
      case HopLandingParticleClass.DEEP_WATER_SPLASH:
        return 4;
      case HopLandingParticleClass.SHALLOW_WATER_SPLASH:
        return 3;
      default:
        return 2.5;
    }
  }
}

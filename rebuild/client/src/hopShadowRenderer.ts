import { BikeTransitionType, TraversalState } from './protocol_generated';
import type { PlayerMovementActionVisualState } from './playerMovementActionRuntime';
import type { ContainerChild } from 'pixi.js';

export const ROM_SHADOW_TEMPLATE_ID_SMALL = 0;
export const ROM_SHADOW_TEMPLATE_ID_MEDIUM = 1;
export const ROM_SHADOW_TEMPLATE_ID_LARGE = 2;
export const ROM_SHADOW_TEMPLATE_ID_EXTRA_LARGE = 3;

export type ShadowTemplateId =
  | typeof ROM_SHADOW_TEMPLATE_ID_SMALL
  | typeof ROM_SHADOW_TEMPLATE_ID_MEDIUM
  | typeof ROM_SHADOW_TEMPLATE_ID_LARGE
  | typeof ROM_SHADOW_TEMPLATE_ID_EXTRA_LARGE;

export type HopShadowSizeVariant = 'small' | 'medium' | 'large' | 'extra_large';

// ROM reference table from FLDEFF_SHADOW metadata (shadow_vertical_offsets).
export const ROM_SHADOW_VERTICAL_OFFSETS_PX: Readonly<Record<ShadowTemplateId, number>> = {
  [ROM_SHADOW_TEMPLATE_ID_SMALL]: 4,
  [ROM_SHADOW_TEMPLATE_ID_MEDIUM]: 4,
  [ROM_SHADOW_TEMPLATE_ID_LARGE]: 4,
  [ROM_SHADOW_TEMPLATE_ID_EXTRA_LARGE]: 16,
};

export type HopShadowSuppressionContext = {
  isReflectiveSurface: boolean;
  isWaterSurface: boolean;
  isTallGrass: boolean;
};

const DEFAULT_SUPPRESSION_CONTEXT: HopShadowSuppressionContext = {
  isReflectiveSurface: false,
  isWaterSurface: false,
  isTallGrass: false,
};

const HOP_SHADOW_FAMILY_TRANSITIONS = new Set<BikeTransitionType>([
  BikeTransitionType.HOP,
  BikeTransitionType.HOP_STANDING,
  BikeTransitionType.HOP_MOVING,
  BikeTransitionType.WHEELIE_HOPPING_STANDING,
  BikeTransitionType.WHEELIE_HOPPING_MOVING,
  BikeTransitionType.SIDE_JUMP,
  BikeTransitionType.TURN_JUMP,
]);

export type HopShadowSprite = {
  x: number;
  y: number;
  visible: boolean;
  destroy?: () => void;
};

type HopShadowLayer = {
  addChild: (...children: ContainerChild[]) => unknown;
  removeChild: (...children: ContainerChild[]) => unknown;
};

export class HopShadowRenderer {
  private sprite: HopShadowSprite | null = null;
  private shadowSizeTemplateId: ShadowTemplateId = ROM_SHADOW_TEMPLATE_ID_MEDIUM;
  private suppressionContext: HopShadowSuppressionContext = DEFAULT_SUPPRESSION_CONTEXT;
  private hopFamilyActive = false;
  private spawnRequested = false;
  private arcObserved = false;

  constructor(
    private readonly layer: HopShadowLayer,
    private readonly tileSize: number,
    private readonly createSprite: (variant: HopShadowSizeVariant) => HopShadowSprite,
  ) {}

  setShadowSizeTemplateId(templateId: ShadowTemplateId): void {
    if (templateId === this.shadowSizeTemplateId) {
      return;
    }

    this.shadowSizeTemplateId = templateId;
    if (this.sprite) {
      this.despawn();
      this.spawnRequested = this.hopFamilyActive;
      this.arcObserved = false;
    }
  }

  setSuppressionContext(context: Partial<HopShadowSuppressionContext>): void {
    this.suppressionContext = {
      ...this.suppressionContext,
      ...context,
    };
    if (this.sprite) {
      this.sprite.visible = !this.shouldSuppressVisibility();
    }
  }

  setAuthoritativeState(input: {
    traversalState: TraversalState;
    bikeTransition?: BikeTransitionType;
  }): void {
    const inHopFamily =
      input.traversalState === TraversalState.ACRO_BIKE &&
      HOP_SHADOW_FAMILY_TRANSITIONS.has(input.bikeTransition ?? BikeTransitionType.NONE);

    if (!this.hopFamilyActive && inHopFamily) {
      this.spawnRequested = true;
      this.arcObserved = false;
    }
    this.hopFamilyActive = inHopFamily;
  }

  presentFrame(input: {
    tileX: number;
    tileY: number;
    visualState: PlayerMovementActionVisualState;
  }): void {
    if (this.spawnRequested && !this.sprite) {
      this.spawn();
    }

    if (!this.sprite) {
      return;
    }

    this.sprite.x = input.tileX * this.tileSize + this.tileSize / 2;
    this.sprite.y = input.tileY * this.tileSize + this.tileSize;
    this.sprite.visible = !this.shouldSuppressVisibility();

    const hopArcActive =
      input.visualState.activeAction !== 'none' || input.visualState.yOffsetPx < 0;

    if (hopArcActive) {
      this.arcObserved = true;
      return;
    }

    if (this.arcObserved) {
      this.despawn();
      this.spawnRequested = false;
      this.arcObserved = false;
    }
  }

  clear(): void {
    this.spawnRequested = false;
    this.arcObserved = false;
    this.hopFamilyActive = false;
    this.despawn();
    this.suppressionContext = DEFAULT_SUPPRESSION_CONTEXT;
  }

  hasActiveShadow(): boolean {
    return this.sprite !== null;
  }

  private spawn(): void {
    const sprite = this.createSprite(templateIdToVariant(this.shadowSizeTemplateId));
    sprite.visible = !this.shouldSuppressVisibility();
    this.layer.addChild(sprite as unknown as ContainerChild);
    this.sprite = sprite;
    this.spawnRequested = false;
  }

  private despawn(): void {
    if (!this.sprite) {
      return;
    }
    this.layer.removeChild(this.sprite as unknown as ContainerChild);
    this.sprite.destroy?.();
    this.sprite = null;
  }

  private shouldSuppressVisibility(): boolean {
    return (
      this.suppressionContext.isReflectiveSurface ||
      this.suppressionContext.isWaterSurface ||
      this.suppressionContext.isTallGrass
    );
  }
}

function templateIdToVariant(templateId: ShadowTemplateId): HopShadowSizeVariant {
  switch (templateId) {
    case ROM_SHADOW_TEMPLATE_ID_SMALL:
      return 'small';
    case ROM_SHADOW_TEMPLATE_ID_MEDIUM:
      return 'medium';
    case ROM_SHADOW_TEMPLATE_ID_LARGE:
      return 'large';
    case ROM_SHADOW_TEMPLATE_ID_EXTRA_LARGE:
      return 'extra_large';
    default:
      return 'medium';
  }
}

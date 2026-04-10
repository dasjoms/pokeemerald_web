import {
  AcroBikeSubstate,
  BikeTransitionType,
  TraversalState,
} from './protocol_generated';
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
  addChildAt?: (child: ContainerChild, index: number) => unknown;
  getChildIndex?: (child: ContainerChild) => number;
  setChildIndex?: (child: ContainerChild, index: number) => unknown;
};

export class HopShadowRenderer {
  private sprite: HopShadowSprite | null = null;
  private spriteLayer: HopShadowLayer | null = null;
  private shadowSizeTemplateId: ShadowTemplateId = ROM_SHADOW_TEMPLATE_ID_MEDIUM;
  private suppressionContext: HopShadowSuppressionContext = DEFAULT_SUPPRESSION_CONTEXT;
  private hopContextActive = false;

  constructor(
    private readonly resolveLayer: () => HopShadowLayer,
    private readonly tileSize: number,
    private readonly createSprite: (variant: HopShadowSizeVariant) => HopShadowSprite,
    private readonly resolveLinkedSprite?: () => ContainerChild | null,
  ) {}

  setShadowSizeTemplateId(templateId: ShadowTemplateId): void {
    if (templateId === this.shadowSizeTemplateId) {
      return;
    }

    this.shadowSizeTemplateId = templateId;
    if (this.sprite) {
      this.despawn();
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
    acroSubstate?: AcroBikeSubstate;
  }): void {
    this.hopContextActive =
      input.traversalState === TraversalState.ACRO_BIKE &&
      (HOP_SHADOW_FAMILY_TRANSITIONS.has(input.bikeTransition ?? BikeTransitionType.NONE) ||
        input.acroSubstate === AcroBikeSubstate.BUNNY_HOP);
  }

  presentFrame(input: {
    tileX: number;
    tileY: number;
    visualState: PlayerMovementActionVisualState;
  }): void {
    if (this.hopContextActive && !this.sprite) {
      this.spawn();
    }

    if (!this.hopContextActive) {
      this.despawn();
      return;
    }

    if (!this.sprite) {
      return;
    }

    this.ensureLayer();
    this.sprite.x = input.tileX * this.tileSize + this.tileSize / 2;
    this.sprite.y = input.tileY * this.tileSize + this.tileSize;
    this.sprite.visible = !this.shouldSuppressVisibility();
  }

  clear(): void {
    this.hopContextActive = false;
    this.despawn();
    this.suppressionContext = DEFAULT_SUPPRESSION_CONTEXT;
  }

  hasActiveShadow(): boolean {
    return this.sprite !== null;
  }

  private spawn(): void {
    const sprite = this.createSprite(templateIdToVariant(this.shadowSizeTemplateId));
    sprite.visible = !this.shouldSuppressVisibility();
    const layer = this.resolveLayer();
    layer.addChild(sprite as unknown as ContainerChild);
    this.spriteLayer = layer;
    this.sprite = sprite;
    this.ensureShadowRendersBeforeLinkedSprite();
  }

  private despawn(): void {
    if (!this.sprite) {
      return;
    }
    this.spriteLayer?.removeChild(this.sprite as unknown as ContainerChild);
    this.sprite.destroy?.();
    this.sprite = null;
    this.spriteLayer = null;
  }

  private ensureLayer(): void {
    if (!this.sprite) {
      return;
    }
    const nextLayer = this.resolveLayer();
    if (this.spriteLayer !== nextLayer) {
      this.spriteLayer?.removeChild(this.sprite as unknown as ContainerChild);
      nextLayer.addChild(this.sprite as unknown as ContainerChild);
      this.spriteLayer = nextLayer;
    }
    this.ensureShadowRendersBeforeLinkedSprite();
  }

  private ensureShadowRendersBeforeLinkedSprite(): void {
    if (!this.sprite || !this.resolveLinkedSprite || !this.spriteLayer) {
      return;
    }

    const linkedSprite = this.resolveLinkedSprite();
    if (!linkedSprite || !this.spriteLayer.getChildIndex || !this.spriteLayer.setChildIndex) {
      return;
    }

    try {
      const shadowIndex = this.spriteLayer.getChildIndex(this.sprite as unknown as ContainerChild);
      const linkedIndex = this.spriteLayer.getChildIndex(linkedSprite);
      if (shadowIndex > linkedIndex) {
        this.spriteLayer.setChildIndex(this.sprite as unknown as ContainerChild, linkedIndex);
      }
    } catch {
      // If the linked sprite is not in the shadow layer, ordering isn't applicable.
    }
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

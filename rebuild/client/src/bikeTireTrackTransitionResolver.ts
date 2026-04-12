import { Direction } from './protocol_generated';

export type BikeTireTrackAnimId =
  | 'south'
  | 'north'
  | 'west'
  | 'east'
  | 'se_corner_turn'
  | 'sw_corner_turn'
  | 'nw_corner_turn'
  | 'ne_corner_turn';

type BikeTireTrackDirectionName = 'down' | 'up' | 'left' | 'right';

export type BikeTireTrackTransitionMetadata = {
  direction_index_order: BikeTireTrackDirectionName[];
  table: number[][];
};

export type BikeTireTrackAnimMetadata = {
  anim_cmd_symbols: string[];
  sequences: Record<string, Array<{ frame: number; duration: number; h_flip?: boolean; v_flip?: boolean }>>;
};

export type BikeTireTrackFadeTimingMetadata = {
  step0_wait_until_timer_gt: number;
  step1_stop_when_timer_gt: number;
  step1_blink: {
    enabled: boolean;
    mode: string;
  };
};

export type BikeTireTrackManifestMetadata = {
  transition_mapping: BikeTireTrackTransitionMetadata;
  anim_table: BikeTireTrackAnimMetadata;
  fade_timing: BikeTireTrackFadeTimingMetadata;
};

export type BikeTireTrackVariantResolver = (
  previousFacing: Direction,
  currentFacing: Direction,
) => BikeTireTrackAnimId | undefined;

const VARIANT_BY_ANIM_SYMBOL_SUFFIX: Record<string, BikeTireTrackAnimId> = {
  South: 'south',
  North: 'north',
  West: 'west',
  East: 'east',
  SECornerTurn: 'se_corner_turn',
  SWCornerTurn: 'sw_corner_turn',
  NWCornerTurn: 'nw_corner_turn',
  NECornerTurn: 'ne_corner_turn',
};

function mapDirectionToTransitionName(direction: Direction): BikeTireTrackDirectionName | undefined {
  switch (direction) {
    case Direction.DOWN:
      return 'down';
    case Direction.UP:
      return 'up';
    case Direction.LEFT:
      return 'left';
    case Direction.RIGHT:
      return 'right';
    default:
      return undefined;
  }
}

function resolveVariantFromAnimSymbol(animSymbol: string): BikeTireTrackAnimId | undefined {
  for (const [suffix, variant] of Object.entries(VARIANT_BY_ANIM_SYMBOL_SUFFIX)) {
    if (animSymbol.endsWith(suffix)) {
      return variant;
    }
  }
  return undefined;
}

export function createBikeTireTrackVariantResolver(
  metadata: BikeTireTrackManifestMetadata,
): BikeTireTrackVariantResolver {
  const { transition_mapping: transitionMapping, anim_table: animTable } = metadata;
  const indexByDirectionName = new Map<BikeTireTrackDirectionName, number>();
  transitionMapping.direction_index_order.forEach((directionName, index) => {
    indexByDirectionName.set(directionName, index);
  });

  return (previousFacing: Direction, currentFacing: Direction): BikeTireTrackAnimId | undefined => {
    const previousDirectionName = mapDirectionToTransitionName(previousFacing);
    const currentDirectionName = mapDirectionToTransitionName(currentFacing);
    if (!previousDirectionName || !currentDirectionName) {
      return undefined;
    }

    const previousIndex = indexByDirectionName.get(previousDirectionName);
    const currentIndex = indexByDirectionName.get(currentDirectionName);
    if (previousIndex === undefined || currentIndex === undefined) {
      return undefined;
    }

    const row = transitionMapping.table[previousIndex];
    const animTableIndex = row?.[currentIndex];
    if (typeof animTableIndex !== 'number') {
      return undefined;
    }

    const animSymbol = animTable.anim_cmd_symbols[animTableIndex];
    if (!animSymbol) {
      return undefined;
    }
    const firstStep = animTable.sequences[animSymbol]?.[0];
    if (!firstStep || typeof firstStep.frame !== 'number') {
      return undefined;
    }
    return resolveVariantFromAnimSymbol(animSymbol);
  };
}


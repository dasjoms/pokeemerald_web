import type { BikeTireTrackAnimId } from './bikeTireTrackTransitionResolver';

export const FIELD_EFFECTS_MANIFEST_PATH = 'field_effects/acro_bike_effects_manifest.json';

type BikeTireTrackDirectionName = 'down' | 'up' | 'left' | 'right';

type FieldEffectAnimStep = {
  frame: number;
  duration: number;
  h_flip?: boolean;
  v_flip?: boolean;
};

export type FieldEffectTemplate = {
  palette_tag: string;
  pic_table_entries: Array<{
    tile_width: number;
    tile_height: number;
    frame_index: number;
  }>;
  anim_table: {
    anim_cmd_symbols: string[];
    sequences: Record<string, FieldEffectAnimStep[]>;
  };
  sources: Array<{ source_path: string }>;
};

export type BikeTireTracksEffectMetadata = {
  template: FieldEffectTemplate;
  transition_mapping: {
    direction_index_order: BikeTireTrackDirectionName[];
    table: number[][];
  };
  fade_timing: {
    step0_wait_until_timer_gt: number;
    step1_stop_when_timer_gt: number;
    step1_blink: {
      enabled: boolean;
      mode: string;
    };
  };
};

export type FieldEffectsManifest = {
  effects: {
    bike_tire_tracks?: BikeTireTracksEffectMetadata;
    ground_impact_dust?: { template: FieldEffectTemplate };
    jump_tall_grass?: { template: FieldEffectTemplate };
    jump_long_grass?: { template: FieldEffectTemplate };
    jump_small_splash?: { template: FieldEffectTemplate };
    jump_big_splash?: { template: FieldEffectTemplate };
  };
};

const EXPECTED_DIRECTION_COUNT = 4;
const EXPECTED_TIRE_TRACK_VARIANT_COUNT = 8;

const DEV_FALLBACK_BIKE_TIRE_TRACKS_METADATA: BikeTireTracksEffectMetadata = {
  template: {
    palette_tag: 'FLDEFF_PAL_TAG_GENERAL_0',
    sources: [{ source_path: 'graphics/field_effects/pics/bike_tire_tracks.4bpp' }],
    pic_table_entries: [
      { tile_width: 2, tile_height: 2, frame_index: 0 },
      { tile_width: 2, tile_height: 2, frame_index: 1 },
      { tile_width: 2, tile_height: 2, frame_index: 2 },
      { tile_width: 2, tile_height: 2, frame_index: 3 },
    ],
    anim_table: {
      anim_cmd_symbols: [
        'sBikeTireTracksAnim_South',
        'sBikeTireTracksAnim_South',
        'sBikeTireTracksAnim_North',
        'sBikeTireTracksAnim_West',
        'sBikeTireTracksAnim_East',
        'sBikeTireTracksAnim_SECornerTurn',
        'sBikeTireTracksAnim_SWCornerTurn',
        'sBikeTireTracksAnim_NWCornerTurn',
        'sBikeTireTracksAnim_NECornerTurn',
      ],
      sequences: {
        sBikeTireTracksAnim_South: [{ frame: 2, duration: 1, h_flip: false }],
        sBikeTireTracksAnim_North: [{ frame: 2, duration: 1, h_flip: false }],
        sBikeTireTracksAnim_West: [{ frame: 1, duration: 1, h_flip: false }],
        sBikeTireTracksAnim_East: [{ frame: 1, duration: 1, h_flip: false }],
        sBikeTireTracksAnim_SECornerTurn: [{ frame: 0, duration: 1, h_flip: false }],
        sBikeTireTracksAnim_SWCornerTurn: [{ frame: 0, duration: 1, h_flip: true }],
        sBikeTireTracksAnim_NWCornerTurn: [{ frame: 3, duration: 1, h_flip: true }],
        sBikeTireTracksAnim_NECornerTurn: [{ frame: 3, duration: 1, h_flip: false }],
      },
    },
  },
  transition_mapping: {
    direction_index_order: ['down', 'up', 'left', 'right'],
    table: [
      [1, 2, 7, 8],
      [1, 2, 6, 5],
      [5, 8, 3, 4],
      [6, 7, 3, 4],
    ],
  },
  fade_timing: {
    step0_wait_until_timer_gt: 40,
    step1_stop_when_timer_gt: 56,
    step1_blink: {
      enabled: true,
      mode: 'toggle_visibility_each_frame',
    },
  },
};

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

export function resolveBikeTireTrackVariantFromAnimSymbol(
  animSymbol: string,
): BikeTireTrackAnimId | undefined {
  for (const [suffix, variant] of Object.entries(VARIANT_BY_ANIM_SYMBOL_SUFFIX)) {
    if (animSymbol.endsWith(suffix)) {
      return variant;
    }
  }
  return undefined;
}

export function resolveBikeTireTracksMetadataOrThrow(
  manifest: FieldEffectsManifest,
): BikeTireTracksEffectMetadata {
  const metadata = manifest.effects.bike_tire_tracks;
  const validationError = validateBikeTireTracksMetadata(metadata);
  if (!validationError) {
    return metadata!;
  }
  if (!import.meta.env.DEV || isCiMode()) {
    throw new Error(`[parity] ${validationError}`);
  }
  console.warn(
    `[parity-warning] ${validationError}; using development fallback bike tire tracks metadata.`,
  );
  return DEV_FALLBACK_BIKE_TIRE_TRACKS_METADATA;
}

function validateBikeTireTracksMetadata(
  metadata: BikeTireTracksEffectMetadata | undefined,
): string | undefined {
  if (!metadata) {
    return 'missing bike_tire_tracks section in extracted field effects manifest';
  }
  if (!metadata.template) {
    return 'missing bike_tire_tracks.template in extracted field effects manifest';
  }
  if (!metadata.transition_mapping || !metadata.fade_timing) {
    return 'missing bike_tire_tracks transition/fade metadata in extracted field effects manifest';
  }
  const sourcePath = metadata.template.sources[0]?.source_path;
  if (!sourcePath) {
    return 'missing bike_tire_tracks.template.sources[0].source_path';
  }
  if (metadata.template.pic_table_entries.length < 4) {
    return 'bike_tire_tracks.template.pic_table_entries has fewer than 4 entries';
  }
  if (metadata.transition_mapping.direction_index_order.length !== EXPECTED_DIRECTION_COUNT) {
    return `bike_tire_tracks.transition_mapping.direction_index_order expected ${EXPECTED_DIRECTION_COUNT} entries`;
  }
  if (metadata.transition_mapping.table.length !== EXPECTED_DIRECTION_COUNT) {
    return `bike_tire_tracks.transition_mapping.table expected ${EXPECTED_DIRECTION_COUNT} rows`;
  }
  for (const [rowIndex, row] of metadata.transition_mapping.table.entries()) {
    if (!Array.isArray(row) || row.length !== EXPECTED_DIRECTION_COUNT) {
      return `bike_tire_tracks.transition_mapping.table row ${rowIndex} expected ${EXPECTED_DIRECTION_COUNT} entries`;
    }
  }
  if (metadata.fade_timing.step1_blink.enabled && metadata.fade_timing.step1_blink.mode.length === 0) {
    return 'bike_tire_tracks.fade_timing.step1_blink.mode is required when blinking is enabled';
  }
  const resolvedVariants = new Set<BikeTireTrackAnimId>();
  for (const animSymbol of metadata.template.anim_table.anim_cmd_symbols) {
    const variant = resolveBikeTireTrackVariantFromAnimSymbol(animSymbol);
    if (variant) {
      resolvedVariants.add(variant);
    }
  }
  if (resolvedVariants.size !== EXPECTED_TIRE_TRACK_VARIANT_COUNT) {
    return `bike_tire_tracks anim table expected ${EXPECTED_TIRE_TRACK_VARIANT_COUNT} unique tire-track variants but found ${resolvedVariants.size}`;
  }
  return undefined;
}

function isCiMode(): boolean {
  const globalProcess = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  return globalProcess?.env?.CI === 'true' || globalProcess?.env?.CI === '1';
}

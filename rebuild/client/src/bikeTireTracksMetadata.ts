export type BikeTireTrackAnimId =
  | 'south'
  | 'north'
  | 'west'
  | 'east'
  | 'se_corner_turn'
  | 'sw_corner_turn'
  | 'nw_corner_turn'
  | 'ne_corner_turn';

export type BikeTireTrackAnimFrame = {
  frame: number;
  duration: number;
  hFlip?: boolean;
};

export type BikeTireTrackMetadata = {
  sourceAssetPath: string;
  sourceSymbol: string;
  frameLayout: {
    frameCount: number;
    tilesWide: number;
    tilesHigh: number;
  };
  animationTableOrder: BikeTireTrackAnimId[];
  animations: Record<BikeTireTrackAnimId, BikeTireTrackAnimFrame[]>;
};

// Extracted from:
// - src/data/object_events/object_event_graphics.h (gFieldEffectObjectPic_BikeTireTracks)
// - src/data/field_effects/field_effect_objects.h (sPicTable_BikeTireTracks + sAnimTable_BikeTireTracks)
export const BIKE_TIRE_TRACK_METADATA: BikeTireTrackMetadata = {
  sourceAssetPath: 'graphics/field_effects/pics/bike_tire_tracks.4bpp',
  sourceSymbol: 'gFieldEffectObjectPic_BikeTireTracks',
  frameLayout: {
    frameCount: 4,
    tilesWide: 2,
    tilesHigh: 2,
  },
  animationTableOrder: [
    'south',
    'south',
    'north',
    'west',
    'east',
    'se_corner_turn',
    'sw_corner_turn',
    'nw_corner_turn',
    'ne_corner_turn',
  ],
  animations: {
    south: [{ frame: 2, duration: 1 }],
    north: [{ frame: 2, duration: 1 }],
    west: [{ frame: 1, duration: 1 }],
    east: [{ frame: 1, duration: 1 }],
    se_corner_turn: [{ frame: 0, duration: 1 }],
    sw_corner_turn: [{ frame: 0, duration: 1, hFlip: true }],
    nw_corner_turn: [{ frame: 3, duration: 1, hFlip: true }],
    ne_corner_turn: [{ frame: 3, duration: 1 }],
  },
};

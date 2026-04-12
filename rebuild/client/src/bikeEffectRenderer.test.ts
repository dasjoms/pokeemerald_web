import { describe, expect, it } from 'vitest';

import {
  createBikeTireTrackVariantResolver,
  type BikeTireTrackManifestMetadata,
} from './bikeTireTrackTransitionResolver';
import { Direction } from './protocol_generated';

const METADATA_FIXTURE: BikeTireTrackManifestMetadata = {
  transition_mapping: {
    direction_index_order: ['down', 'up', 'left', 'right'],
    table: [
      [1, 2, 7, 8],
      [1, 2, 6, 5],
      [5, 8, 3, 4],
      [6, 7, 3, 4],
    ],
  },
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
      sBikeTireTracksAnim_South: [{ frame: 2, duration: 1 }],
      sBikeTireTracksAnim_North: [{ frame: 2, duration: 1 }],
      sBikeTireTracksAnim_West: [{ frame: 1, duration: 1 }],
      sBikeTireTracksAnim_East: [{ frame: 1, duration: 1 }],
      sBikeTireTracksAnim_SECornerTurn: [{ frame: 0, duration: 1 }],
      sBikeTireTracksAnim_SWCornerTurn: [{ frame: 0, duration: 1, h_flip: true }],
      sBikeTireTracksAnim_NWCornerTurn: [{ frame: 3, duration: 1, h_flip: true }],
      sBikeTireTracksAnim_NECornerTurn: [{ frame: 3, duration: 1 }],
    },
  },
};

describe('createBikeTireTrackVariantResolver', () => {
  it('matches extracted transition matrix outputs for all 16 direction-pair combinations', () => {
    const resolver = createBikeTireTrackVariantResolver(METADATA_FIXTURE);
    const expectedByPair = new Map<string, string>([
      ['1->1', 'south'],
      ['1->0', 'north'],
      ['1->2', 'nw_corner_turn'],
      ['1->3', 'ne_corner_turn'],
      ['0->1', 'south'],
      ['0->0', 'north'],
      ['0->2', 'sw_corner_turn'],
      ['0->3', 'se_corner_turn'],
      ['2->1', 'se_corner_turn'],
      ['2->0', 'ne_corner_turn'],
      ['2->2', 'west'],
      ['2->3', 'east'],
      ['3->1', 'sw_corner_turn'],
      ['3->0', 'nw_corner_turn'],
      ['3->2', 'west'],
      ['3->3', 'east'],
    ]);
    const directions = [Direction.DOWN, Direction.UP, Direction.LEFT, Direction.RIGHT];
    for (const previous of directions) {
      for (const current of directions) {
        expect(resolver(previous, current)).toBe(expectedByPair.get(`${previous}->${current}`));
      }
    }
  });

  it('returns undefined for corrupt transition metadata instead of guessing', () => {
    const resolver = createBikeTireTrackVariantResolver({
      ...METADATA_FIXTURE,
      transition_mapping: {
        ...METADATA_FIXTURE.transition_mapping,
        table: [[99]],
      },
    });
    expect(resolver(Direction.DOWN, Direction.DOWN)).toBeUndefined();
  });
});

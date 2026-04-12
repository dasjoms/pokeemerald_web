import { describe, expect, it } from 'vitest';

import { Direction, TraversalState } from './protocol_generated';
import type { BikeTireTrackAtlas } from './bikeEffectRenderer';
import type { BikeTireTrackManifestMetadata } from './bikeTireTrackTransitionResolver';

const FRAME_MS = 1000 / 60;

type RendererModule = typeof import('./bikeEffectRenderer');
type PixiModule = typeof import('pixi.js');

async function loadRendererWithPixi(): Promise<{ renderer: RendererModule; pixi: PixiModule }> {
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { userAgent: 'vitest' },
  });
  const [renderer, pixi] = await Promise.all([import('./bikeEffectRenderer'), import('pixi.js')]);
  return { renderer, pixi };
}

function createManifestMetadata(): BikeTireTrackManifestMetadata {
  return {
    transition_mapping: {
      direction_index_order: ['down', 'up', 'left', 'right'],
      table: [
        [0, 1, 2, 3],
        [0, 1, 2, 3],
        [0, 1, 2, 3],
        [0, 1, 2, 3],
      ],
    },
    anim_table: {
      anim_cmd_symbols: [
        'sBikeTireTracksAnim_South',
        'sBikeTireTracksAnim_North',
        'sBikeTireTracksAnim_West',
        'sBikeTireTracksAnim_East',
      ],
      sequences: {
        sBikeTireTracksAnim_South: [{ frame: 0, duration: 1 }],
        sBikeTireTracksAnim_North: [{ frame: 0, duration: 1 }],
        sBikeTireTracksAnim_West: [{ frame: 0, duration: 1 }],
        sBikeTireTracksAnim_East: [{ frame: 0, duration: 1 }],
      },
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
}

describe('BikeEffectRenderer tire track lifecycle parity', () => {
  it('holds visible, then flickers each frame, and stops at extracted timer threshold', async () => {
    const { renderer: rendererModule, pixi } = await loadRendererWithPixi();
    const atlas: BikeTireTrackAtlas = {
      south: { texture: pixi.Texture.EMPTY, hFlip: false, vFlip: false },
      north: { texture: pixi.Texture.EMPTY, hFlip: false, vFlip: false },
      west: { texture: pixi.Texture.EMPTY, hFlip: false, vFlip: false },
      east: { texture: pixi.Texture.EMPTY, hFlip: false, vFlip: false },
      se_corner_turn: { texture: pixi.Texture.EMPTY, hFlip: false, vFlip: false },
      sw_corner_turn: { texture: pixi.Texture.EMPTY, hFlip: false, vFlip: false },
      nw_corner_turn: { texture: pixi.Texture.EMPTY, hFlip: false, vFlip: false },
      ne_corner_turn: { texture: pixi.Texture.EMPTY, hFlip: false, vFlip: false },
    };
    const layer = new pixi.Container();
    const renderer = new rendererModule.BikeEffectRenderer(layer, 16, atlas, createManifestMetadata());
    renderer.onAuthoritativeStep({
      fromX: 4,
      fromY: 5,
      previousFacing: Direction.DOWN,
      currentFacing: Direction.DOWN,
      traversalState: TraversalState.MACH_BIKE,
      bikeEffectFlags: rendererModule.BIKE_EFFECT_TIRE_TRACKS,
      serverFrame: 100,
    });

    expect(layer.children).toHaveLength(1);
    expect(layer.children[0].visible).toBe(true);

    for (let i = 0; i < 41; i += 1) renderer.tick(FRAME_MS);
    expect(layer.children).toHaveLength(1);
    expect(layer.children[0].visible).toBe(true);

    const blinkSequence: boolean[] = [];
    for (let i = 0; i < 15; i += 1) {
      renderer.tick(FRAME_MS);
      blinkSequence.push(layer.children[0].visible);
    }
    expect(blinkSequence).toEqual([
      false, true, false, true, false,
      true, false, true, false, true,
      false, true, false, true, false,
    ]);

    renderer.tick(FRAME_MS);
    expect(layer.children).toHaveLength(0);
  });

  it('converts ticker delta into deterministic frame ticks for lifecycle updates', async () => {
    const { renderer: rendererModule, pixi } = await loadRendererWithPixi();
    const atlas: BikeTireTrackAtlas = {
      south: { texture: pixi.Texture.EMPTY, hFlip: false, vFlip: false },
      north: { texture: pixi.Texture.EMPTY, hFlip: false, vFlip: false },
      west: { texture: pixi.Texture.EMPTY, hFlip: false, vFlip: false },
      east: { texture: pixi.Texture.EMPTY, hFlip: false, vFlip: false },
      se_corner_turn: { texture: pixi.Texture.EMPTY, hFlip: false, vFlip: false },
      sw_corner_turn: { texture: pixi.Texture.EMPTY, hFlip: false, vFlip: false },
      nw_corner_turn: { texture: pixi.Texture.EMPTY, hFlip: false, vFlip: false },
      ne_corner_turn: { texture: pixi.Texture.EMPTY, hFlip: false, vFlip: false },
    };
    const layer = new pixi.Container();
    const renderer = new rendererModule.BikeEffectRenderer(layer, 16, atlas, createManifestMetadata());
    renderer.onAuthoritativeStep({
      fromX: 4,
      fromY: 5,
      previousFacing: Direction.DOWN,
      currentFacing: Direction.DOWN,
      traversalState: TraversalState.ACRO_BIKE,
      bikeEffectFlags: rendererModule.BIKE_EFFECT_TIRE_TRACKS,
      serverFrame: 200,
    });

    renderer.tick(FRAME_MS * 40.5);
    expect(layer.children).toHaveLength(1);
    expect(layer.children[0].visible).toBe(true);

    renderer.tick(FRAME_MS * 0.5);
    expect(layer.children).toHaveLength(1);
    expect(layer.children[0].visible).toBe(true);

    renderer.tick(FRAME_MS);
    expect(layer.children[0].visible).toBe(false);
  });
});

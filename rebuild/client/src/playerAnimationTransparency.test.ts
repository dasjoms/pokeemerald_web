import { describe, expect, it, vi } from 'vitest';

vi.mock('pixi.js', () => ({
  Rectangle: class Rectangle {},
  Texture: class Texture {
    static from(): unknown {
      return { source: { scaleMode: 'linear' } };
    }
  },
}));

import { buildPlayerSheetRgba } from './playerAnimation';

describe('player sheet palette semantics', () => {
  it('maps palette index 0 to transparent alpha', () => {
    const rgba = buildPlayerSheetRgba(
      2,
      2,
      new Uint8Array([
        0, 1,
        2, 0,
      ]),
      ['#112233', '#445566', '#778899'],
    );

    expect(Array.from(rgba)).toEqual([
      0x11, 0x22, 0x33, 0x00,
      0x44, 0x55, 0x66, 0xff,
      0x77, 0x88, 0x99, 0xff,
      0x11, 0x22, 0x33, 0x00,
    ]);
  });
});

export const VIEWPORT_VISIBLE_METATILE_COLUMNS = 15;
export const VIEWPORT_VISIBLE_METATILE_ROWS = 11;
export const VIEWPORT_PLAYER_ANCHOR_TILE_X = 7;
export const VIEWPORT_PLAYER_ANCHOR_TILE_Y = 5;

export type CameraViewportLayout = {
  viewportWidthPx: number;
  viewportHeightPx: number;
  viewportCenterX: number;
  viewportCenterY: number;
  gameContainerX: number;
  gameContainerY: number;
  visibleMetatileColumns: number;
  visibleMetatileRows: number;
};

export function computeCameraViewportLayout(input: {
  screenWidth: number;
  screenHeight: number;
  tileSize: number;
  renderScale: number;
}): CameraViewportLayout {
  const viewportWidthPx = VIEWPORT_VISIBLE_METATILE_COLUMNS * input.tileSize;
  const viewportHeightPx = VIEWPORT_VISIBLE_METATILE_ROWS * input.tileSize;
  return {
    viewportWidthPx,
    viewportHeightPx,
    viewportCenterX: viewportWidthPx / 2,
    viewportCenterY: viewportHeightPx / 2,
    gameContainerX: (input.screenWidth - viewportWidthPx * input.renderScale) / 2,
    gameContainerY: (input.screenHeight - viewportHeightPx * input.renderScale) / 2,
    visibleMetatileColumns: Math.floor(viewportWidthPx / input.tileSize),
    visibleMetatileRows: Math.floor(viewportHeightPx / input.tileSize),
  };
}


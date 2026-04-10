export type HopLandingPlacementState = {
  renderTileX: number;
  renderTileY: number;
};

export type HopLandingPlacementHint = {
  hopLandingTileX?: number;
  hopLandingTileY?: number;
};

export function resolveHopLandingPlacementTile(
  state: HopLandingPlacementState,
  hint: HopLandingPlacementHint,
): { tileX: number; tileY: number } {
  if (hint.hopLandingTileX !== undefined && hint.hopLandingTileY !== undefined) {
    return {
      tileX: hint.hopLandingTileX,
      tileY: hint.hopLandingTileY,
    };
  }
  return {
    tileX: state.renderTileX,
    tileY: state.renderTileY,
  };
}

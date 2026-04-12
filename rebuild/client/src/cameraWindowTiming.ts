export function resolveRenderedCameraAxisTile(renderTile: number, authoritativeTile: number): number {
  const deltaToAuthoritative = authoritativeTile - renderTile;
  if (deltaToAuthoritative > 0) {
    return Math.floor(renderTile);
  }
  if (deltaToAuthoritative < 0) {
    return Math.ceil(renderTile);
  }
  return authoritativeTile;
}

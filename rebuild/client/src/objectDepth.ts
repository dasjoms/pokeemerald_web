export const ELEVATION_TO_SUBPRIORITY: readonly number[] = [
  115, 115, 83, 115, 83, 115, 83, 115, 83, 115, 83, 115, 83, 0, 0, 115,
] as const;

export type ObjectDepthInput = {
  screenY: number;
  halfHeightPx: number;
  elevation: number;
  baseSubpriority: number;
  coordOffsetYPx?: number;
};

export function computeObjectDepth(input: ObjectDepthInput): number {
  const elevationOffset = ELEVATION_TO_SUBPRIORITY[input.elevation] ?? ELEVATION_TO_SUBPRIORITY[0];
  const coordOffsetYPx = input.coordOffsetYPx ?? 0;
  const footpointY = input.screenY - input.halfHeightPx + coordOffsetYPx;
  const tileRowPhase = ((Math.trunc(footpointY) + 8) & 0xff) >> 4;
  const tileRowComponent = (16 - tileRowPhase) * 2;
  return tileRowComponent + elevationOffset + input.baseSubpriority;
}

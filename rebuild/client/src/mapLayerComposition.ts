export enum MetatileLayerType {
  NORMAL = 0,
  COVERED = 1,
  SPLIT = 2,
}

export enum MapRenderStratum {
  BG3 = 'bg3',
  BG2 = 'bg2',
  BG1 = 'bg1',
}

export function resolveMapRenderStratum(
  metatileLayerType: number | undefined,
  subtileLayer: number,
): MapRenderStratum {
  const normalizedLayerType =
    metatileLayerType === MetatileLayerType.COVERED ||
    metatileLayerType === MetatileLayerType.SPLIT
      ? metatileLayerType
      : MetatileLayerType.NORMAL;

  if (subtileLayer === 0) {
    return normalizedLayerType === MetatileLayerType.NORMAL
      ? MapRenderStratum.BG2
      : MapRenderStratum.BG3;
  }

  return normalizedLayerType === MetatileLayerType.COVERED
    ? MapRenderStratum.BG2
    : MapRenderStratum.BG1;
}

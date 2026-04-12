export type AssetManifest = {
  assetBaseUrl: string;
  assetVersion: string;
  tilesetPairId: string;
  atlasUrl?: string;
  palettesUrl?: string;
  metatilesUrl?: string;
};

export type ServerHelloMessage = {
  type: "server_hello";
  protocolVersion: number;
  serverAuthority: boolean;
  clientVersionEcho: string;
  assetManifest: AssetManifest;
};

export type RenderSubtile = {
  subtileIndex: number;
  tileIndex: number;
  paletteIndex: number;
  hflip: boolean;
  vflip: boolean;
  layer: number;
  layerOrder: number;
};

export type RenderMetatile = {
  packedRaw: number;
  metatileId: number;
  collision: number;
  elevation: number;
  layerType: number;
  subtiles: RenderSubtile[];
};

export type RenderStateV1Message = {
  type: "render_state_v1";
  protocolVersion: number;
  mapId: string;
  tilesetPairId: string;
  camera: {
    runtimeX: number;
    runtimeY: number;
  };
  scroll: {
    xPixelOffset: number;
    yPixelOffset: number;
    horizontalPan: number;
    verticalPan: number;
  };
  window: {
    originRuntimeX: number;
    originRuntimeY: number;
    width: number;
    height: number;
  };
  metatiles: RenderMetatile[];
};

export type ServerMessage = ServerHelloMessage | RenderStateV1Message;

export function parseServerMessage(raw: string): ServerMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== "object" || !("type" in parsed)) {
    return null;
  }

  const type = getString(parsed, "type");
  if (type === "server_hello") {
    const manifest = parseAssetManifest(getObject(parsed, "assetManifest", "asset_manifest"));
    if (!manifest) {
      return null;
    }
    return {
      type,
      protocolVersion: getNumber(parsed, "protocolVersion", "protocol_version"),
      serverAuthority: getBoolean(parsed, "serverAuthority", "server_authority"),
      clientVersionEcho: getString(parsed, "clientVersionEcho", "client_version_echo"),
      assetManifest: manifest
    };
  }

  if (type !== "render_state_v1") {
    return null;
  }

  const camera = getObject(parsed, "camera");
  const window = getObject(parsed, "window");
  const scroll = getObject(parsed, "scroll", "bgScroll", "bg_scroll", "cameraScroll", "camera_scroll");
  const metatilesRaw = getArray(parsed, "metatiles");
  const metatiles: RenderMetatile[] = metatilesRaw
    .map((entry) => normalizeMetatile(entry))
    .filter((entry): entry is RenderMetatile => entry !== null);

  return {
    type,
    protocolVersion: getNumber(parsed, "protocolVersion", "protocol_version"),
    mapId: getString(parsed, "mapId", "map_id"),
    tilesetPairId: getString(parsed, "tilesetPairId", "tileset_pair_id"),
    camera: {
      runtimeX: getNumber(camera, "runtimeX", "runtime_x"),
      runtimeY: getNumber(camera, "runtimeY", "runtime_y")
    },
    scroll: {
      xPixelOffset: getNumber(scroll, "xPixelOffset", "x_pixel_offset"),
      yPixelOffset: getNumber(scroll, "yPixelOffset", "y_pixel_offset"),
      horizontalPan: getNumber(scroll, "horizontalPan", "horizontal_pan"),
      verticalPan: getNumber(scroll, "verticalPan", "vertical_pan")
    },
    window: {
      originRuntimeX: getNumber(window, "originRuntimeX", "origin_runtime_x"),
      originRuntimeY: getNumber(window, "originRuntimeY", "origin_runtime_y"),
      width: getNumber(window, "width"),
      height: getNumber(window, "height")
    },
    metatiles
  };
}

function normalizeMetatile(value: unknown): RenderMetatile | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const subtilesRaw = getArray(value, "subtiles");
  const subtiles = subtilesRaw
    .map((entry) => normalizeSubtile(entry))
    .filter((entry): entry is RenderSubtile => entry !== null);

  return {
    packedRaw: getNumber(value, "packedRaw", "packed_raw"),
    metatileId: getNumber(value, "metatileId", "metatile_id"),
    collision: getNumber(value, "collision"),
    elevation: getNumber(value, "elevation"),
    layerType: getNumber(value, "layerType", "layer_type"),
    subtiles
  };
}

function normalizeSubtile(value: unknown): RenderSubtile | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  return {
    subtileIndex: getNumber(value, "subtileIndex", "subtile_index"),
    tileIndex: getNumber(value, "tileIndex", "tile_index"),
    paletteIndex: getNumber(value, "paletteIndex", "palette_index"),
    hflip: getBoolean(value, "hflip"),
    vflip: getBoolean(value, "vflip"),
    layer: getNumber(value, "layer"),
    layerOrder: getNumber(value, "layerOrder", "layer_order")
  };
}

function parseAssetManifest(source: unknown): AssetManifest | null {
  if (!source || typeof source !== "object") {
    return null;
  }

  const assetBaseUrl = getString(source, "assetBaseUrl", "asset_base_url");
  const assetVersion = getString(source, "assetVersion", "asset_version");
  const tilesetPairId = getString(source, "tilesetPairId", "tileset_pair_id");

  if (!assetBaseUrl || !assetVersion || !tilesetPairId) {
    return null;
  }

  const atlasUrl = optionalString(source, "atlasUrl", "atlas_url");
  const palettesUrl = optionalString(source, "palettesUrl", "palettes_url");
  const metatilesUrl = optionalString(source, "metatilesUrl", "metatiles_url");

  return {
    assetBaseUrl,
    assetVersion,
    tilesetPairId,
    atlasUrl: atlasUrl || undefined,
    palettesUrl: palettesUrl || undefined,
    metatilesUrl: metatilesUrl || undefined
  };
}

function getObject(source: unknown, ...keys: string[]): Record<string, unknown> {
  if (!source || typeof source !== "object") {
    return {};
  }
  const record = source as Record<string, unknown>;
  for (const key of keys) {
    const candidate = record[key];
    if (candidate && typeof candidate === "object") {
      return candidate as Record<string, unknown>;
    }
  }
  return {};
}

function getArray(source: unknown, key: string): unknown[] {
  if (!source || typeof source !== "object") {
    return [];
  }
  const candidate = (source as Record<string, unknown>)[key];
  return Array.isArray(candidate) ? candidate : [];
}

function getNumber(source: unknown, ...keys: string[]): number {
  if (!source || typeof source !== "object") {
    return 0;
  }
  const record = source as Record<string, unknown>;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number") {
      return value;
    }
  }
  return 0;
}

function getBoolean(source: unknown, ...keys: string[]): boolean {
  if (!source || typeof source !== "object") {
    return false;
  }
  const record = source as Record<string, unknown>;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "boolean") {
      return value;
    }
  }
  return false;
}

function getString(source: unknown, ...keys: string[]): string {
  if (!source || typeof source !== "object") {
    return "";
  }
  const record = source as Record<string, unknown>;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string") {
      return value;
    }
  }
  return "";
}

function optionalString(source: unknown, ...keys: string[]): string {
  if (!source || typeof source !== "object") {
    return "";
  }
  const record = source as Record<string, unknown>;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return "";
}

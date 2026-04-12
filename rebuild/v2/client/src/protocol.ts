export type ServerHelloMessage = {
  type: "server_hello";
  protocolVersion: number;
  serverAuthority: boolean;
  clientVersionEcho: string;
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

  const type = (parsed as { type?: unknown }).type;
  if (type === "server_hello" || type === "render_state_v1") {
    return parsed as ServerMessage;
  }

  return null;
}

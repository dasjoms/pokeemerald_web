import { Application, Container, Graphics, Rectangle, Sprite, Texture } from 'pixi.js';
import {
  Direction,
  MessageType,
  PROTOCOL_VERSION,
  RejectionReason,
  type WalkResult,
  type WorldSnapshot,
} from './protocol_generated';
import {
  applyPredictedStep,
  clampToMapBounds,
  reconcilePredictions,
} from './prediction';
import { rejectionReasonLabel } from './rejectionReason';

type ServerMessage =
  | { type: MessageType.SESSION_ACCEPTED; payload: { session_id: number; server_frame: number } }
  | { type: MessageType.WORLD_SNAPSHOT; payload: WorldSnapshot }
  | { type: MessageType.WALK_RESULT; payload: WalkResult };

type LayoutTile = {
  metatile_id: number;
  collision: number;
  behavior_id: number;
};

type RenderAssetsRef = {
  pair_id: string;
  atlas: string;
  palettes: string;
  metatiles: string;
};

type LayoutFile = {
  id: string;
  width: number;
  height: number;
  primary_tileset: string;
  secondary_tileset: string;
  tiles: LayoutTile[];
  render_assets?: RenderAssetsRef;
};

type AtlasFile = {
  pages: Array<{
    page: number;
    source_tileset: string;
    path: string;
  }>;
};

type PaletteSet = {
  source_tileset: string;
  palettes: Array<{ colors: number[][] }>;
};

type PalettesFile = {
  tilesets: PaletteSet[];
};

type MetatileSubtile = {
  subtile_index: number;
  tile_index: number;
  palette_index: number;
  hflip: boolean;
  vflip: boolean;
  layer: number;
  layer_order: number;
};

type Metatile = {
  metatile_index: number;
  subtiles: MetatileSubtile[];
};

type MetatilesFile = {
  tilesets: Array<{
    source_tileset: string;
    metatiles: Metatile[];
  }>;
};

type ClientWorldState = {
  mapId: number;
  mapWidth: number;
  mapHeight: number;
  playerTileX: number;
  playerTileY: number;
  facing: Direction;
  lastInputSeq: number;
  lastAckServerTick: number;
};

const TILE_SIZE = 16;
const SUBTILE_SIZE = 8;
const PLAYER_SIZE = 12;
const ENABLE_CLIENT_PREDICTION =
  new URLSearchParams(window.location.search).get('predict') === '1';
const ENABLE_DEBUG_OVERLAY_DEFAULT =
  new URLSearchParams(window.location.search).get('debug') === '1';

const MAP_ID_TO_LAYOUT_ID: Record<number, string> = {
  1: 'LAYOUT_LITTLEROOT_TOWN',
};

const jsonAssetLoaders = import.meta.glob('../../assets/**/*.json');
const imageAssetLoaders = import.meta.glob('../../assets/**/*.png', {
  query: '?url',
  import: 'default',
});

const state: ClientWorldState = {
  mapId: 0,
  mapWidth: 1,
  mapHeight: 1,
  playerTileX: 0,
  playerTileY: 0,
  facing: Direction.DOWN,
  lastInputSeq: 0,
  lastAckServerTick: 0,
};

const pendingPredictedInputs = new Map<number, Direction>();
let socket: WebSocket | null = null;
let debugOverlayEnabled = ENABLE_DEBUG_OVERLAY_DEFAULT;

const appRoot = document.getElementById('app-root');
if (!appRoot) {
  throw new Error('missing #app-root container');
}

const hud = {
  mapId: document.querySelector<HTMLElement>('[data-hud="mapId"]'),
  tile: document.querySelector<HTMLElement>('[data-hud="tile"]'),
  facing: document.querySelector<HTMLElement>('[data-hud="facing"]'),
  inputSeq: document.querySelector<HTMLElement>('[data-hud="inputSeq"]'),
  serverTick: document.querySelector<HTMLElement>('[data-hud="serverTick"]'),
};

const app = new Application();
await app.init({
  background: '#0f172a',
  antialias: false,
  resizeTo: appRoot,
});
appRoot.appendChild(app.canvas);

const worldContainer = new Container();
const mapGroundLayer = new Container();
const actorLayer = new Container();
const mapTopLayer = new Container();
const debugOverlayLayer = new Container();
worldContainer.addChild(mapGroundLayer);
worldContainer.addChild(actorLayer);
worldContainer.addChild(mapTopLayer);
worldContainer.addChild(debugOverlayLayer);
app.stage.addChild(worldContainer);
debugOverlayLayer.visible = debugOverlayEnabled;

const playerSprite = new Graphics()
  .rect(0, 0, PLAYER_SIZE, PLAYER_SIZE)
  .fill({ color: 0xffd166 });
actorLayer.addChild(playerSprite);

app.ticker.add(() => {
  positionPlayerSprite();
  updateCamera();
  renderHud();
});

connectWebSocket();
bindWalkInput();

function normalizeRepoRelative(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\/?rebuild\/assets\//, '');
}

async function loadJsonFromAssets<T>(repoRelativePath: string): Promise<T> {
  const normalized = normalizeRepoRelative(repoRelativePath);
  const modulePath = `../../assets/${normalized}`;
  const loader = jsonAssetLoaders[modulePath];
  if (!loader) {
    throw new Error(`missing json asset at ${modulePath}`);
  }

  const loaded = (await loader()) as { default: T };
  return loaded.default;
}

async function resolveImageUrlFromAssets(repoRelativePath: string): Promise<string> {
  const normalized = normalizeRepoRelative(repoRelativePath);
  const modulePath = `../../assets/${normalized}`;
  const loader = imageAssetLoaders[modulePath];
  if (!loader) {
    throw new Error(`missing image asset at ${modulePath}`);
  }

  return (await loader()) as string;
}

function makeRenderAssetRef(layout: LayoutFile): RenderAssetsRef {
  if (layout.render_assets) {
    return layout.render_assets;
  }

  const pairId = `${layout.primary_tileset}__${layout.secondary_tileset}`;
  return {
    pair_id: pairId,
    atlas: `render/${pairId}/atlas.json`,
    palettes: `render/${pairId}/palettes.json`,
    metatiles: `render/${pairId}/metatiles.json`,
  };
}

async function connectWebSocket(): Promise<void> {
  socket = new WebSocket('ws://127.0.0.1:8080/ws');
  socket.binaryType = 'arraybuffer';
  socket.addEventListener('open', () => {
    socket?.send(encodeJoinSession('web-client'));
  });

  socket.addEventListener('message', async (event) => {
    if (!(event.data instanceof ArrayBuffer)) {
      return;
    }

    const message = decodeServerFrame(new Uint8Array(event.data));
    await handleServerMessage(message);
  });
}

async function handleServerMessage(message: ServerMessage): Promise<void> {
  if (message.type === MessageType.SESSION_ACCEPTED) {
    state.lastAckServerTick = message.payload.server_frame;
    renderHud();
    return;
  }

  if (message.type === MessageType.WORLD_SNAPSHOT) {
    const snapshot = message.payload;
    state.mapId = snapshot.map_id;
    state.playerTileX = snapshot.player_pos.x;
    state.playerTileY = snapshot.player_pos.y;
    state.facing = snapshot.facing;
    state.lastAckServerTick = snapshot.server_frame;
    pendingPredictedInputs.clear();

    await renderMapFromSnapshot(snapshot);
    return;
  }

  const result = message.payload;
  const clampedAuthoritativeTile = clampToMapBounds(
    {
      x: result.authoritative_pos.x,
      y: result.authoritative_pos.y,
    },
    state.mapWidth,
    state.mapHeight,
  );
  state.playerTileX = clampedAuthoritativeTile.x;
  state.playerTileY = clampedAuthoritativeTile.y;
  state.facing = result.facing;
  state.lastAckServerTick = result.server_frame;
  if (!result.accepted) {
    console.info(
      `[walk-reject] seq=${result.input_seq} reason=${rejectionReasonLabel(result.reason)}`,
    );
  }

  if (ENABLE_CLIENT_PREDICTION) {
    // Presentation-only client prediction: server WalkResult remains authoritative.
    const reconciled = reconcilePredictions({
      result,
      pendingInputs: pendingPredictedInputs,
      mapWidth: state.mapWidth,
      mapHeight: state.mapHeight,
    });
    state.playerTileX = reconciled.tile.x;
    state.playerTileY = reconciled.tile.y;
    state.facing = reconciled.facing;
  }
}

function paletteToTint(palette: number[][] | undefined): number {
  if (!palette || palette.length < 2) {
    return 0xffffff;
  }

  const [r, g, b] = palette[1];
  return ((r & 0xff) << 16) | ((g & 0xff) << 8) | (b & 0xff);
}

async function renderMapFromSnapshot(snapshot: WorldSnapshot): Promise<void> {
  const layoutId = MAP_ID_TO_LAYOUT_ID[snapshot.map_id];
  if (!layoutId) {
    throw new Error(`missing layout mapping for map id: ${snapshot.map_id}`);
  }

  const layout = await loadJsonFromAssets<LayoutFile>(`layouts/${layoutId}.json`);
  const renderAssets = makeRenderAssetRef(layout);
  const atlas = await loadJsonFromAssets<AtlasFile>(renderAssets.atlas);
  const metatiles = await loadJsonFromAssets<MetatilesFile>(renderAssets.metatiles);
  const palettes = await loadJsonFromAssets<PalettesFile>(renderAssets.palettes);

  state.mapWidth = layout.width;
  state.mapHeight = layout.height;

  mapGroundLayer.removeChildren();
  mapTopLayer.removeChildren();
  debugOverlayLayer.removeChildren();

  const pageTextures = new Map<number, Texture>();
  const tileTextureCache = new Map<string, Texture>();
  for (const page of atlas.pages) {
    const textureUrl = await resolveImageUrlFromAssets(page.path);
    pageTextures.set(page.page, Texture.from(textureUrl));
  }

  const primaryPage = atlas.pages[0];
  if (!primaryPage) {
    throw new Error(`missing primary atlas page for ${layout.id}`);
  }
  const primaryTexture = pageTextures.get(primaryPage.page);
  if (!primaryTexture) {
    throw new Error(`missing loaded texture for atlas page ${primaryPage.page}`);
  }
  const primaryTileCount =
    Math.floor(primaryTexture.width / SUBTILE_SIZE) *
    Math.floor(primaryTexture.height / SUBTILE_SIZE);

  const metatilesBySource = new Map<string, Metatile[]>();
  for (const entry of metatiles.tilesets) {
    metatilesBySource.set(entry.source_tileset, entry.metatiles);
  }

  const palettesBySource = new Map<string, number[][][]>();
  for (const entry of palettes.tilesets) {
    palettesBySource.set(
      entry.source_tileset,
      entry.palettes.map((palette) => palette.colors),
    );
  }

  const primaryMetatiles = metatilesBySource.get(layout.primary_tileset) ?? [];
  const secondaryMetatiles = metatilesBySource.get(layout.secondary_tileset) ?? [];
  const primaryPalettes = palettesBySource.get(layout.primary_tileset) ?? [];
  const secondaryPalettes = palettesBySource.get(layout.secondary_tileset) ?? [];

  for (let y = 0; y < layout.height; y += 1) {
    for (let x = 0; x < layout.width; x += 1) {
      const tile = layout.tiles[y * layout.width + x];
      if (!tile) {
        continue;
      }

      const isPrimaryMetatile = tile.metatile_id < primaryMetatiles.length;
      const metatile = isPrimaryMetatile
        ? primaryMetatiles[tile.metatile_id]
        : secondaryMetatiles[tile.metatile_id - primaryMetatiles.length];
      if (!metatile) {
        continue;
      }

      const sourcePalettes = isPrimaryMetatile ? primaryPalettes : secondaryPalettes;
      const sortedSubtiles = [...metatile.subtiles].sort((a, b) => {
        if (a.layer !== b.layer) {
          return a.layer - b.layer;
        }
        return a.layer_order - b.layer_order;
      });

      for (const subtile of sortedSubtiles) {
        const sourcePage = subtile.tile_index >= primaryTileCount ? 1 : 0;
        const sourceTexture = pageTextures.get(sourcePage);
        if (!sourceTexture) {
          continue;
        }

        const localTileIndex =
          sourcePage === 0 ? subtile.tile_index : subtile.tile_index - primaryTileCount;
        if (localTileIndex < 0) {
          continue;
        }

        const atlasColumns = Math.floor(sourceTexture.width / SUBTILE_SIZE);
        const srcX = (localTileIndex % atlasColumns) * SUBTILE_SIZE;
        const srcY = Math.floor(localTileIndex / atlasColumns) * SUBTILE_SIZE;
        if (srcY >= sourceTexture.height) {
          continue;
        }

        const cacheKey = `${sourcePage}:${localTileIndex}`;
        let subtileTexture = tileTextureCache.get(cacheKey);
        if (!subtileTexture) {
          subtileTexture = new Texture({
            source: sourceTexture.source,
            frame: new Rectangle(srcX, srcY, SUBTILE_SIZE, SUBTILE_SIZE),
          });
          tileTextureCache.set(cacheKey, subtileTexture);
        }

        const sprite = new Sprite(subtileTexture);
        const subtileX = subtile.subtile_index % 2;
        const subtileY = Math.floor(subtile.subtile_index / 2) % 2;
        sprite.x = x * TILE_SIZE + subtileX * SUBTILE_SIZE;
        sprite.y = y * TILE_SIZE + subtileY * SUBTILE_SIZE;

        if (subtile.hflip) {
          sprite.scale.x = -1;
          sprite.x += SUBTILE_SIZE;
        }
        if (subtile.vflip) {
          sprite.scale.y = -1;
          sprite.y += SUBTILE_SIZE;
        }

        const palette = sourcePalettes[subtile.palette_index];
        sprite.tint = paletteToTint(palette);

        if (subtile.layer === 0) {
          mapGroundLayer.addChild(sprite);
        } else {
          mapTopLayer.addChild(sprite);
        }
      }

      const overlayColor = tile.collision === 0 ? 0x16a34a : 0xdc2626;
      const overlay = new Graphics()
        .rect(x * TILE_SIZE, y * TILE_SIZE, TILE_SIZE, TILE_SIZE)
        .fill({ color: overlayColor, alpha: 0.25 })
        .stroke({ color: 0x0f172a, width: 1, alpha: 0.35 });
      overlay.visible = debugOverlayEnabled;
      overlay.label = `collision=${tile.collision} behavior=${tile.behavior_id}`;
      debugOverlayLayer.addChild(overlay);
    }
  }
}

function bindWalkInput(): void {
  window.addEventListener('keydown', (event) => {
    if (event.key === 'F3') {
      event.preventDefault();
      debugOverlayEnabled = !debugOverlayEnabled;
      debugOverlayLayer.visible = debugOverlayEnabled;
      return;
    }

    const direction = keyToDirection(event.key);
    if (direction === null) {
      return;
    }

    event.preventDefault();
    sendWalkInput(direction);
  });
}

function keyToDirection(key: string): Direction | null {
  switch (key) {
    case 'ArrowUp':
    case 'w':
    case 'W':
      return Direction.UP;
    case 'ArrowDown':
    case 's':
    case 'S':
      return Direction.DOWN;
    case 'ArrowLeft':
    case 'a':
    case 'A':
      return Direction.LEFT;
    case 'ArrowRight':
    case 'd':
    case 'D':
      return Direction.RIGHT;
    default:
      return null;
  }
}

function sendWalkInput(direction: Direction): void {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    return;
  }

  const inputSeq = state.lastInputSeq;
  state.lastInputSeq += 1;
  socket.send(encodeWalkInput(direction, inputSeq, BigInt(Date.now())));

  if (ENABLE_CLIENT_PREDICTION) {
    applyPredictedWalk(direction, inputSeq);
  }
}

function encodeJoinSession(playerId: string): Uint8Array {
  const encoder = new TextEncoder();
  const playerIdBytes = encoder.encode(playerId);

  const payload = new Uint8Array(4 + playerIdBytes.length);
  const payloadView = new DataView(payload.buffer);
  payloadView.setUint32(0, playerIdBytes.length, true);
  payload.set(playerIdBytes, 4);

  const frame = new Uint8Array(7 + payload.length);
  const view = new DataView(frame.buffer);
  view.setUint16(0, PROTOCOL_VERSION, true);
  view.setUint8(2, MessageType.JOIN_SESSION);
  view.setUint32(3, payload.length, true);
  frame.set(payload, 7);
  return frame;
}

function encodeWalkInput(direction: Direction, inputSeq: number, clientTime: bigint): Uint8Array {
  const payload = new Uint8Array(13);
  const payloadView = new DataView(payload.buffer);
  payloadView.setUint8(0, direction);
  payloadView.setUint32(1, inputSeq, true);
  payloadView.setBigUint64(5, clientTime, true);

  const frame = new Uint8Array(7 + payload.length);
  const view = new DataView(frame.buffer);
  view.setUint16(0, PROTOCOL_VERSION, true);
  view.setUint8(2, MessageType.WALK_INPUT);
  view.setUint32(3, payload.length, true);
  frame.set(payload, 7);
  return frame;
}

function decodeServerFrame(frame: Uint8Array): ServerMessage {
  if (frame.length < 7) {
    throw new Error('frame too short');
  }

  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  const version = view.getUint16(0, true);
  if (version !== PROTOCOL_VERSION) {
    throw new Error(`unsupported protocol version ${version}`);
  }

  const messageType = view.getUint8(2);
  const payloadLen = view.getUint32(3, true);
  const payload = frame.subarray(7);
  if (payload.length !== payloadLen) {
    throw new Error('payload length mismatch');
  }

  if (messageType === MessageType.SESSION_ACCEPTED) {
    return {
      type: MessageType.SESSION_ACCEPTED,
      payload: {
        session_id: readU32(payload, 0),
        server_frame: readU32(payload, 4),
      },
    };
  }

  if (messageType === MessageType.WORLD_SNAPSHOT) {
    let offset = 0;
    const mapId = readU16(payload, offset);
    offset += 2;
    const x = readU16(payload, offset);
    offset += 2;
    const y = readU16(payload, offset);
    offset += 2;
    const facing = readU8(payload, offset) as Direction;
    offset += 1;
    const serverFrame = readU32(payload, offset);
    offset += 4;
    const hashLen = readU8(payload, offset);
    offset += 1;
    const mapChunkHash = payload.slice(offset, offset + hashLen);
    offset += hashLen;

    const chunkLen = readU32(payload, offset);
    offset += 4;
    const mapChunk = payload.slice(offset, offset + chunkLen);

    return {
      type: MessageType.WORLD_SNAPSHOT,
      payload: {
        map_id: mapId,
        player_pos: { x, y },
        facing,
        map_chunk_hash: mapChunkHash,
        map_chunk: mapChunk,
        server_frame: serverFrame,
      },
    };
  }

  if (messageType === MessageType.WALK_RESULT) {
    return {
      type: MessageType.WALK_RESULT,
      payload: {
        input_seq: readU32(payload, 0),
        accepted: readU8(payload, 4) === 1,
        authoritative_pos: {
          x: readU16(payload, 5),
          y: readU16(payload, 7),
        },
        facing: readU8(payload, 9) as Direction,
        reason: readU8(payload, 10) as RejectionReason,
        server_frame: readU32(payload, 11),
      },
    };
  }

  throw new Error(`unsupported message type: ${messageType}`);
}

function readU8(raw: Uint8Array, offset: number): number {
  return new DataView(raw.buffer, raw.byteOffset, raw.byteLength).getUint8(offset);
}

function readU16(raw: Uint8Array, offset: number): number {
  return new DataView(raw.buffer, raw.byteOffset, raw.byteLength).getUint16(offset, true);
}

function readU32(raw: Uint8Array, offset: number): number {
  return new DataView(raw.buffer, raw.byteOffset, raw.byteLength).getUint32(offset, true);
}

function applyPredictedWalk(direction: Direction, inputSeq: number): void {
  pendingPredictedInputs.set(inputSeq, direction);
  // Presentation-only prediction (non-authoritative): clamp local visuals to map bounds.
  const predictedTile = applyPredictedStep(
    { x: state.playerTileX, y: state.playerTileY },
    direction,
    state.mapWidth,
    state.mapHeight,
  );
  state.playerTileX = predictedTile.x;
  state.playerTileY = predictedTile.y;
  state.facing = direction;
}

function positionPlayerSprite(): void {
  playerSprite.x = state.playerTileX * TILE_SIZE + (TILE_SIZE - PLAYER_SIZE) / 2;
  playerSprite.y = state.playerTileY * TILE_SIZE + (TILE_SIZE - PLAYER_SIZE) / 2;
}

function updateCamera(): void {
  const centerX = state.playerTileX * TILE_SIZE + TILE_SIZE / 2;
  const centerY = state.playerTileY * TILE_SIZE + TILE_SIZE / 2;
  worldContainer.x = app.screen.width / 2 - centerX;
  worldContainer.y = app.screen.height / 2 - centerY;
}

function renderHud(): void {
  hud.mapId && (hud.mapId.textContent = `${state.mapId}`);
  hud.tile && (hud.tile.textContent = `${state.playerTileX}, ${state.playerTileY}`);
  hud.facing && (hud.facing.textContent = Direction[state.facing]);
  hud.inputSeq && (hud.inputSeq.textContent = `${Math.max(0, state.lastInputSeq - 1)}`);
  hud.serverTick && (hud.serverTick.textContent = `${state.lastAckServerTick}`);
}

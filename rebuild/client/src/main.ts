import { Application, Container, Graphics } from 'pixi.js';
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

type ServerMessage =
  | { type: MessageType.SESSION_ACCEPTED; payload: { session_id: number; server_frame: number } }
  | { type: MessageType.WORLD_SNAPSHOT; payload: WorldSnapshot }
  | { type: MessageType.WALK_RESULT; payload: WalkResult };

type LayoutTile = {
  collision: number;
};

type LayoutFile = {
  id: string;
  width: number;
  height: number;
  tiles: LayoutTile[];
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
const PLAYER_SIZE = 12;
const ENABLE_CLIENT_PREDICTION =
  new URLSearchParams(window.location.search).get('predict') === '1';

const MAP_ID_TO_LAYOUT: Record<number, string> = {
  1: '/maps/LAYOUT_LITTLEROOT_TOWN.json',
};

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
const mapLayer = new Container();
const actorLayer = new Container();
worldContainer.addChild(mapLayer);
worldContainer.addChild(actorLayer);
app.stage.addChild(worldContainer);

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

function connectWebSocket(): void {
  socket = new WebSocket('ws://127.0.0.1:8080/ws');
  socket.binaryType = 'arraybuffer';

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

async function renderMapFromSnapshot(snapshot: WorldSnapshot): Promise<void> {
  const layoutPath = MAP_ID_TO_LAYOUT[snapshot.map_id];
  if (!layoutPath) {
    throw new Error(`missing layout mapping for map id: ${snapshot.map_id}`);
  }

  const response = await fetch(layoutPath);
  const layout = (await response.json()) as LayoutFile;

  state.mapWidth = layout.width;
  state.mapHeight = layout.height;

  mapLayer.removeChildren();

  for (let y = 0; y < layout.height; y += 1) {
    for (let x = 0; x < layout.width; x += 1) {
      const tile = layout.tiles[y * layout.width + x];
      const baseColor = tile.collision === 0 ? 0x4ade80 : 0x64748b;
      const g = new Graphics()
        .rect(x * TILE_SIZE, y * TILE_SIZE, TILE_SIZE, TILE_SIZE)
        .fill({ color: baseColor })
        .stroke({ color: 0x0f172a, width: 1 });
      mapLayer.addChild(g);
    }
  }
}

function bindWalkInput(): void {
  window.addEventListener('keydown', (event) => {
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

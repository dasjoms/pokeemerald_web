import { Application, Container, Graphics } from 'pixi.js';

type Facing = 'UP' | 'DOWN' | 'LEFT' | 'RIGHT';

type ServerMessage =
  | { type: 'SessionAccepted'; payload: SessionAccepted }
  | { type: 'WorldSnapshot'; payload: WorldSnapshot }
  | { type: 'WalkResult'; payload: WalkResult };

type SessionAccepted = {
  connection_id: number;
  player_id: string;
  server_tick: number;
};

type WorldSnapshot = {
  map_id: string;
  map_width: number;
  map_height: number;
  player_tile_x: number;
  player_tile_y: number;
  facing: Facing;
  server_tick: number;
};

type WalkResult = {
  input_seq: number;
  accepted: boolean;
  player_tile_x: number;
  player_tile_y: number;
  facing: Facing;
  reason: 'NONE' | 'COLLISION' | 'OUT_OF_BOUNDS' | 'FORCED_MOVEMENT_DISABLED';
  server_tick: number;
};

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
  mapId: string;
  mapWidth: number;
  mapHeight: number;
  playerTileX: number;
  playerTileY: number;
  facing: Facing;
  lastInputSeq: number;
  lastAckServerTick: number;
};

const TILE_SIZE = 16;
const PLAYER_SIZE = 12;
const ENABLE_CLIENT_PREDICTION =
  new URLSearchParams(window.location.search).get('predict') === '1';

const MAP_ID_TO_LAYOUT: Record<string, string> = {
  MAP_LITTLEROOT_TOWN: '/maps/LAYOUT_LITTLEROOT_TOWN.json',
};

const state: ClientWorldState = {
  mapId: '-',
  mapWidth: 1,
  mapHeight: 1,
  playerTileX: 0,
  playerTileY: 0,
  facing: 'DOWN',
  lastInputSeq: 0,
  lastAckServerTick: 0,
};

const pendingPredictedInputs = new Map<number, Facing>();
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

  socket.addEventListener('open', () => {
    // Server currently auto-creates a session on connect.
  });

  socket.addEventListener('message', async (event) => {
    if (typeof event.data !== 'string') {
      return;
    }

    const message = JSON.parse(event.data) as ServerMessage;
    await handleServerMessage(message);
  });
}

async function handleServerMessage(message: ServerMessage): Promise<void> {
  if (message.type === 'SessionAccepted') {
    state.lastAckServerTick = message.payload.server_tick;
    renderHud();
    return;
  }

  if (message.type === 'WorldSnapshot') {
    const snapshot = message.payload;
    state.mapId = snapshot.map_id;
    state.mapWidth = snapshot.map_width;
    state.mapHeight = snapshot.map_height;
    state.playerTileX = snapshot.player_tile_x;
    state.playerTileY = snapshot.player_tile_y;
    state.facing = snapshot.facing;
    state.lastAckServerTick = snapshot.server_tick;
    pendingPredictedInputs.clear();

    await renderMapFromSnapshot(snapshot);
    return;
  }

  const result = message.payload;
  state.playerTileX = result.player_tile_x;
  state.playerTileY = result.player_tile_y;
  state.facing = result.facing;
  state.lastAckServerTick = result.server_tick;

  if (ENABLE_CLIENT_PREDICTION) {
    pendingPredictedInputs.delete(result.input_seq);
  }
}

async function renderMapFromSnapshot(snapshot: WorldSnapshot): Promise<void> {
  const layoutPath = MAP_ID_TO_LAYOUT[snapshot.map_id];
  if (!layoutPath) {
    throw new Error(`missing layout mapping for map id: ${snapshot.map_id}`);
  }

  const response = await fetch(layoutPath);
  const layout = (await response.json()) as LayoutFile;

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
    const facing = keyToFacing(event.key);
    if (!facing) {
      return;
    }

    event.preventDefault();
    sendWalkInput(facing);
  });
}

function keyToFacing(key: string): Facing | null {
  switch (key) {
    case 'ArrowUp':
    case 'w':
    case 'W':
      return 'UP';
    case 'ArrowDown':
    case 's':
    case 'S':
      return 'DOWN';
    case 'ArrowLeft':
    case 'a':
    case 'A':
      return 'LEFT';
    case 'ArrowRight':
    case 'd':
    case 'D':
      return 'RIGHT';
    default:
      return null;
  }
}

function sendWalkInput(facing: Facing): void {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    return;
  }

  const inputSeq = state.lastInputSeq;
  state.lastInputSeq += 1;

  socket.send(
    JSON.stringify({
      type: 'WalkInput',
      payload: {
        input_seq: inputSeq,
        facing,
      },
    }),
  );

  if (ENABLE_CLIENT_PREDICTION) {
    applyPredictedWalk(facing, inputSeq);
  }
}

function applyPredictedWalk(facing: Facing, inputSeq: number): void {
  pendingPredictedInputs.set(inputSeq, facing);

  // Deliberately non-authoritative: only optimistic presentation bounded to map.
  const { dx, dy } = facingToDelta(facing);
  state.playerTileX = state.playerTileX + dx;
  state.playerTileY = state.playerTileY + dy;
  state.facing = facing;
}

function facingToDelta(facing: Facing): { dx: number; dy: number } {
  switch (facing) {
    case 'UP':
      return { dx: 0, dy: -1 };
    case 'DOWN':
      return { dx: 0, dy: 1 };
    case 'LEFT':
      return { dx: -1, dy: 0 };
    case 'RIGHT':
      return { dx: 1, dy: 0 };
  }
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
  hud.mapId && (hud.mapId.textContent = state.mapId);
  hud.tile && (hud.tile.textContent = `${state.playerTileX}, ${state.playerTileY}`);
  hud.facing && (hud.facing.textContent = state.facing);
  hud.inputSeq && (hud.inputSeq.textContent = `${Math.max(0, state.lastInputSeq - 1)}`);
  hud.serverTick && (hud.serverTick.textContent = `${state.lastAckServerTick}`);
}


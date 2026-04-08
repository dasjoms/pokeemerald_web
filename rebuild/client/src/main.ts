import { Application, Container, Graphics, Sprite } from 'pixi.js';
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
import {
  decodeIndexed4bppPngFromUrl,
  MetatileTextureCache,
  type IndexedAtlasPages,
} from './metatileRenderer';
import { MapRenderStratum, resolveMapRenderStratum } from './mapLayerComposition';

type ServerMessage =
  | { type: MessageType.SESSION_ACCEPTED; payload: { session_id: number; server_frame: number } }
  | { type: MessageType.WORLD_SNAPSHOT; payload: WorldSnapshot }
  | { type: MessageType.WALK_RESULT; payload: WalkResult };

type LayoutTile = {
  metatile_id: number;
  collision: number;
  behavior_id: number;
};

type DecodedMapChunk = {
  width: number;
  height: number;
  tiles: LayoutTile[];
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

type MapsIndexFile = {
  maps: MapIndexEntry[];
};

type MapIndexEntry = {
  group_index: number;
  map_index: number;
  layout_id: string;
};

type LayoutsIndexFile = {
  layouts: LayoutIndexEntry[];
};

type LayoutIndexEntry = {
  id: string;
  decoded_path: string;
};

type AtlasFile = {
  pages: Array<{
    page: number;
    source_tileset: string;
    path: string;
    logical_tile_count?: number;
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
  layer_type?: number;
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

type CopyTilesOp = {
  kind: 'copy_tiles';
  pageId: number;
  destLocalTileIndex: number;
  sourceLocalTileIndex: number;
};

type CopyPaletteOp = {
  kind: 'copy_palette';
  tilesetName: string;
  destPaletteIndex: number;
  sourcePaletteIndex: number;
};

type BlendPaletteOp = {
  kind: 'blend_palette';
  tilesetName: string;
  destPaletteIndex: number;
  sourcePaletteAIndex: number;
  sourcePaletteBIndex: number;
  coeffA: number;
  coeffB: number;
};

type TilesetAnimOp = CopyTilesOp | CopyPaletteOp | BlendPaletteOp;

type TilesetAnimCallback = (counter: number, primaryCounterMax: number) => {
  ops?: TilesetAnimOp[];
};

type TilesetAnimationState = {
  pairId: string;
  primaryTileset: string;
  secondaryTileset: string;
  primaryCounter: number;
  primaryCounterMax: number;
  secondaryCounter: number;
  secondaryCounterMax: number;
  primaryCallback: TilesetAnimCallback | null;
  secondaryCallback: TilesetAnimCallback | null;
  queuedTileCopies: Map<string, CopyTilesOp>;
  queuedPaletteCopies: Map<string, CopyPaletteOp>;
  queuedPaletteBlends: Map<string, BlendPaletteOp>;
  accumulatorMs: number;
  tickSerial: number;
};

type RenderedSubtileBinding = {
  sprite: Sprite;
  pageId: number;
  localTileIndex: number;
  paletteIndex: number;
  sourceTileset: string;
};

const TILE_SIZE = 16;
const SUBTILE_SIZE = 8;
const PLAYER_SIZE = 12;
const TILESET_ANIMATION_STEP_MS = 1000 / 60;
const ENABLE_CLIENT_PREDICTION =
  new URLSearchParams(window.location.search).get('predict') === '1';
const ENABLE_DEBUG_OVERLAY_DEFAULT =
  new URLSearchParams(window.location.search).get('debug') === '1';

const jsonAssetLoaders = import.meta.glob('../../assets/**/*.json');
const imageAssetUrls = import.meta.glob('../../assets/**/*.png', {
  query: '?url',
  import: 'default',
  eager: true,
}) as Record<string, string>;

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
let hasLoggedPrimaryTileCountMismatch = false;
let socket: WebSocket | null = null;
let debugOverlayEnabled = ENABLE_DEBUG_OVERLAY_DEFAULT;
const indexedAtlasPageCache = new Map<string, IndexedAtlasPages>();
const metatileTextureCaches = new Map<string, MetatileTextureCache>();
const tilesetAnimationStates = new Map<string, TilesetAnimationState>();
let mapIdToLayoutJsonPathPromise: Promise<Map<number, string>> | null = null;

let activeTilesetAnimationPairId: string | null = null;
let activeTilesetAnimationState: TilesetAnimationState | null = null;
let activeTextureCache: MetatileTextureCache | null = null;
let activeIndexedAtlasPages: IndexedAtlasPages | null = null;
const renderedSubtileBindings: RenderedSubtileBinding[] = [];
const subtileBindingsByTile = new Map<string, RenderedSubtileBinding[]>();
const subtileBindingsByPalette = new Map<string, RenderedSubtileBinding[]>();
const activeTileSwaps = new Map<string, CopyTilesOp>();
const activePaletteSwaps = new Map<string, CopyPaletteOp>();
const activePaletteBlends = new Map<string, BlendPaletteOp>();
const basePalettesBySource = new Map<string, number[][][]>();
const activePalettesBySource = new Map<string, number[][][]>();
const ENABLE_BATTLE_DOME_NO_BLEND =
  new URLSearchParams(window.location.search).get('battleDomeNoBlend') === '1';

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
const mapBg3Layer = new Container();
const mapBg2Layer = new Container();
const actorLayer = new Container();
const mapBg1Layer = new Container();
const debugOverlayLayer = new Container();
worldContainer.addChild(mapBg3Layer);
worldContainer.addChild(mapBg2Layer);
worldContainer.addChild(actorLayer);
worldContainer.addChild(mapBg1Layer);
worldContainer.addChild(debugOverlayLayer);
app.stage.addChild(worldContainer);
debugOverlayLayer.visible = debugOverlayEnabled;

const playerSprite = new Graphics()
  .rect(0, 0, PLAYER_SIZE, PLAYER_SIZE)
  .fill({ color: 0xffd166 });
actorLayer.addChild(playerSprite);

app.ticker.add(() => {
  tickTilesetAnimationClock(app.ticker.deltaMS);
  presentTilesetAnimation();
  positionPlayerSprite();
  updateCamera();
  renderHud();
});

connectWebSocket();
bindWalkInput();

function normalizeRepoRelative(path: string): string {
  const posixPath = path.replace(/\\/g, '/');
  const rebuildAssetsPrefix = /^(?:[A-Za-z]:)?\/?.*?rebuild\/assets\//;
  return posixPath.replace(rebuildAssetsPrefix, '');
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
  const imageUrl = imageAssetUrls[modulePath];
  if (!imageUrl) {
    throw new Error(
      `missing image asset for original="${repoRelativePath}" normalized="${normalized}" at ${modulePath}`,
    );
  }

  return imageUrl;
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

function makeTilesetAnimSecondaryInit(
  callback: TilesetAnimCallback | null,
  options?: { syncWithPrimary?: boolean; max?: number },
): (primaryCounterMax: number, primaryCounter: number) => Pick<
  TilesetAnimationState,
  'secondaryCallback' | 'secondaryCounter' | 'secondaryCounterMax'
> {
  return (primaryCounterMax, primaryCounter) => ({
    secondaryCallback: callback,
    secondaryCounter: options?.syncWithPrimary ? primaryCounter : 0,
    secondaryCounterMax: options?.max ?? primaryCounterMax,
  });
}

const secondaryTilesetAnimInitByName = new Map<
  string,
  (primaryCounterMax: number, primaryCounter: number) => Pick<
    TilesetAnimationState,
    'secondaryCallback' | 'secondaryCounter' | 'secondaryCounterMax'
  >
>([
  ['gTileset_Petalburg', makeTilesetAnimSecondaryInit(null)],
  ['gTileset_Rustboro', makeTilesetAnimSecondaryInit(buildRustboroSecondaryAnimations())],
  ['gTileset_Dewford', makeTilesetAnimSecondaryInit(buildSimpleModuloAnimation(8, (timer) => [
    makeCyclicTileSwap(1, 170, 6, timer),
  ]))],
  ['gTileset_Slateport', makeTilesetAnimSecondaryInit(buildSimpleModuloAnimation(16, (timer) => [
    makeCyclicTileSwap(1, 160, 8, timer),
  ]))],
  ['gTileset_Mauville', makeTilesetAnimSecondaryInit(buildMauvilleSecondaryAnimations(), { syncWithPrimary: true })],
  ['gTileset_Lavaridge', makeTilesetAnimSecondaryInit(buildLavaridgeSecondaryAnimations())],
  ['gTileset_Fallarbor', makeTilesetAnimSecondaryInit(null)],
  ['gTileset_Fortree', makeTilesetAnimSecondaryInit(null)],
  ['gTileset_Lilycove', makeTilesetAnimSecondaryInit(null)],
  ['gTileset_Mossdeep', makeTilesetAnimSecondaryInit(null)],
  ['gTileset_EverGrande', makeTilesetAnimSecondaryInit(buildEverGrandeSecondaryAnimations())],
  ['gTileset_Pacifidlog', makeTilesetAnimSecondaryInit(buildPacifidlogSecondaryAnimations(), { syncWithPrimary: true })],
  ['gTileset_Sootopolis', makeTilesetAnimSecondaryInit(buildSimpleModuloAnimation(16, (timer) => [
    makeCyclicTileSwap(1, 240, 96, timer),
  ]))],
  ['gTileset_BattleFrontierOutsideWest', makeTilesetAnimSecondaryInit(buildSimpleModuloAnimation(8, (timer) => [
    makeCyclicTileSwap(1, 264, 3, timer),
  ]))],
  ['gTileset_BattleFrontierOutsideEast', makeTilesetAnimSecondaryInit(buildSimpleModuloAnimation(8, (timer) => [
    makeCyclicTileSwap(1, 304, 3, timer),
  ]))],
  ['gTileset_Underwater', makeTilesetAnimSecondaryInit(buildSimpleModuloAnimation(16, (timer) => [
    makeCyclicTileSwap(1, 496, 4, timer),
  ]), { max: 128 })],
  ['gTileset_SootopolisGym', makeTilesetAnimSecondaryInit(buildSimpleModuloAnimation(8, (timer) => [
    makeCyclicTileSwap(1, 464, 20, timer), makeCyclicTileSwap(1, 496, 12, timer),
  ]), { max: 240 })],
  ['gTileset_Cave', makeTilesetAnimSecondaryInit(buildSimpleModuloAnimation(16, (timer) => [
    makeCyclicTileSwap(1, 416, 4, timer),
  ]))],
  ['gTileset_EliteFour', makeTilesetAnimSecondaryInit(buildEliteFourSecondaryAnimations(), { max: 128 })],
  ['gTileset_MauvilleGym', makeTilesetAnimSecondaryInit(buildSimpleModuloAnimation(2, (timer) => [
    makeCyclicTileSwap(1, 144, 16, timer),
  ]))],
  ['gTileset_BikeShop', makeTilesetAnimSecondaryInit(buildSimpleModuloAnimation(4, (timer) => [
    makeCyclicTileSwap(1, 496, 9, timer),
  ]))],
  ['gTileset_BattlePyramid', makeTilesetAnimSecondaryInit(buildSimpleModuloAnimation(8, (timer) => [
    makeCyclicTileSwap(1, 135, 8, timer), makeCyclicTileSwap(1, 151, 8, timer),
  ]))],
  ['gTileset_BattleDome', makeTilesetAnimSecondaryInit(buildBattleDomeSecondaryAnimations(), { max: 32 })],
]);

function createTilesetAnimationState(layout: LayoutFile, pairId: string): TilesetAnimationState {
  const primaryCallback =
    layout.primary_tileset === 'gTileset_General'
      ? buildGeneralPrimaryAnimations()
      : layout.primary_tileset === 'gTileset_Building'
        ? buildBuildingPrimaryAnimations()
        : null;
  const primaryCounterMax = 256;
  const secondaryInit = secondaryTilesetAnimInitByName.get(layout.secondary_tileset) ?? makeTilesetAnimSecondaryInit(null);
  const secondary = secondaryInit(primaryCounterMax, 0);

  return {
    pairId,
    primaryTileset: layout.primary_tileset,
    secondaryTileset: layout.secondary_tileset,
    primaryCounter: 0,
    primaryCounterMax,
    secondaryCounter: secondary.secondaryCounter,
    secondaryCounterMax: secondary.secondaryCounterMax,
    primaryCallback,
    secondaryCallback: secondary.secondaryCallback,
    queuedTileCopies: new Map(),
    queuedPaletteCopies: new Map(),
    queuedPaletteBlends: new Map(),
    accumulatorMs: 0,
    tickSerial: 0,
  };
}

function makeCyclicTileSwap(pageId: number, baseTileIndex: number, tileCount: number, frame: number): CopyTilesOp {
  const normalizedFrame = ((frame % tileCount) + tileCount) % tileCount;
  return {
    kind: 'copy_tiles',
    pageId,
    destLocalTileIndex: baseTileIndex,
    sourceLocalTileIndex: baseTileIndex + normalizedFrame,
  };
}

function buildSimpleModuloAnimation(modulo: number, onFrame: (timerDiv: number) => TilesetAnimOp[]): TilesetAnimCallback {
  return (counter) => {
    if (counter % modulo !== 0) {
      return {};
    }
    return { ops: onFrame(Math.floor(counter / modulo)) };
  };
}

function buildGeneralPrimaryAnimations(): TilesetAnimCallback {
  return (counter) => {
    const phase = counter % 16;
    const timerDiv = Math.floor(counter / 16);
    if (phase === 0) {
      const sequence = [0, 1, 0, 2];
      return { ops: [{ kind: 'copy_tiles', pageId: 0, destLocalTileIndex: 508, sourceLocalTileIndex: 508 + sequence[timerDiv % sequence.length] }] };
    }
    if (phase === 1) {
      return { ops: [makeCyclicTileSwap(0, 432, 30, timerDiv)] };
    }
    if (phase === 2) {
      return { ops: [makeCyclicTileSwap(0, 464, 10, timerDiv)] };
    }
    if (phase === 3) {
      return { ops: [makeCyclicTileSwap(0, 496, 6, timerDiv)] };
    }
    if (phase === 4) {
      return { ops: [makeCyclicTileSwap(0, 480, 10, timerDiv)] };
    }
    return {};
  };
}

function buildBuildingPrimaryAnimations(): TilesetAnimCallback {
  return buildSimpleModuloAnimation(8, (timerDiv) => [
    makeCyclicTileSwap(0, 496, 4, timerDiv),
  ]);
}

function buildRustboroSecondaryAnimations(): TilesetAnimCallback {
  return (counter) => {
    const phase = counter % 8;
    const timerDiv = Math.floor(counter / 8);
    const tileSwaps = [makeCyclicTileSwap(1, 384 + phase * 4, 4, timerDiv)];
    if (phase === 0) {
      tileSwaps.push(makeCyclicTileSwap(1, 448, 4, timerDiv));
    }
    return { ops: tileSwaps };
  };
}

function buildMauvilleSecondaryAnimations(): TilesetAnimCallback {
  return (counter) => {
    const phase = counter % 8;
    const timerDiv = Math.floor(counter / 8);
    return {
      ops: [
        makeCyclicTileSwap(1, 96 + phase * 4, 4, timerDiv),
        makeCyclicTileSwap(1, 128 + phase * 4, 4, timerDiv),
      ],
    };
  };
}

function buildLavaridgeSecondaryAnimations(): TilesetAnimCallback {
  return (counter) => {
    const phase = counter % 16;
    const timerDiv = Math.floor(counter / 16);
    if (phase === 0) {
      return {
        ops: [
          makeCyclicTileSwap(1, 288, 4, timerDiv),
          makeCyclicTileSwap(1, 292, 4, timerDiv + 2),
        ],
      };
    }
    if (phase === 1) {
      return { ops: [makeCyclicTileSwap(1, 160, 4, timerDiv)] };
    }
    return {};
  };
}

function buildEverGrandeSecondaryAnimations(): TilesetAnimCallback {
  return (counter) => {
    const phase = counter % 8;
    const timerDiv = Math.floor(counter / 8);
    return { ops: [makeCyclicTileSwap(1, 272 + phase * 4, 4, timerDiv)] };
  };
}

function buildPacifidlogSecondaryAnimations(): TilesetAnimCallback {
  return (counter) => {
    const phase = counter % 16;
    const timerDiv = Math.floor(counter / 16);
    if (phase === 0) {
      return { ops: [makeCyclicTileSwap(1, 464, 30, timerDiv)] };
    }
    if (phase === 1) {
      return { ops: [makeCyclicTileSwap(1, 496, 8, timerDiv)] };
    }
    return {};
  };
}

function buildEliteFourSecondaryAnimations(): TilesetAnimCallback {
  return (counter) => {
    const tileSwaps: CopyTilesOp[] = [];
    if (counter % 64 === 0) {
      tileSwaps.push(makeCyclicTileSwap(1, 480, 4, Math.floor(counter / 64)));
    }
    if (counter % 8 === 1) {
      tileSwaps.push(makeCyclicTileSwap(1, 504, 1, Math.floor(counter / 8)));
    }
    return { ops: tileSwaps };
  };
}

function buildBattleDomeSecondaryAnimations(): TilesetAnimCallback {
  return (counter) => {
    if (counter % 8 !== 0) {
      return {};
    }
    const phase = Math.floor(counter / 8) % 4;
    if (ENABLE_BATTLE_DOME_NO_BLEND) {
      return {
        ops: [{
          kind: 'copy_palette',
          tilesetName: 'gTileset_BattleDome',
          destPaletteIndex: 8,
          sourcePaletteIndex: 8 + phase,
        }],
      };
    }
    return {
      ops: [
        {
          kind: 'blend_palette',
          tilesetName: 'gTileset_BattleDome',
          destPaletteIndex: 8,
          sourcePaletteAIndex: 8 + phase,
          sourcePaletteBIndex: 8 + ((phase + 1) % 4),
          coeffA: 8,
          coeffB: 8,
        },
      ],
    };
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

async function renderMapFromSnapshot(snapshot: WorldSnapshot): Promise<void> {
  const mapIdToLayoutJsonPath = await getMapIdToLayoutJsonPath();
  const layoutJsonPath = mapIdToLayoutJsonPath.get(snapshot.map_id);
  if (!layoutJsonPath) {
    throw new Error(`missing layout mapping for map id: ${snapshot.map_id}`);
  }

  const layout = await loadJsonFromAssets<LayoutFile>(layoutJsonPath);
  const runtimeChunk = resolveRuntimeMapChunk(snapshot, layout);
  const renderAssets = makeRenderAssetRef(layout);
  const atlas = await loadJsonFromAssets<AtlasFile>(renderAssets.atlas);
  const metatiles = await loadJsonFromAssets<MetatilesFile>(renderAssets.metatiles);
  const palettes = await loadJsonFromAssets<PalettesFile>(renderAssets.palettes);

  state.mapWidth = runtimeChunk.width;
  state.mapHeight = runtimeChunk.height;

  mapBg3Layer.removeChildren();
  mapBg2Layer.removeChildren();
  mapBg1Layer.removeChildren();
  debugOverlayLayer.removeChildren();
  renderedSubtileBindings.length = 0;
  subtileBindingsByTile.clear();
  subtileBindingsByPalette.clear();
  activeTileSwaps.clear();
  activePaletteSwaps.clear();
  activePaletteBlends.clear();
  basePalettesBySource.clear();
  activePalettesBySource.clear();

  let indexedAtlasPages = indexedAtlasPageCache.get(renderAssets.pair_id);
  if (!indexedAtlasPages) {
    indexedAtlasPages = new Map();
    for (const page of atlas.pages) {
      const textureUrl = await resolveImageUrlFromAssets(page.path);
      const decoded = await decodeIndexed4bppPngFromUrl(
        textureUrl,
        page.logical_tile_count ?? Number.MAX_SAFE_INTEGER,
      );
      indexedAtlasPages.set(page.page, decoded);
    }
    indexedAtlasPageCache.set(renderAssets.pair_id, indexedAtlasPages);
  }

  let textureCache = metatileTextureCaches.get(renderAssets.pair_id);
  if (!textureCache) {
    textureCache = new MetatileTextureCache();
    metatileTextureCaches.set(renderAssets.pair_id, textureCache);
  }
  activeTextureCache = textureCache;
  activeIndexedAtlasPages = indexedAtlasPages;
  activeTilesetAnimationPairId = renderAssets.pair_id;

  const primaryPage = atlas.pages[0];
  if (!primaryPage) {
    throw new Error(`missing primary atlas page for ${layout.id}`);
  }
  const primaryIndexedPage = indexedAtlasPages.get(primaryPage.page);
  if (!primaryIndexedPage) {
    throw new Error(`missing decoded atlas page ${primaryPage.page}`);
  }
  const dimensionDerivedPrimaryTileCount =
    Math.floor(primaryIndexedPage.width / SUBTILE_SIZE) *
    Math.floor(primaryIndexedPage.height / SUBTILE_SIZE);
  const metadataPrimaryTileCount = primaryPage.logical_tile_count;
  const primaryTileCount = metadataPrimaryTileCount ?? dimensionDerivedPrimaryTileCount;

  if (
    import.meta.env.DEV &&
    typeof metadataPrimaryTileCount === 'number' &&
    metadataPrimaryTileCount !== dimensionDerivedPrimaryTileCount &&
    !hasLoggedPrimaryTileCountMismatch
  ) {
    hasLoggedPrimaryTileCountMismatch = true;
    console.warn(
      `[atlas] logical_tile_count mismatch for page ${primaryPage.page}: ` +
        `metadata=${metadataPrimaryTileCount}, dimensions=${dimensionDerivedPrimaryTileCount}`,
    );
  }

  const metatilesBySource = new Map<string, Metatile[]>();
  for (const entry of metatiles.tilesets) {
    metatilesBySource.set(entry.source_tileset, entry.metatiles);
  }

  const palettesBySource = new Map<string, number[][][]>();
  for (const entry of palettes.tilesets) {
    const decoded = entry.palettes.map((palette) => palette.colors);
    palettesBySource.set(
      entry.source_tileset,
      decoded,
    );
    basePalettesBySource.set(entry.source_tileset, decoded);
    activePalettesBySource.set(entry.source_tileset, decoded.map((colors) => colors.map((rgb) => [...rgb])));
  }

  const primaryMetatiles = metatilesBySource.get(layout.primary_tileset) ?? [];
  const secondaryMetatiles = metatilesBySource.get(layout.secondary_tileset) ?? [];
  const primaryPalettes = palettesBySource.get(layout.primary_tileset) ?? [];
  const secondaryPalettes = palettesBySource.get(layout.secondary_tileset) ?? [];

  let animationState = tilesetAnimationStates.get(renderAssets.pair_id);
  if (!animationState) {
    animationState = createTilesetAnimationState(layout, renderAssets.pair_id);
    tilesetAnimationStates.set(renderAssets.pair_id, animationState);
  }
  activeTilesetAnimationState = animationState;

  for (let y = 0; y < runtimeChunk.height; y += 1) {
    for (let x = 0; x < runtimeChunk.width; x += 1) {
      const tile = runtimeChunk.tiles[y * runtimeChunk.width + x];
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
      const sortedSubtiles = [...metatile.subtiles].sort((a, b) => a.layer_order - b.layer_order);

      for (const subtile of sortedSubtiles) {
        const sourcePage = subtile.tile_index >= primaryTileCount ? 1 : 0;
        const localTileIndex =
          sourcePage === 0 ? subtile.tile_index : subtile.tile_index - primaryTileCount;
        if (localTileIndex < 0) {
          continue;
        }

        const sourceTilesetName =
          sourcePage === 0 ? layout.primary_tileset : layout.secondary_tileset;
        const subtileTexture = textureCache.getTexture({
          atlasPages: indexedAtlasPages,
          pageId: sourcePage,
          localTileIndex: resolveActiveTileSwap(sourcePage, localTileIndex),
          paletteIndex: resolveActivePaletteSwap(sourceTilesetName, subtile.palette_index),
          palettes: activePalettesBySource.get(sourceTilesetName) ?? sourcePalettes,
          animationKey: `${animationState.tickSerial}`,
        });
        if (!subtileTexture) {
          continue;
        }

        const sprite = new Sprite(subtileTexture);
        registerSubtileBinding({
          sprite,
          pageId: sourcePage,
          localTileIndex,
          paletteIndex: subtile.palette_index,
          sourceTileset: sourceTilesetName,
        });
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
        const mapRenderStratum = resolveMapRenderStratum(metatile.layer_type, subtile.layer);
        switch (mapRenderStratum) {
          case MapRenderStratum.BG3:
            mapBg3Layer.addChild(sprite);
            break;
          case MapRenderStratum.BG2:
            mapBg2Layer.addChild(sprite);
            break;
          case MapRenderStratum.BG1:
            mapBg1Layer.addChild(sprite);
            break;
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

function registerSubtileBinding(binding: RenderedSubtileBinding): void {
  renderedSubtileBindings.push(binding);
  const tileKey = `${binding.pageId}:${binding.localTileIndex}`;
  const paletteKey = `${binding.sourceTileset}:${binding.paletteIndex}`;
  const tileBindings = subtileBindingsByTile.get(tileKey);
  if (tileBindings) {
    tileBindings.push(binding);
  } else {
    subtileBindingsByTile.set(tileKey, [binding]);
  }
  const paletteBindings = subtileBindingsByPalette.get(paletteKey);
  if (paletteBindings) {
    paletteBindings.push(binding);
  } else {
    subtileBindingsByPalette.set(paletteKey, [binding]);
  }
}

function resolveActiveTileSwap(pageId: number, localTileIndex: number): number {
  return activeTileSwaps.get(`${pageId}:${localTileIndex}`)?.sourceLocalTileIndex ?? localTileIndex;
}

function resolveActivePaletteSwap(sourceTilesetName: string, paletteIndex: number): number {
  return activePaletteSwaps.get(`${sourceTilesetName}:${paletteIndex}`)?.sourcePaletteIndex ?? paletteIndex;
}

function tickTilesetAnimationClock(deltaMs: number): void {
  if (!activeTilesetAnimationState) {
    return;
  }

  const animationState = activeTilesetAnimationState;
  animationState.accumulatorMs += Math.max(0, deltaMs);
  let steps = Math.floor(animationState.accumulatorMs / TILESET_ANIMATION_STEP_MS);
  if (steps <= 0) {
    return;
  }

  animationState.accumulatorMs -= steps * TILESET_ANIMATION_STEP_MS;
  steps = Math.min(steps, 8);
  for (let i = 0; i < steps; i += 1) {
    stepTilesetAnimation(animationState);
  }
}

function stepTilesetAnimation(animationState: TilesetAnimationState): void {
  const nextTileSwaps = new Map<string, CopyTilesOp>();
  const nextPaletteSwaps = new Map<string, CopyPaletteOp>();
  const nextPaletteBlends = new Map<string, BlendPaletteOp>();

  animationState.primaryCounter =
    (animationState.primaryCounter + 1) % Math.max(animationState.primaryCounterMax, 1);
  animationState.secondaryCounter =
    (animationState.secondaryCounter + 1) % Math.max(animationState.secondaryCounterMax, 1);

  const primaryOps = animationState.primaryCallback?.(
    animationState.primaryCounter,
    animationState.primaryCounterMax,
  );
  const secondaryOps = animationState.secondaryCallback?.(
    animationState.secondaryCounter,
    animationState.secondaryCounterMax,
  );
  for (const op of [...(primaryOps?.ops ?? []), ...(secondaryOps?.ops ?? [])]) {
    if (op.kind === 'copy_tiles') {
      nextTileSwaps.set(`${op.pageId}:${op.destLocalTileIndex}`, op);
    } else if (op.kind === 'copy_palette') {
      nextPaletteSwaps.set(`${op.tilesetName}:${op.destPaletteIndex}`, op);
    } else {
      nextPaletteBlends.set(`${op.tilesetName}:${op.destPaletteIndex}`, op);
    }
  }

  animationState.queuedTileCopies = nextTileSwaps;
  animationState.queuedPaletteCopies = nextPaletteSwaps;
  animationState.queuedPaletteBlends = nextPaletteBlends;
}

function presentTilesetAnimation(): void {
  const animationState = activeTilesetAnimationState;
  if (!animationState) {
    return;
  }
  applyTilesetAnimationDiff(
    animationState.queuedTileCopies,
    animationState.queuedPaletteCopies,
    animationState.queuedPaletteBlends,
    animationState,
  );
}

function applyTilesetAnimationDiff(
  nextTileSwaps: Map<string, CopyTilesOp>,
  nextPaletteSwaps: Map<string, CopyPaletteOp>,
  nextPaletteBlends: Map<string, BlendPaletteOp>,
  animationState: TilesetAnimationState,
): void {
  if (!activeIndexedAtlasPages || !activeTextureCache || activeTilesetAnimationPairId !== animationState.pairId) {
    return;
  }

  const dirtyBindings = new Set<RenderedSubtileBinding>();

  for (const [key, next] of nextTileSwaps.entries()) {
    const current = activeTileSwaps.get(key);
    if (!current || current.sourceLocalTileIndex !== next.sourceLocalTileIndex) {
      for (const binding of subtileBindingsByTile.get(key) ?? []) {
        dirtyBindings.add(binding);
      }
    }
    activeTileSwaps.set(key, next);
  }
  for (const [key, next] of nextPaletteSwaps.entries()) {
    const current = activePaletteSwaps.get(key);
    if (!current || current.sourcePaletteIndex !== next.sourcePaletteIndex) {
      for (const binding of subtileBindingsByPalette.get(key) ?? []) {
        dirtyBindings.add(binding);
      }
    }
    activePaletteSwaps.set(key, next);
  }
  for (const [key, next] of nextPaletteBlends.entries()) {
    const current = activePaletteBlends.get(key);
    if (
      !current ||
      current.sourcePaletteAIndex !== next.sourcePaletteAIndex ||
      current.sourcePaletteBIndex !== next.sourcePaletteBIndex ||
      current.coeffA !== next.coeffA ||
      current.coeffB !== next.coeffB
    ) {
      for (const binding of subtileBindingsByPalette.get(key) ?? []) {
        dirtyBindings.add(binding);
      }
    }
    activePaletteBlends.set(key, next);
  }

  for (const [tileset, basePalettes] of basePalettesBySource.entries()) {
    const mutablePalettes = basePalettes.map((colors) => colors.map((rgb) => [...rgb]));
    activePalettesBySource.set(tileset, mutablePalettes);
  }
  const paletteCopyKeys = [...activePaletteSwaps.keys()].sort();
  for (const key of paletteCopyKeys) {
    const op = activePaletteSwaps.get(key);
    if (!op) {
      continue;
    }
    const mutable = activePalettesBySource.get(op.tilesetName);
    if (!mutable) {
      continue;
    }
    const sourcePalette = mutable[op.sourcePaletteIndex];
    if (!sourcePalette) {
      continue;
    }
    mutable[op.destPaletteIndex] = sourcePalette.map((rgb) => [...rgb]);
  }

  const paletteBlendKeys = [...activePaletteBlends.keys()].sort();
  for (const key of paletteBlendKeys) {
    const op = activePaletteBlends.get(key);
    if (!op) {
      continue;
    }
    const mutable = activePalettesBySource.get(op.tilesetName);
    if (!mutable) {
      continue;
    }
    const paletteA = mutable[op.sourcePaletteAIndex];
    const paletteB = mutable[op.sourcePaletteBIndex];
    if (!paletteA || !paletteB) {
      continue;
    }
    const mix = paletteA.map((rgbA, idx) => {
      const rgbB = paletteB[idx] ?? rgbA;
      return [
        Math.round(((rgbA[0] ?? 0) * op.coeffA + (rgbB[0] ?? 0) * op.coeffB) / 16),
        Math.round(((rgbA[1] ?? 0) * op.coeffA + (rgbB[1] ?? 0) * op.coeffB) / 16),
        Math.round(((rgbA[2] ?? 0) * op.coeffA + (rgbB[2] ?? 0) * op.coeffB) / 16),
      ];
    });
    mutable[op.destPaletteIndex] = mix;
  }

  if (dirtyBindings.size === 0) {
    return;
  }

  animationState.tickSerial += 1;
  for (const binding of dirtyBindings) {
    const texture = activeTextureCache.getTexture({
      atlasPages: activeIndexedAtlasPages,
      pageId: binding.pageId,
      localTileIndex: resolveActiveTileSwap(binding.pageId, binding.localTileIndex),
      paletteIndex: resolveActivePaletteSwap(binding.sourceTileset, binding.paletteIndex),
      palettes: activePalettesBySource.get(binding.sourceTileset) ?? [],
      animationKey: `${animationState.tickSerial}`,
    });
    if (texture) {
      binding.sprite.texture = texture;
    }
  }
}

function resolveRuntimeMapChunk(snapshot: WorldSnapshot, layout: LayoutFile): DecodedMapChunk {
  try {
    return decodeWorldSnapshotMapChunk(snapshot.map_chunk);
  } catch (error) {
    if (import.meta.env.DEV) {
      console.warn(
        `[world-snapshot] using local layout fallback after map_chunk decode failure map_id=${snapshot.map_id} hash=${toHex(snapshot.map_chunk_hash)} reason=${String(error)}`,
      );
      return {
        width: layout.width,
        height: layout.height,
        tiles: layout.tiles,
      };
    }

    throw error;
  }
}

function decodeWorldSnapshotMapChunk(rawChunk: Uint8Array): DecodedMapChunk {
  if (rawChunk.length === 0) {
    throw new Error('empty map_chunk payload');
  }

  const decoder = new TextDecoder();
  const trimmed = decoder.decode(rawChunk).trimStart();
  if (trimmed.startsWith('{')) {
    const parsed = JSON.parse(trimmed) as Partial<DecodedMapChunk>;
    if (
      typeof parsed.width === 'number' &&
      typeof parsed.height === 'number' &&
      Array.isArray(parsed.tiles)
    ) {
      return validateDecodedChunk({
        width: parsed.width,
        height: parsed.height,
        tiles: parsed.tiles as LayoutTile[],
      });
    }
  }

  if (rawChunk.length < 8) {
    throw new Error(`map_chunk payload too short: ${rawChunk.length}`);
  }

  const width = readU16(rawChunk, 0);
  const height = readU16(rawChunk, 2);
  const tileCount = readU32(rawChunk, 4);
  const payload = rawChunk.subarray(8);

  if (payload.length === tileCount * 4) {
    const tiles: LayoutTile[] = new Array(tileCount);
    let offset = 0;
    for (let i = 0; i < tileCount; i += 1) {
      tiles[i] = {
        metatile_id: readU16(payload, offset),
        collision: readU8(payload, offset + 2),
        behavior_id: readU8(payload, offset + 3),
      };
      offset += 4;
    }
    return validateDecodedChunk({ width, height, tiles });
  }

  if (payload.length === tileCount * 2) {
    const tiles: LayoutTile[] = new Array(tileCount);
    for (let i = 0; i < tileCount; i += 1) {
      const raw = readU16(payload, i * 2);
      tiles[i] = {
        metatile_id: raw & 0x03ff,
        collision: (raw >> 10) & 0x003f,
        behavior_id: 0,
      };
    }
    return validateDecodedChunk({ width, height, tiles });
  }

  throw new Error(
    `map_chunk payload length did not match known schemas (payload=${payload.length}, tile_count=${tileCount})`,
  );
}

function validateDecodedChunk(chunk: DecodedMapChunk): DecodedMapChunk {
  const expectedTileCount = chunk.width * chunk.height;
  if (chunk.tiles.length !== expectedTileCount) {
    throw new Error(
      `decoded map_chunk tile count mismatch: got=${chunk.tiles.length} expected=${expectedTileCount}`,
    );
  }

  return chunk;
}

function toHex(raw: Uint8Array): string {
  return Array.from(raw, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function composeServerMapId(groupIndex: number, mapIndex: number): number {
  return ((groupIndex & 0xff) << 8) | (mapIndex & 0xff);
}

async function getMapIdToLayoutJsonPath(): Promise<Map<number, string>> {
  if (!mapIdToLayoutJsonPathPromise) {
    mapIdToLayoutJsonPathPromise = (async () => {
      const [mapsIndex, layoutsIndex] = await Promise.all([
        loadJsonFromAssets<MapsIndexFile>('maps_index.json'),
        loadJsonFromAssets<LayoutsIndexFile>('layouts_index.json'),
      ]);
      const layoutIdToDecodedPath = new Map<string, string>();
      for (const layout of layoutsIndex.layouts) {
        layoutIdToDecodedPath.set(layout.id, layout.decoded_path);
      }

      const mapIdToLayoutJsonPath = new Map<number, string>();
      for (const map of mapsIndex.maps) {
        const decodedPath = layoutIdToDecodedPath.get(map.layout_id);
        if (!decodedPath) {
          continue;
        }

        mapIdToLayoutJsonPath.set(composeServerMapId(map.group_index, map.map_index), decodedPath);
      }

      return mapIdToLayoutJsonPath;
    })();
  }

  return mapIdToLayoutJsonPathPromise;
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

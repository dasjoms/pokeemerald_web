import { Application, Assets, Container, Graphics, Sprite, TextureSource, TextureStyle } from 'pixi.js';
import {
  Direction,
  MessageType,
  MovementMode,
  PlayerAvatar,
  PROTOCOL_VERSION,
  RejectionReason,
  type SessionAccepted,
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
import {
  MapRenderStratum,
  resolveMapRenderStratum,
} from './mapLayerComposition';
import { createTilesetAnimationState, type TileAnimsFile } from './tilesetAnimation';
import { applyCopyTilesOpsToActiveSwaps, type ActiveTileSwapSource } from './tilesetAnimationRendererState';
import {
  loadPlayerAnimationAssets,
  PlayerAnimationController,
  type PlayerAnimationActionId,
} from './playerAnimation';
import {
  movementModeStepDurationMs,
  startAuthoritativeWalkTransition as createAuthoritativeWalkTransition,
  tickWalkTransition as tickWalkTransitionState,
  type WalkTransition,
  type WalkTransitionMutableState,
} from './walkTransitionPipeline';
import {
  buildLayerSubtileOccupancy,
  resolvePlayerLayerSampleTile,
  resolvePlayerRenderPriority,
  type PlayerObjectRenderPriorityState,
} from './playerLayerSelection';

type ServerMessage =
  | { type: MessageType.SESSION_ACCEPTED; payload: SessionAccepted }
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
  tile_anims: string;
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
  renderTileX: number;
  renderTileY: number;
};

type CopyTilesOp = {
  kind: 'copy_tiles';
  pageId: number;
  destLocalTileIndex: number;
  sourcePayloadOffsetTiles: number;
  tileCount: number;
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
  framePayloadTileIndices: Uint8Array | null;
  framePayloadTileCount: number;
};

type RenderedSubtileBinding = {
  sprite: Sprite;
  pageId: number;
  localTileIndex: number;
  paletteIndex: number;
  sourceTileset: string;
};

type PlayersManifestFile = {
  avatars: Array<{
    avatar_id: 'brendan' | 'may';
    sheet_sources: {
      normal: { source_path: string };
      running: { source_path: string };
    };
  }>;
};

type MapTileRenderPriorityContext = {
  metatileGlobalId: number;
  metatileLocalId: number;
  metatileLayerType: number | undefined;
  behaviorId: number;
  layer0SubtileMask: number;
  layer1SubtileMask: number;
  hasLayer0: boolean;
  hasLayer1: boolean;
};

type WalkInputController = {
  handleKeyDown: (event: KeyboardEvent) => void;
  handleKeyUp: (event: KeyboardEvent) => void;
  cycleTraversalTestMode: () => void;
  tick: () => void;
  markWalkResultReceived: (result: WalkResult) => void;
  markWalkTransitionCompleted: () => void;
  hasPendingAcceptedOrDispatchableStep: () => boolean;
  getTraversalTestMode: () => TraversalTestMode;
  getMovementMode: () => MovementMode;
  reset: () => void;
};

enum TraversalTestMode {
  ON_FOOT,
  MACH,
  ACRO,
}

const TILE_SIZE = 16;
const SUBTILE_SIZE = 8;
const RENDER_SCALE = 4;
const TILESET_ANIMATION_STEP_MS = 1000 / 60;
const ENABLE_CLIENT_PREDICTION =
  new URLSearchParams(window.location.search).get('predict') === '1';
const ENABLE_DEBUG_OVERLAY_DEFAULT =
  new URLSearchParams(window.location.search).get('debug') === '1';
const jsonAssetLoaders = import.meta.glob('../../assets/**/*.json');
const binaryAssetUrls = import.meta.glob('../../assets/**/*.bin', {
  query: '?url',
  import: 'default',
  eager: true,
}) as Record<string, string>;
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
  renderTileX: 0,
  renderTileY: 0,
};
const pendingMovementModesByInputSeq = new Map<number, MovementMode>();

// A directional key press shorter than this threshold is treated as a turn-only tap:
// local facing updates immediately, but no WalkInput is emitted.
const TURN_ONLY_TAP_MS = 90;
let activeWalkTransition: WalkTransition | null = null;

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
const activeTileSwaps = new Map<string, ActiveTileSwapSource>();
const activePaletteSwaps = new Map<string, CopyPaletteOp>();
const activePaletteBlends = new Map<string, BlendPaletteOp>();
const basePalettesBySource = new Map<string, number[][][]>();
const activePalettesBySource = new Map<string, number[][][]>();
const appRoot = document.getElementById('app-root');
if (!appRoot) {
  throw new Error('missing #app-root container');
}

const hud = {
  mapId: document.querySelector<HTMLElement>('[data-hud="mapId"]'),
  tile: document.querySelector<HTMLElement>('[data-hud="tile"]'),
  facing: document.querySelector<HTMLElement>('[data-hud="facing"]'),
  movementMode: document.querySelector<HTMLElement>('[data-hud="movementMode"]'),
  inputSeq: document.querySelector<HTMLElement>('[data-hud="inputSeq"]'),
  serverTick: document.querySelector<HTMLElement>('[data-hud="serverTick"]'),
  animId: document.querySelector<HTMLElement>('[data-hud="animId"]'),
  animFrame: document.querySelector<HTMLElement>('[data-hud="animFrame"]'),
  stridePhase: document.querySelector<HTMLElement>('[data-hud="stridePhase"]'),
};

const app = new Application();
TextureStyle.defaultOptions.scaleMode = 'nearest';
TextureSource.defaultOptions.scaleMode = 'nearest';
await preloadPlayerAvatarSheets();
await app.init({
  background: '#0f172a',
  antialias: false,
  resizeTo: appRoot,
});
appRoot.appendChild(app.canvas);

const gameContainer = new Container();
const worldContainer = new Container();
const mapBg3Layer = new Container();
const actorBelowBg2Layer = new Container();
const mapBg2Layer = new Container();
const actorBetweenBg2Bg1Layer = new Container();
const mapBg1Layer = new Container();
const debugOverlayLayer = new Container();
worldContainer.addChild(mapBg3Layer);
worldContainer.addChild(actorBelowBg2Layer);
worldContainer.addChild(mapBg2Layer);
worldContainer.addChild(actorBetweenBg2Bg1Layer);
worldContainer.addChild(mapBg1Layer);
worldContainer.addChild(debugOverlayLayer);
gameContainer.scale.set(RENDER_SCALE, RENDER_SCALE);
gameContainer.addChild(worldContainer);
app.stage.addChild(gameContainer);
debugOverlayLayer.visible = debugOverlayEnabled;

let activeAvatar: PlayerAvatar = PlayerAvatar.BRENDAN;
let debugAvatarOverride: PlayerAvatar | null = null;
let playerAnimationAssets = await loadPlayerAnimationAssets({
  avatarId: avatarToAssetId(activeAvatar),
  loadJsonFromAssets,
  resolveImageUrlFromAssets,
});
let playerAnimation = new PlayerAnimationController(playerAnimationAssets);
const walkInputController = createWalkInputController({
  sendWalkInput,
  isMovementLocked: () => activeWalkTransition !== null,
  onFacingIntent: (direction) => {
    state.facing = direction;
    if (!activeWalkTransition) {
      playerAnimation.setFacing(direction);
    }
  },
});
const initialPlayerFrame = playerAnimation.getCurrentFrame();
const playerSprite = new Sprite(initialPlayerFrame.texture);
playerSprite.scale.x = initialPlayerFrame.hFlip ? -1 : 1;
playerSprite.x = initialPlayerFrame.hFlip ? playerAnimationAssets.frameWidth : 0;
playerSprite.anchor.set(
  playerAnimationAssets.anchorX / playerAnimationAssets.frameWidth,
  playerAnimationAssets.anchorY / playerAnimationAssets.frameHeight,
);
actorBetweenBg2Bg1Layer.addChild(playerSprite);
let playerActiveActorLayer = actorBetweenBg2Bg1Layer;
let activeMapTileRenderPriorityContexts: (MapTileRenderPriorityContext | undefined)[] = [];
let playerObjectRenderPriorityState: PlayerObjectRenderPriorityState = 'normal';

app.ticker.add(() => {
  walkInputController.tick();
  tickWalkTransition(app.ticker.deltaMS);
  playerAnimation.applyPendingModeChanges();
  playerAnimation.tick(app.ticker.deltaMS);
  presentPlayerAnimationFrame();
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

function resolvePlayerSheetPngPathFromManifest(sourcePath: string): string {
  return sourcePath
    .replace(/^graphics\/object_events\/pics\/people\//, 'players/')
    .replace(/\.4bpp$/i, '.png');
}

async function preloadPlayerAvatarSheets(): Promise<void> {
  const manifest = await loadJsonFromAssets<PlayersManifestFile>('players/players_manifest.json');
  const targetAvatarIds = new Set(['brendan', 'may']);
  const preloadUrls: string[] = [];

  for (const avatar of manifest.avatars) {
    if (!targetAvatarIds.has(avatar.avatar_id)) {
      continue;
    }

    preloadUrls.push(
      await resolveImageUrlFromAssets(
        resolvePlayerSheetPngPathFromManifest(avatar.sheet_sources.normal.source_path),
      ),
    );
    preloadUrls.push(
      await resolveImageUrlFromAssets(
        resolvePlayerSheetPngPathFromManifest(avatar.sheet_sources.running.source_path),
      ),
    );
  }

  if (preloadUrls.length > 0) {
    await Assets.load(preloadUrls);
  }
}

async function loadBinaryFromAssets(repoRelativePath: string): Promise<Uint8Array> {
  const normalized = normalizeRepoRelative(repoRelativePath);
  const modulePath = `../../assets/${normalized}`;
  const binaryUrl = binaryAssetUrls[modulePath];
  if (!binaryUrl) {
    throw new Error(`missing binary asset at ${modulePath}`);
  }
  const response = await fetch(binaryUrl);
  if (!response.ok) {
    throw new Error(`failed to fetch binary asset ${modulePath}: ${response.status}`);
  }
  return new Uint8Array(await response.arrayBuffer());
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
    tile_anims: `render/${pairId}/tile_anims.json`,
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
    await applyAuthoritativeAvatar(message.payload.avatar);
    state.lastAckServerTick = message.payload.server_frame;
    renderHud();
    return;
  }

  if (message.type === MessageType.WORLD_SNAPSHOT) {
    const snapshot = message.payload;
    state.mapId = snapshot.map_id;
    state.playerTileX = snapshot.player_pos.x;
    state.playerTileY = snapshot.player_pos.y;
    state.renderTileX = state.playerTileX;
    state.renderTileY = state.playerTileY;
    activeWalkTransition = null;
    state.facing = snapshot.facing;
    await applyAuthoritativeAvatar(snapshot.avatar);
    playerAnimation.stopMoving(snapshot.facing);
    state.lastAckServerTick = snapshot.server_frame;
    pendingPredictedInputs.clear();
    pendingMovementModesByInputSeq.clear();
    walkInputController.reset();

    await renderMapFromSnapshot(snapshot);
    return;
  }

  const result = message.payload;
  walkInputController.markWalkResultReceived(result);
  const acceptedMovementMode =
    pendingMovementModesByInputSeq.get(result.input_seq) ?? MovementMode.WALK;
  pendingMovementModesByInputSeq.delete(result.input_seq);
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
  const previousFacing = state.facing;
  state.facing = result.facing;
  if (result.accepted) {
    // Contract: on accepted input, authoritative_pos is the server tile *after* applying that step.
    // This lets the first interpolation run immediately toward the accepted destination.
    startAuthoritativeWalkTransition(result.facing, acceptedMovementMode);
    playerAnimation.startActionStep(
      result.facing,
      movementModeToAnimationActionId(acceptedMovementMode, result.facing, previousFacing),
      movementModeStepDurationMs(acceptedMovementMode),
    );
  } else {
    activeWalkTransition = null;
    state.renderTileX = state.playerTileX;
    state.renderTileY = state.playerTileY;
    playerAnimation.stopMoving(result.facing);
  }
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
    state.renderTileX = state.playerTileX;
    state.renderTileY = state.playerTileY;
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
  let tileAnims: TileAnimsFile | null = null;
  try {
    tileAnims = await loadJsonFromAssets<TileAnimsFile>(renderAssets.tile_anims);
  } catch (error) {
    if (import.meta.env.DEV) {
      console.error(
        `[tileset-parity] missing/invalid tile animation program for pair=${renderAssets.pair_id}:`,
        error,
      );
    }
  }

  state.mapWidth = runtimeChunk.width;
  state.mapHeight = runtimeChunk.height;

  mapBg3Layer.removeChildren();
  mapBg2Layer.removeChildren();
  mapBg1Layer.removeChildren();
  debugOverlayLayer.removeChildren();
  actorBelowBg2Layer.removeChildren();
  actorBetweenBg2Bg1Layer.removeChildren();
  actorBetweenBg2Bg1Layer.addChild(playerSprite);
  playerActiveActorLayer = actorBetweenBg2Bg1Layer;
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
  activeMapTileRenderPriorityContexts = new Array(runtimeChunk.width * runtimeChunk.height);

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
    let framePayloadBlob: Uint8Array | null = null;
    if (tileAnims?.frame_payload_blob) {
      try {
        framePayloadBlob = await loadBinaryFromAssets(`render/${renderAssets.pair_id}/${tileAnims.frame_payload_blob}`);
      } catch (error) {
        if (import.meta.env.DEV) {
          console.error(
            `[tileset-parity] missing/invalid tile animation frame payload blob for pair=${renderAssets.pair_id}:`,
            error,
          );
        }
      }
    }
    animationState = createTilesetAnimationState(
      tileAnims ?? {
        tile_anims_version: 2,
        pair_id: renderAssets.pair_id,
        programs: {
          primary: {
            source_tileset: layout.primary_tileset,
            counter_max_expr: '256',
            events: [],
          },
          secondary: {
            source_tileset: layout.secondary_tileset,
            counter_max_expr: 'sPrimaryTilesetAnimCounterMax',
            events: [],
          },
        },
        frame_arrays: {},
      },
      primaryTileCount,
      framePayloadBlob,
    );
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
      const { layer0SubtileMask, layer1SubtileMask, hasLayer0, hasLayer1 } =
        buildLayerSubtileOccupancy(metatile.subtiles);
      activeMapTileRenderPriorityContexts[y * runtimeChunk.width + x] = {
        metatileGlobalId: tile.metatile_id,
        metatileLocalId: metatile.metatile_index,
        metatileLayerType: metatile.layer_type,
        behaviorId: tile.behavior_id,
        layer0SubtileMask,
        layer1SubtileMask,
        hasLayer0,
        hasLayer1,
      };

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
          localTileIndex,
          sourceTileIndices: resolveFramePayloadTileIndices(animationState, sourcePage, localTileIndex),
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

function resolveActiveTileSwap(pageId: number, localTileIndex: number): ActiveTileSwapSource | null {
  return activeTileSwaps.get(`${pageId}:${localTileIndex}`) ?? null;
}

function resolveActivePaletteSwap(sourceTilesetName: string, paletteIndex: number): number {
  return activePaletteSwaps.get(`${sourceTilesetName}:${paletteIndex}`)?.sourcePaletteIndex ?? paletteIndex;
}

function resolveFramePayloadTileIndices(
  animationState: TilesetAnimationState,
  pageId: number,
  localTileIndex: number,
): Uint8Array | undefined {
  const swap = resolveActiveTileSwap(pageId, localTileIndex);
  if (!swap || !animationState.framePayloadTileIndices) {
    return undefined;
  }
  const start = swap.sourcePayloadTileIndex * 64;
  const end = start + 64;
  if (end > animationState.framePayloadTileIndices.length) {
    return undefined;
  }
  return animationState.framePayloadTileIndices.subarray(start, end);
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

  const dirtyTileKeys = applyCopyTilesOpsToActiveSwaps(nextTileSwaps, activeTileSwaps);
  for (const tileKey of dirtyTileKeys) {
    for (const binding of subtileBindingsByTile.get(tileKey) ?? []) {
      dirtyBindings.add(binding);
    }
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
      localTileIndex: binding.localTileIndex,
      sourceTileIndices: resolveFramePayloadTileIndices(animationState, binding.pageId, binding.localTileIndex),
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
    if (event.key === 'F4') {
      event.preventDefault();
      if (event.repeat) {
        return;
      }
      void toggleDebugAvatar();
      return;
    }
    if (event.key === 'F5') {
      event.preventDefault();
      if (event.repeat) {
        return;
      }
      walkInputController.cycleTraversalTestMode();
      return;
    }
    walkInputController.handleKeyDown(event);
  });
  window.addEventListener('keyup', (event) => {
    walkInputController.handleKeyUp(event);
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

function sendWalkInput(direction: Direction, movementMode: MovementMode): void {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    return;
  }

  const inputSeq = state.lastInputSeq;
  state.lastInputSeq += 1;
  socket.send(encodeWalkInput(direction, movementMode, inputSeq, BigInt(Date.now())));
  pendingMovementModesByInputSeq.set(inputSeq, movementMode);

  if (ENABLE_CLIENT_PREDICTION) {
    applyPredictedWalk(direction, inputSeq, movementMode);
  }
}

function createWalkInputController(config: {
  sendWalkInput: (direction: Direction, movementMode: MovementMode) => void;
  isMovementLocked: () => boolean;
  onFacingIntent: (direction: Direction) => void;
}): WalkInputController {
  const heldDirections = new Set<Direction>();
  const heldDirectionPressedAtMs = new Map<Direction, number>();
  const directionOrder: Direction[] = [];
  let activeIntent: Direction | null = null;
  let bufferedIntent: Direction | null = null;
  let hasPendingWalkRequest = false;
  let traversalTestMode: TraversalTestMode = TraversalTestMode.ON_FOOT;

  const traversalTestModeToMovementMode = (mode: TraversalTestMode): MovementMode => {
    switch (mode) {
      case TraversalTestMode.MACH:
        return MovementMode.MACH_BIKE;
      case TraversalTestMode.ACRO:
        return MovementMode.ACRO_CRUISE;
      case TraversalTestMode.ON_FOOT:
      default:
        return MovementMode.WALK;
    }
  };

  const removeDirectionFromOrder = (direction: Direction): void => {
    const index = directionOrder.indexOf(direction);
    if (index >= 0) {
      directionOrder.splice(index, 1);
    }
  };

  const canDispatchNewIntent = (): boolean =>
    !hasPendingWalkRequest && !config.isMovementLocked() && activeIntent === null;

  const hasSatisfiedTapThreshold = (direction: Direction, nowMs: number): boolean => {
    const pressedAtMs = heldDirectionPressedAtMs.get(direction);
    if (pressedAtMs === undefined) {
      return false;
    }
    return nowMs - pressedAtMs >= TURN_ONLY_TAP_MS;
  };

  const getEligibleHeldDirection = (nowMs: number): Direction | null => {
    for (let i = directionOrder.length - 1; i >= 0; i -= 1) {
      const direction = directionOrder[i];
      if (!heldDirections.has(direction)) {
        continue;
      }
      if (hasSatisfiedTapThreshold(direction, nowMs)) {
        return direction;
      }
    }
    return null;
  };

  const sendIntent = (direction: Direction): void => {
    const movementMode = traversalTestModeToMovementMode(traversalTestMode);
    config.onFacingIntent(direction);
    config.sendWalkInput(direction, movementMode);
    activeIntent = direction;
    hasPendingWalkRequest = true;
  };

  const updateBufferedIntentFromHeldDirections = (nowMs: number): void => {
    const eligibleHeldDirection = getEligibleHeldDirection(nowMs);
    if (eligibleHeldDirection !== null) {
      bufferedIntent = eligibleHeldDirection;
      return;
    }

    if (bufferedIntent !== null && !heldDirections.has(bufferedIntent)) {
      bufferedIntent = null;
    }
  };

  const maybeDispatchIntent = (nowMs: number): void => {
    updateBufferedIntentFromHeldDirections(nowMs);
    if (!canDispatchNewIntent()) {
      return;
    }

    if (
      bufferedIntent !== null &&
      heldDirections.has(bufferedIntent) &&
      hasSatisfiedTapThreshold(bufferedIntent, nowMs)
    ) {
      const buffered = bufferedIntent;
      bufferedIntent = null;
      sendIntent(buffered);
      return;
    }

    const heldDirection = getEligibleHeldDirection(nowMs);
    if (heldDirection !== null) {
      bufferedIntent = null;
      sendIntent(heldDirection);
    }
  };

  const hasPendingAcceptedOrDispatchableStep = (nowMs: number): boolean => {
    updateBufferedIntentFromHeldDirections(nowMs);
    if (hasPendingWalkRequest) {
      return true;
    }

    if (
      bufferedIntent !== null &&
      heldDirections.has(bufferedIntent) &&
      hasSatisfiedTapThreshold(bufferedIntent, nowMs)
    ) {
      return true;
    }

    return getEligibleHeldDirection(nowMs) !== null;
  };

  return {
    handleKeyDown(event: KeyboardEvent): void {
      const direction = keyToDirection(event.key);
      if (direction === null) {
        return;
      }

      event.preventDefault();
      if (event.repeat) {
        return;
      }

      const isFirstPressForDirection = !heldDirections.has(direction);
      heldDirections.add(direction);
      heldDirectionPressedAtMs.set(direction, performance.now());
      removeDirectionFromOrder(direction);
      directionOrder.push(direction);

      if (isFirstPressForDirection) {
        config.onFacingIntent(direction);
      }

      maybeDispatchIntent(performance.now());
    },
    cycleTraversalTestMode(): void {
      switch (traversalTestMode) {
        case TraversalTestMode.ON_FOOT:
          traversalTestMode = TraversalTestMode.MACH;
          return;
        case TraversalTestMode.MACH:
          traversalTestMode = TraversalTestMode.ACRO;
          return;
        case TraversalTestMode.ACRO:
        default:
          traversalTestMode = TraversalTestMode.ON_FOOT;
      }
    },
    handleKeyUp(event: KeyboardEvent): void {
      const direction = keyToDirection(event.key);
      if (direction === null) {
        return;
      }

      event.preventDefault();
      heldDirections.delete(direction);
      heldDirectionPressedAtMs.delete(direction);
      removeDirectionFromOrder(direction);
      if (bufferedIntent === direction) {
        bufferedIntent = null;
      }
    },
    tick(): void {
      maybeDispatchIntent(performance.now());
    },
    markWalkResultReceived(result: WalkResult): void {
      hasPendingWalkRequest = false;
      if (!result.accepted) {
        activeIntent = null;
        maybeDispatchIntent(performance.now());
      }
    },
    markWalkTransitionCompleted(): void {
      activeIntent = null;
      maybeDispatchIntent(performance.now());
    },
    hasPendingAcceptedOrDispatchableStep(): boolean {
      return hasPendingAcceptedOrDispatchableStep(performance.now());
    },
    getTraversalTestMode(): TraversalTestMode {
      return traversalTestMode;
    },
    getMovementMode(): MovementMode {
      return traversalTestModeToMovementMode(traversalTestMode);
    },
    reset(): void {
      hasPendingWalkRequest = false;
      activeIntent = null;
      bufferedIntent = null;
      traversalTestMode = TraversalTestMode.ON_FOOT;
      heldDirections.clear();
      heldDirectionPressedAtMs.clear();
      directionOrder.length = 0;
    },
  };
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

function encodeWalkInput(
  direction: Direction,
  movementMode: MovementMode,
  inputSeq: number,
  clientTime: bigint,
): Uint8Array {
  const payload = new Uint8Array(14);
  const payloadView = new DataView(payload.buffer);
  payloadView.setUint8(0, direction);
  payloadView.setUint8(1, movementMode);
  payloadView.setUint32(2, inputSeq, true);
  payloadView.setBigUint64(6, clientTime, true);

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
        avatar: readU8(payload, 8) as PlayerAvatar,
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
    const avatar = readU8(payload, offset) as PlayerAvatar;
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
        avatar,
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

function avatarToAssetId(avatar: PlayerAvatar): 'brendan' | 'may' {
  return avatar === PlayerAvatar.MAY ? 'may' : 'brendan';
}

async function applyAuthoritativeAvatar(avatar: PlayerAvatar): Promise<void> {
  if (debugAvatarOverride !== null) {
    return;
  }

  if (avatar === activeAvatar) {
    return;
  }

  await applyAvatarAssets(avatar);
}

async function toggleDebugAvatar(): Promise<void> {
  const nextAvatar =
    activeAvatar === PlayerAvatar.BRENDAN ? PlayerAvatar.MAY : PlayerAvatar.BRENDAN;
  debugAvatarOverride = nextAvatar;
  await applyAvatarAssets(nextAvatar);
}

async function applyAvatarAssets(avatar: PlayerAvatar): Promise<void> {
  activeAvatar = avatar;
  playerAnimationAssets = await loadPlayerAnimationAssets({
    avatarId: avatarToAssetId(avatar),
    loadJsonFromAssets,
    resolveImageUrlFromAssets,
  });
  playerAnimation = new PlayerAnimationController(playerAnimationAssets);
  playerAnimation.stopMoving(state.facing);
  playerSprite.anchor.set(
    playerAnimationAssets.anchorX / playerAnimationAssets.frameWidth,
    playerAnimationAssets.anchorY / playerAnimationAssets.frameHeight,
  );
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

function movementModeToAnimationActionId(
  movementMode: MovementMode,
  facing: Direction,
  previousFacing: Direction,
): PlayerAnimationActionId {
  switch (movementMode) {
    case MovementMode.WALK:
      return 'walk';
    case MovementMode.RUN:
      return 'run';
    case MovementMode.MACH_BIKE:
      return facing === previousFacing ? 'mach_travel' : 'mach_turn';
    case MovementMode.ACRO_CRUISE:
      return facing === previousFacing ? 'acro_travel' : 'acro_turn';
    case MovementMode.ACRO_WHEELIE_PREP:
      return 'acro_wheelie';
    case MovementMode.ACRO_WHEELIE_MOVE:
      return facing === previousFacing ? 'acro_wheelie_move' : 'acro_turn';
    case MovementMode.BUNNY_HOP:
      return 'acro_hop';
  }
}

function applyPredictedWalk(
  direction: Direction,
  inputSeq: number,
  movementMode: MovementMode,
): void {
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
  state.renderTileX = state.playerTileX;
  state.renderTileY = state.playerTileY;
  const previousFacing = state.facing;
  state.facing = direction;
  playerAnimation.startActionStep(
    direction,
    movementModeToAnimationActionId(movementMode, direction, previousFacing),
  );
}

function positionPlayerSprite(): void {
  updatePlayerActorLayer();
  playerSprite.x = state.renderTileX * TILE_SIZE + TILE_SIZE / 2;
  playerSprite.y = state.renderTileY * TILE_SIZE + TILE_SIZE;
}

function updatePlayerActorLayer(): void {
  const sampleTile = resolvePlayerLayerSampleTile({
    playerTileX: state.playerTileX,
    playerTileY: state.playerTileY,
    activeWalkTransition,
  });
  const tileX = sampleTile.x;
  const tileY = sampleTile.y;
  const resolvedLayer = resolveActorLayerForPlayer(tileX, tileY);
  if (resolvedLayer === playerActiveActorLayer) {
    return;
  }

  playerActiveActorLayer.removeChild(playerSprite);
  resolvedLayer.addChild(playerSprite);
  playerActiveActorLayer = resolvedLayer;
}

function resolveActorLayerForPlayer(tileX: number, tileY: number): Container {
  const tileContext =
    tileX < 0 || tileY < 0 || tileX >= state.mapWidth || tileY >= state.mapHeight
      ? undefined
      : activeMapTileRenderPriorityContexts[tileY * state.mapWidth + tileX];
  const actorStratum = resolvePlayerRenderPriority({
    objectPriorityState: playerObjectRenderPriorityState,
    tileContext,
  });
  if (actorStratum === 'below-bg2') {
    return actorBelowBg2Layer;
  }
  return actorBetweenBg2Bg1Layer;
}

function presentPlayerAnimationFrame(): void {
  const selection = playerAnimation.getCurrentFrame();
  playerSprite.texture = selection.texture;
  playerSprite.scale.x = selection.hFlip ? -1 : 1;
}

function updateCamera(): void {
  const centerX = state.renderTileX * TILE_SIZE + TILE_SIZE / 2;
  const centerY = state.renderTileY * TILE_SIZE + TILE_SIZE / 2;
  gameContainer.x = app.screen.width / 2 - centerX * RENDER_SCALE;
  gameContainer.y = app.screen.height / 2 - centerY * RENDER_SCALE;
}

function startAuthoritativeWalkTransition(
  facing: Direction,
  movementMode: MovementMode,
): void {
  activeWalkTransition = createAuthoritativeWalkTransition(
    state,
    facing,
    movementMode,
  );
}

function tickWalkTransition(deltaMs: number): void {
  const walkTransitionState: WalkTransitionMutableState = state;
  activeWalkTransition = tickWalkTransitionState({
    activeWalkTransition,
    state: walkTransitionState,
    deltaMs,
    hasPendingAcceptedOrDispatchableStep: () =>
      walkInputController.hasPendingAcceptedOrDispatchableStep(),
    markWalkTransitionCompleted: () => {
      walkInputController.markWalkTransitionCompleted();
    },
    stopMoving: (direction) => {
      playerAnimation.stopMoving(direction);
    },
  });
}

function renderHud(): void {
  hud.mapId && (hud.mapId.textContent = `${state.mapId}`);
  hud.tile && (hud.tile.textContent = `${state.playerTileX}, ${state.playerTileY}`);
  hud.facing && (hud.facing.textContent = Direction[state.facing]);
  if (hud.movementMode) {
    const traversalTestMode = walkInputController.getTraversalTestMode();
    const movementMode = walkInputController.getMovementMode();
    hud.movementMode.textContent = `${TraversalTestMode[traversalTestMode]} (${MovementMode[movementMode]})`;
  }
  hud.inputSeq && (hud.inputSeq.textContent = `${Math.max(0, state.lastInputSeq - 1)}`);
  hud.serverTick && (hud.serverTick.textContent = `${state.lastAckServerTick}`);

  const animationDebug = playerAnimation.getDebugState();
  const debugValue = debugOverlayEnabled
    ? {
        animId: animationDebug.animId,
        animFrame: `${animationDebug.frameIndex}`,
        stridePhase: `${animationDebug.stridePhase}`,
      }
    : {
        animId: 'hidden (toggle F3)',
        animFrame: 'hidden (toggle F3)',
        stridePhase: 'hidden (toggle F3)',
      };

  hud.animId && (hud.animId.textContent = debugValue.animId);
  hud.animFrame && (hud.animFrame.textContent = debugValue.animFrame);
  hud.stridePhase && (hud.stridePhase.textContent = debugValue.stridePhase);
}

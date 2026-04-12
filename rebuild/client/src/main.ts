import {
  Application,
  Assets,
  Container,
  Graphics,
  Rectangle,
  Sprite,
  Texture,
  TextureSource,
  TextureStyle,
} from 'pixi.js';
import {
  AcroBikeSubstate,
  BikeTransitionType,
  type BikeRuntimeDelta,
  DebugTraversalAction,
  Direction,
  HeldDpad,
  HeldButtons,
  HopLandingParticleClass,
  MessageType,
  MovementMode,
  PlayerAction,
  PlayerAvatar,
  PROTOCOL_VERSION,
  RejectionReason,
  StepSpeed,
  TraversalState,
  resolveDirectionFromHeldDpad,
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
  buildPlayerSheetRgba,
  loadPlayerAnimationAssets,
  PlayerAnimationController,
} from './playerAnimation';
import {
  PlayerMovementActionRuntime,
} from './playerMovementActionRuntime';
import {
  startAuthoritativeWalkTransition as createAuthoritativeWalkTransition,
  tickWalkTransition as tickWalkTransitionState,
  type AuthoritativeStepSpeedInput,
  type WalkTransition,
  type WalkTransitionStart,
  type WalkTransitionMutableState,
} from './walkTransitionPipeline';
import {
  BikeEffectRenderer,
  type BikeTireTrackAtlas,
} from './bikeEffectRenderer';
import {
  type BikeTireTrackAnimId,
  type BikeTireTrackManifestMetadata,
} from './bikeTireTrackTransitionResolver';
import {
  FIELD_EFFECTS_MANIFEST_PATH,
  type FieldEffectsManifest,
  resolveBikeTireTrackVariantFromAnimSymbol,
  resolveBikeTireTracksMetadataOrThrow,
} from './fieldEffectsManifest';
import {
  HopShadowRenderer,
  ROM_SHADOW_TEMPLATE_ID_MEDIUM,
  type HopShadowSizeVariant,
} from './hopShadowRenderer';
import { HopParticleRenderer } from './hopParticleRenderer';
import { computeObjectDepth } from './objectDepth';
import {
  resolveHopParticleBaseSubpriority,
  shouldRenderHopParticleAbovePlayer,
} from './hopParticleDepth';
import {
  buildHopParticleLandingEvent,
  type HopParticleLandingQueueInput,
  type QueuedHopLandingParticleEvent,
} from './hopParticlePriority';
import {
  createWalkInputController,
  encodeHeldInputState,
  encodeWalkInput,
  type WalkInputController,
} from './input';
import {
  buildLayerSubtileOccupancy,
  resolvePlayerLayerSampleTile,
  resolvePlayerRenderPriority,
  type PlayerObjectRenderPriorityState,
} from './playerLayerSelection';
import { createMapWindowBacking } from './mapWindowBacking';
import { OverworldWindowRenderer } from './overworldWindowRenderer';

type ServerMessage =
  | { type: MessageType.SESSION_ACCEPTED; payload: SessionAccepted }
  | { type: MessageType.WORLD_SNAPSHOT; payload: WorldSnapshot }
  | { type: MessageType.WALK_RESULT; payload: WalkResult }
  | { type: MessageType.BIKE_RUNTIME_DELTA; payload: BikeRuntimeDelta };

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

type InitialWindowCenterSync = {
  kind: 'initial_window_center';
  centerTileX: number;
  centerTileY: number;
};

type TileBoundaryCameraDeltaSync = {
  kind: 'tile_boundary_camera_delta';
  deltaTileX: number;
  deltaTileY: number;
};

type DirtyMetatilePatchSync = {
  kind: 'dirty_metatile_patch';
  tileX: number;
  tileY: number;
  tile: LayoutTile;
};

type WindowSyncMessage =
  | InitialWindowCenterSync
  | TileBoundaryCameraDeltaSync
  | DirtyMetatilePatchSync;

type DecodedMapChunkHooks = {
  dirtyPatches: DirtyMetatilePatchSync[];
};

type ResolvedRuntimeMapChunk = {
  chunk: DecodedMapChunk;
  windowSync: WindowSyncMessage[];
};

type MapMutationApplier = {
  setMetatileAt: (tileX: number, tileY: number, tile: LayoutTile) => boolean;
  redrawDirtyIfVisible: () => void;
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
  border_tiles?: LayoutTile[];
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
  lastAuthoritativeStepFacing: Direction;
  traversalState: TraversalState;
  preferredBikeType: TraversalState;
  playerElevation: number;
  authoritativeStepSpeed?: StepSpeed;
  machSpeedStage?: number;
  acroSubstate?: AcroBikeSubstate;
  bikeTransition?: BikeTransitionType;
  lastInputSeq: number;
  lastHeldInputSeq: number;
  lastAckServerTick: number;
  renderTileX: number;
  renderTileY: number;
  windowOriginTileX: number;
  windowOriginTileY: number;
  pixelOffsetX: number;
  pixelOffsetY: number;
  verticalCameraBiasPx: number;
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

type WindowSlotRenderState = {
  bg1Sprites: Sprite[];
  bg2Sprites: Sprite[];
  bg3Sprites: Sprite[];
  debugOverlay?: Graphics;
  bindings: RenderedSubtileBinding[];
};

type PlayersManifestFile = {
  avatars: Array<{
    avatar_id: 'brendan' | 'may';
    sheet_sources: Record<string, { source_path: string }>;
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

type AcroHopFailureReason =
  | 'b_released'
  | 'direction_pressed'
  | 'left_acro_state'
  | 'stale_or_missing_authoritative_progress';

type AcroHopAttempt = {
  id: number;
  startedAtServerFrame: number;
  startedAtHeldInputSeq: number | null;
};

type PendingHopLandingParticleEvent = QueuedHopLandingParticleEvent;

const TILE_SIZE = 16;
const SUBTILE_SIZE = 8;
const RENDER_SCALE = 4;
const ROM_BG_VERTICAL_SCROLL_BIAS_PX = 8;
const TILESET_ANIMATION_STEP_MS = 1000 / 60;
const ENABLE_CLIENT_PREDICTION =
  new URLSearchParams(window.location.search).get('predict') === '1';
const ENABLE_DEBUG_OVERLAY_DEFAULT =
  new URLSearchParams(window.location.search).get('debug') === '1';
const ENABLE_DEV_DEBUG_ACTIONS =
  new URLSearchParams(window.location.search).get('devDebugActions') === '1';
const ENABLE_WINDOW_STREAM_RUNTIME =
  new URLSearchParams(window.location.search).get('windowStream') === '1';
const DEBUG_ACRO_HOP = true;
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
const rawTextAssetContents = import.meta.glob('../../assets/**/*.pal', {
  query: '?raw',
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
  lastAuthoritativeStepFacing: Direction.DOWN,
  traversalState: TraversalState.ON_FOOT,
  preferredBikeType: TraversalState.MACH_BIKE,
  playerElevation: 0,
  lastInputSeq: 0,
  lastHeldInputSeq: 0,
  lastAckServerTick: 0,
  renderTileX: 0,
  renderTileY: 0,
  windowOriginTileX: 0,
  windowOriginTileY: 0,
  pixelOffsetX: 0,
  pixelOffsetY: 0,
  verticalCameraBiasPx: ROM_BG_VERTICAL_SCROLL_BIAS_PX,
};
const pendingMovementModesByInputSeq = new Map<number, MovementMode>();

let activeWalkTransition: WalkTransition | null = null;

const pendingPredictedInputs = new Map<number, Direction>();
let hasLoggedPrimaryTileCountMismatch = false;
let socket: WebSocket | null = null;
let debugOverlayEnabled = ENABLE_DEBUG_OVERLAY_DEFAULT;
const indexedAtlasPageCache = new Map<string, IndexedAtlasPages>();
const metatileTextureCaches = new Map<string, MetatileTextureCache>();


const MB_TALL_GRASS = 0x02;
const MB_LONG_GRASS = 0x03;
const MB_POND_WATER = 0x10;
const MB_INTERIOR_DEEP_WATER = 0x11;
const MB_DEEP_WATER = 0x12;
const MB_WATERFALL = 0x13;
const MB_SOOTOPOLIS_DEEP_WATER = 0x14;
const MB_OCEAN_WATER = 0x15;
const MB_NO_SURFACING = 0x19;
const MB_SEAWEED = 0x22;
const MB_SEAWEED_NO_SURFACING = 0x2a;
const MB_UNUSED_SOOTOPOLIS_DEEP_WATER_2 = 0x1a;
const MB_PUDDLE = 0x16;
const MB_ICE = 0x20;
const MB_REFLECTION_UNDER_BRIDGE = 0x2b;
const MB_EASTWARD_CURRENT = 0x50;
const MB_WESTWARD_CURRENT = 0x51;
const MB_NORTHWARD_CURRENT = 0x52;
const MB_SOUTHWARD_CURRENT = 0x53;
const MB_WATER_DOOR = 0x6d;
const MB_WATER_SOUTH_ARROW_WARP = 0x6e;
const MB_UNUSED_6F = 0x6f;

const SURFABLE_WATER_BEHAVIOR_IDS = new Set<number>([
  MB_POND_WATER,
  MB_INTERIOR_DEEP_WATER,
  MB_DEEP_WATER,
  MB_WATERFALL,
  MB_SOOTOPOLIS_DEEP_WATER,
  MB_OCEAN_WATER,
  MB_NO_SURFACING,
  MB_SEAWEED,
  MB_SEAWEED_NO_SURFACING,
  MB_EASTWARD_CURRENT,
  MB_WESTWARD_CURRENT,
  MB_NORTHWARD_CURRENT,
  MB_SOUTHWARD_CURRENT,
  MB_WATER_DOOR,
  MB_WATER_SOUTH_ARROW_WARP,
  MB_UNUSED_6F,
]);

const REFLECTIVE_BEHAVIOR_IDS = new Set<number>([
  MB_POND_WATER,
  MB_PUDDLE,
  MB_UNUSED_SOOTOPOLIS_DEEP_WATER_2,
  MB_ICE,
  MB_SOOTOPOLIS_DEEP_WATER,
  MB_REFLECTION_UNDER_BRIDGE,
]);
const tilesetAnimationStates = new Map<string, TilesetAnimationState>();
let mapIdToLayoutJsonPathPromise: Promise<Map<number, string>> | null = null;
let latestHeldDpad = HeldDpad.NONE;
let latestHeldButtons = HeldButtons.NONE;
let latestHeldInputSeq: number | null = null;
let lastLoggedOutboundHeldState: { heldDpad: number; heldButtons: number } | null = null;
let lastLoggedPrereqBlockSignature: string | null = null;
let nextAcroHopAttemptId = 1;
let activeAcroHopAttempt: AcroHopAttempt | null = null;
let pendingHopLandingParticleEvent: PendingHopLandingParticleEvent | null = null;

let activeTilesetAnimationPairId: string | null = null;
let activeTilesetAnimationState: TilesetAnimationState | null = null;
let activeTextureCache: MetatileTextureCache | null = null;
let activeIndexedAtlasPages: IndexedAtlasPages | null = null;
const renderedSubtileBindings: RenderedSubtileBinding[] = [];
const subtileBindingsByTile = new Map<string, RenderedSubtileBinding[]>();
const subtileBindingsByPalette = new Map<string, RenderedSubtileBinding[]>();
const windowSlotRenderStates = new Map<number, WindowSlotRenderState>();
const activeTileSwaps = new Map<string, ActiveTileSwapSource>();
const activePaletteSwaps = new Map<string, CopyPaletteOp>();
const activePaletteBlends = new Map<string, BlendPaletteOp>();
const basePalettesBySource = new Map<string, number[][][]>();
const activePalettesBySource = new Map<string, number[][][]>();
let activeRuntimeChunk: DecodedMapChunk | null = null;
let activeLayout: LayoutFile | null = null;
let activePrimaryMetatiles: Metatile[] = [];
let activeSecondaryMetatiles: Metatile[] = [];
let activePrimaryPalettes: number[][][] = [];
let activeSecondaryPalettes: number[][][] = [];
let activePrimaryTileCount = 0;
const appRoot = document.getElementById('app-root');
if (!appRoot) {
  throw new Error('missing #app-root container');
}

const hud = {
  mapId: document.querySelector<HTMLElement>('[data-hud="mapId"]'),
  tile: document.querySelector<HTMLElement>('[data-hud="tile"]'),
  facing: document.querySelector<HTMLElement>('[data-hud="facing"]'),
  movementMode: document.querySelector<HTMLElement>('[data-hud="movementMode"]'),
  traversalState: document.querySelector<HTMLElement>('[data-hud="traversalState"]'),
  bikeType: document.querySelector<HTMLElement>('[data-hud="bikeType"]'),
  inputSeq: document.querySelector<HTMLElement>('[data-hud="inputSeq"]'),
  serverTick: document.querySelector<HTMLElement>('[data-hud="serverTick"]'),
  animId: document.querySelector<HTMLElement>('[data-hud="animId"]'),
  animFrame: document.querySelector<HTMLElement>('[data-hud="animFrame"]'),
  stridePhase: document.querySelector<HTMLElement>('[data-hud="stridePhase"]'),
};

const app = new Application();
const HOP_SHADOW_ASSET_PATHS: Readonly<Record<HopShadowSizeVariant, string>> = {
  small: 'field_effects/acro_bike/pics/shadow_small.png',
  medium: 'field_effects/acro_bike/pics/shadow_medium.png',
  large: 'field_effects/acro_bike/pics/shadow_large.png',
  extra_large: 'field_effects/acro_bike/pics/shadow_extra_large.png',
};
const HOP_SHADOW_PALETTE_PATH = 'field_effects/acro_bike/palettes/general_0.pal';
const BIKE_TIRE_TRACKS_PALETTE_PATH = 'field_effects/acro_bike/palettes/general_0.pal';
const hopShadowTextures = new Map<HopShadowSizeVariant, Texture>();
const BIKE_TIRE_TRACK_VARIANTS = [
  'south',
  'north',
  'west',
  'east',
  'se_corner_turn',
  'sw_corner_turn',
  'nw_corner_turn',
  'ne_corner_turn',
] as const satisfies readonly BikeTireTrackAnimId[];
TextureStyle.defaultOptions.scaleMode = 'nearest';
TextureSource.defaultOptions.scaleMode = 'nearest';
await preloadPlayerAvatarSheets();
await preloadHopShadowTextures();
const bikeTireTracksConfig = await preloadBikeTireTracksConfig();
const bikeTireTrackAtlas = bikeTireTracksConfig.atlas;
await app.init({
  background: '#0f172a',
  antialias: false,
  resizeTo: appRoot,
});
appRoot.appendChild(app.canvas);

const gameContainer = new Container();
const worldContainer = new Container();
const mapBg3Layer = new Container();
const shadowBelowBg2Layer = new Container();
const bikeEffectsBelowBg2Layer = new Container();
const objectDepthBelowBg2Layer = new Container({ sortableChildren: true });
const mapBg2Layer = new Container();
const shadowBetweenBg2Bg1Layer = new Container();
const bikeEffectsBetweenBg2Bg1Layer = new Container();
const objectDepthBetweenBg2Bg1Layer = new Container({ sortableChildren: true });
const mapBg1Layer = new Container();
const debugOverlayLayer = new Container();
worldContainer.addChild(mapBg3Layer);
worldContainer.addChild(shadowBelowBg2Layer);
worldContainer.addChild(bikeEffectsBelowBg2Layer);
worldContainer.addChild(objectDepthBelowBg2Layer);
worldContainer.addChild(mapBg2Layer);
worldContainer.addChild(shadowBetweenBg2Bg1Layer);
worldContainer.addChild(bikeEffectsBetweenBg2Bg1Layer);
worldContainer.addChild(objectDepthBetweenBg2Bg1Layer);
worldContainer.addChild(mapBg1Layer);
worldContainer.addChild(debugOverlayLayer);
gameContainer.scale.set(RENDER_SCALE, RENDER_SCALE);
gameContainer.addChild(worldContainer);
app.stage.addChild(gameContainer);
debugOverlayLayer.visible = debugOverlayEnabled;
const overworldWindowRenderer = new OverworldWindowRenderer<LayoutTile>({
  tileSize: TILE_SIZE,
  renderSlot: renderWindowSlot,
});
let activeWindowCenterTileX = 0;
let activeWindowCenterTileY = 0;
let activeMapMutationApplier: MapMutationApplier | null = null;

let activeAvatar: PlayerAvatar = PlayerAvatar.BRENDAN;
let debugAvatarOverride: PlayerAvatar | null = null;
let playerAnimationAssets = await loadPlayerAnimationAssets({
  avatarId: avatarToAssetId(activeAvatar),
  loadJsonFromAssets,
  resolveImageUrlFromAssets,
});
let playerAnimation = new PlayerAnimationController(playerAnimationAssets);
const playerMovementActionRuntime = new PlayerMovementActionRuntime();
let visualRuntimeLastServerFrame: number | null = null;
const walkInputController = createWalkInputController({
  sendWalkInput,
  sendHeldInputState,
  isMovementLocked: () => false,
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
objectDepthBetweenBg2Bg1Layer.addChild(playerSprite);
let playerActiveActorLayer = objectDepthBetweenBg2Bg1Layer;
let activeMapTileRenderPriorityContexts: (MapTileRenderPriorityContext | undefined)[] = [];
let playerObjectRenderPriorityState: PlayerObjectRenderPriorityState = 'normal';
const bikeEffectRenderer = new BikeEffectRenderer(
  (tileX, tileY) => resolveBikeEffectLayerForPlayer(tileX, tileY),
  TILE_SIZE,
  bikeTireTrackAtlas,
  bikeTireTracksConfig.metadata,
);
const hopParticleRenderer = new HopParticleRenderer(
  (tileX, tileY) => resolveHopEffectLayerForPlayer(tileX, tileY),
  TILE_SIZE,
  {
    loadJsonFromAssets,
    resolveImageUrlFromAssets,
    loadJascPaletteHexColorsFromAssets,
  },
);
const hopShadowRenderer = new HopShadowRenderer(
  () => {
    const sampleTile = resolveCurrentPlayerLayerSampleTile();
    return resolveShadowLayerForPlayer(sampleTile.x, sampleTile.y);
  },
  TILE_SIZE,
  createHopShadowSprite,
  () => playerSprite,
);
hopShadowRenderer.setShadowSizeTemplateId(ROM_SHADOW_TEMPLATE_ID_MEDIUM);
await hopParticleRenderer.init();
const VISUAL_RUNTIME_TICK_MS = 1000 / 60;
let visualRuntimeTickAccumulatorMs = 0;

app.ticker.add(() => {
  const deltaMs = app.ticker.deltaMS;
  runMovementAndCameraPhase(deltaMs);
  runMetatileSliceRedrawEnqueuePhase();
  runTilesetAnimationPhase(deltaMs);
  runMapLayerCommitAndPresentPhase(deltaMs);
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

    for (const source of Object.values(avatar.sheet_sources)) {
      preloadUrls.push(
        await resolveImageUrlFromAssets(resolvePlayerSheetPngPathFromManifest(source.source_path)),
      );
    }
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
    syncVisualRuntimesToServerFrame(message.payload.server_frame);
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
    setRenderPositionToTile(state.playerTileX, state.playerTileY);
    activeWalkTransition = null;
    state.facing = snapshot.facing;
    state.lastAuthoritativeStepFacing = snapshot.facing;
    state.traversalState = snapshot.traversal_state;
    state.preferredBikeType = snapshot.preferred_bike_type;
    state.playerElevation = snapshot.player_elevation;
    state.authoritativeStepSpeed = snapshot.authoritative_step_speed;
    state.machSpeedStage = snapshot.mach_speed_stage;
    state.acroSubstate = snapshot.acro_substate;
    state.bikeTransition = snapshot.bike_transition;
    playerMovementActionRuntime.setAuthoritativeInput({
      traversalState: state.traversalState,
      acroSubstate: state.acroSubstate,
      bikeTransition: state.bikeTransition,
      bunnyHopCycleTick: snapshot.bunny_hop_cycle_tick,
    });
    playerAnimation.setHopArcAirborne(playerMovementActionRuntime.isHopArcAirborne());
    hopShadowRenderer.setAuthoritativeState({
      traversalState: state.traversalState,
      bikeTransition: state.bikeTransition,
      acroSubstate: state.acroSubstate ?? AcroBikeSubstate.NONE,
    });
    hopShadowRenderer.clear();
    bikeEffectRenderer.clear();
    hopParticleRenderer.clear();
    pendingHopLandingParticleEvent = null;
    await applyAuthoritativeAvatar(snapshot.avatar);
    playerAnimation.setTraversalState({
      traversalState: state.traversalState,
      machSpeedStage: state.machSpeedStage,
      acroSubstate: state.acroSubstate,
      bikeTransition: state.bikeTransition,
    });
    playerAnimation.stopMoving(snapshot.facing);
    syncVisualRuntimesToServerFrame(snapshot.server_frame);
    state.lastAckServerTick = snapshot.server_frame;
    pendingPredictedInputs.clear();
    pendingMovementModesByInputSeq.clear();
    walkInputController.reset();
    activeAcroHopAttempt = null;

    await renderMapFromSnapshot(snapshot);
    return;
  }

  if (message.type === MessageType.BIKE_RUNTIME_DELTA) {
    const delta = message.payload;
    if (delta.server_frame < state.lastAckServerTick) {
      return;
    }
    if (DEBUG_ACRO_HOP) {
      console.info('[acro-hop][authoritative] bike_runtime_delta', {
        server_frame: delta.server_frame,
        traversal_state: delta.traversal_state,
        acro_substate: delta.acro_substate,
        bike_transition: delta.bike_transition,
      });
    }
    state.traversalState = delta.traversal_state;
    state.playerElevation = delta.player_elevation;
    state.authoritativeStepSpeed = delta.authoritative_step_speed;
    state.machSpeedStage = delta.mach_speed_stage;
    state.acroSubstate = delta.acro_substate;
    state.bikeTransition = delta.bike_transition;
    playerMovementActionRuntime.setAuthoritativeInput({
      traversalState: state.traversalState,
      acroSubstate: state.acroSubstate,
      bikeTransition: state.bikeTransition,
      bunnyHopCycleTick: delta.bunny_hop_cycle_tick,
    });
    playerAnimation.setHopArcAirborne(playerMovementActionRuntime.isHopArcAirborne());
    playerAnimation.setTraversalState({
      traversalState: state.traversalState,
      machSpeedStage: state.machSpeedStage,
      acroSubstate: state.acroSubstate,
      bikeTransition: state.bikeTransition,
    });
    hopShadowRenderer.setAuthoritativeState({
      traversalState: state.traversalState,
      bikeTransition: state.bikeTransition,
      acroSubstate: state.acroSubstate ?? AcroBikeSubstate.NONE,
    });
    queueHopParticleLandingEvent({
      particleClass: delta.hop_landing_particle_class,
      serverFrame: delta.server_frame,
      hopLandingTileX: delta.hop_landing_tile_x,
      hopLandingTileY: delta.hop_landing_tile_y,
      hopLandingElevation: delta.player_elevation,
      facing: delta.facing,
      traversalState: delta.traversal_state,
      acroSubstate: delta.acro_substate,
      bikeTransition: delta.bike_transition,
    });
    flushPendingHopParticleLandingEvent();
    // BikeRuntimeDelta is change-only by design; consume it as authoritative
    // traversal + hop phase updates.
    state.lastAckServerTick = delta.server_frame;
    trackAcroHopAttemptProgress({
      source: 'bike_runtime_delta',
      serverFrame: delta.server_frame,
      traversalState: delta.traversal_state,
      acroSubstate: delta.acro_substate,
      bikeTransition: delta.bike_transition,
    });
    return;
  }

  const result = message.payload;
  if (result.server_frame < state.lastAckServerTick) {
    return;
  }
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
  const previousAuthoritativeStepFacing = state.lastAuthoritativeStepFacing;
  const previousAuthoritativeTileX = state.playerTileX;
  const previousAuthoritativeTileY = state.playerTileY;
  state.playerTileX = clampedAuthoritativeTile.x;
  state.playerTileY = clampedAuthoritativeTile.y;
  state.facing = result.facing;
  state.traversalState = result.traversal_state;
  state.preferredBikeType = result.preferred_bike_type;
  state.playerElevation = result.player_elevation;
  state.authoritativeStepSpeed = result.authoritative_step_speed;
  state.machSpeedStage = result.mach_speed_stage;
  state.acroSubstate = result.acro_substate;
  state.bikeTransition = result.bike_transition;
  playerMovementActionRuntime.setAuthoritativeInput({
    traversalState: state.traversalState,
    acroSubstate: state.acroSubstate,
    bikeTransition: state.bikeTransition,
    bunnyHopCycleTick: result.bunny_hop_cycle_tick,
  });
  playerAnimation.setHopArcAirborne(playerMovementActionRuntime.isHopArcAirborne());
  playerAnimation.setTraversalState({
    traversalState: state.traversalState,
    machSpeedStage: state.machSpeedStage,
    acroSubstate: state.acroSubstate,
    bikeTransition: state.bikeTransition,
  });
  hopShadowRenderer.setAuthoritativeState({
    traversalState: state.traversalState,
    bikeTransition: state.bikeTransition,
    acroSubstate: state.acroSubstate ?? AcroBikeSubstate.NONE,
  });
  queueHopParticleLandingEvent({
    particleClass: result.hop_landing_particle_class,
    serverFrame: result.server_frame,
    hopLandingTileX: result.hop_landing_tile_x,
    hopLandingTileY: result.hop_landing_tile_y,
    hopLandingElevation: result.player_elevation,
    facing: result.facing,
    traversalState: result.traversal_state,
    acroSubstate: result.acro_substate,
    bikeTransition: result.bike_transition,
  });
  flushPendingHopParticleLandingEvent();
  if (result.accepted) {
    // Contract: on accepted input, authoritative_pos is the server tile *after* applying that step.
    // This lets the first interpolation run immediately toward the accepted destination.
    startAuthoritativeWalkTransition(
      result.facing,
      resolveAuthoritativeStepSpeedInput(
        result.authoritative_step_speed,
        result.traversal_state,
        result.mach_speed_stage,
        acceptedMovementMode,
      ),
      resolveAuthoritativeWalkTransitionStartTile({
        traversalState: result.traversal_state,
        acroSubstate: result.acro_substate,
        previousAuthoritativeTileX,
        previousAuthoritativeTileY,
      }),
    );
    playerAnimation.startStep(
      result.facing,
      resolveAnimationStepMode({
        traversalState: result.traversal_state,
        movementMode: acceptedMovementMode,
      }),
    );
    bikeEffectRenderer.onAuthoritativeStep({
      fromX: previousAuthoritativeTileX,
      fromY: previousAuthoritativeTileY,
      previousFacing: previousAuthoritativeStepFacing,
      currentFacing: result.facing,
      traversalState: result.traversal_state,
      bikeEffectFlags: result.bike_effect_flags,
      serverFrame: result.server_frame,
    });
    state.lastAuthoritativeStepFacing = result.facing;
  } else {
    activeWalkTransition = null;
    setRenderPositionToTile(state.playerTileX, state.playerTileY);
    playerAnimation.stopMoving(result.facing);
    bikeEffectRenderer.onAuthoritativeStep({
      fromX: state.playerTileX,
      fromY: state.playerTileY,
      previousFacing: previousAuthoritativeStepFacing,
      currentFacing: result.facing,
      traversalState: result.traversal_state,
      bikeEffectFlags: result.bike_effect_flags,
      serverFrame: result.server_frame,
    });
  }
  syncVisualRuntimesToServerFrame(result.server_frame);
  state.lastAckServerTick = result.server_frame;
  if (!result.accepted) {
    console.info(
      `[walk-reject] seq=${result.input_seq} reason=${rejectionReasonLabel(result.reason)} ` +
        `traversal=${TraversalState[result.traversal_state]} ` +
        `acro=${result.acro_substate === undefined ? 'n/a' : AcroBikeSubstate[result.acro_substate]} ` +
        `bikeTransition=${result.bike_transition === undefined ? 'n/a' : BikeTransitionType[result.bike_transition]}`,
    );
  }
  if (DEBUG_ACRO_HOP) {
    console.info('[acro-hop][authoritative] walk_result', {
      server_frame: result.server_frame,
      accepted: result.accepted,
      input_seq: result.input_seq,
      traversal_state: result.traversal_state,
      acro_substate: result.acro_substate,
      bike_transition: result.bike_transition,
      rejection_reason: result.accepted ? undefined : rejectionReasonLabel(result.reason),
    });
  }
  trackAcroHopAttemptProgress({
    source: 'walk_result',
    serverFrame: result.server_frame,
    traversalState: result.traversal_state,
    acroSubstate: result.acro_substate,
    bikeTransition: result.bike_transition,
  });

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
    setRenderPositionToTile(state.playerTileX, state.playerTileY);
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

  state.mapWidth = runtimeChunk.chunk.width;
  state.mapHeight = runtimeChunk.chunk.height;

  mapBg3Layer.removeChildren();
  mapBg2Layer.removeChildren();
  mapBg1Layer.removeChildren();
  debugOverlayLayer.removeChildren();
  objectDepthBelowBg2Layer.removeChildren();
  shadowBelowBg2Layer.removeChildren();
  bikeEffectsBelowBg2Layer.removeChildren();
  shadowBetweenBg2Bg1Layer.removeChildren();
  bikeEffectsBetweenBg2Bg1Layer.removeChildren();
  objectDepthBetweenBg2Bg1Layer.removeChildren();
  bikeEffectRenderer.clear();
  hopShadowRenderer.clear();
  hopParticleRenderer.clear();
  objectDepthBetweenBg2Bg1Layer.addChild(playerSprite);
  playerActiveActorLayer = objectDepthBetweenBg2Bg1Layer;
  renderedSubtileBindings.length = 0;
  subtileBindingsByTile.clear();
  subtileBindingsByPalette.clear();
  windowSlotRenderStates.clear();
  activeTileSwaps.clear();
  activePaletteSwaps.clear();
  activePaletteBlends.clear();
  basePalettesBySource.clear();
  activePalettesBySource.clear();
  mapBg3Layer.position.set(0, 0);
  mapBg2Layer.position.set(0, 0);
  mapBg1Layer.position.set(0, 0);
  debugOverlayLayer.position.set(0, 0);

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
  activeMapTileRenderPriorityContexts = new Array(runtimeChunk.chunk.width * runtimeChunk.chunk.height);
  activeRuntimeChunk = runtimeChunk.chunk;
  activeLayout = layout;

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
  activePrimaryMetatiles = primaryMetatiles;
  activeSecondaryMetatiles = secondaryMetatiles;
  activePrimaryPalettes = primaryPalettes;
  activeSecondaryPalettes = secondaryPalettes;
  activePrimaryTileCount = primaryTileCount;

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
  for (let y = 0; y < runtimeChunk.chunk.height; y += 1) {
    for (let x = 0; x < runtimeChunk.chunk.width; x += 1) {
      const tile = runtimeChunk.chunk.tiles[y * runtimeChunk.chunk.width + x];
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
      activeMapTileRenderPriorityContexts[y * runtimeChunk.chunk.width + x] = {
        metatileGlobalId: tile.metatile_id,
        metatileLocalId: metatile.metatile_index,
        metatileLayerType: metatile.layer_type,
        behaviorId: tile.behavior_id,
        layer0SubtileMask,
        layer1SubtileMask,
        hasLayer0,
        hasLayer1,
      };
    }
  }

  syncCameraWindowFromRenderPosition();
  activeWindowCenterTileX = state.windowOriginTileX;
  activeWindowCenterTileY = state.windowOriginTileY;
  const mapWindowBacking = createMapWindowBacking({
    chunk: runtimeChunk.chunk,
    borderTiles: layout.border_tiles,
  });
  overworldWindowRenderer.initWindow(state.windowOriginTileX, state.windowOriginTileY, mapWindowBacking);
  activeMapMutationApplier = createMapMutationApplier();
  applyWindowSyncMessages(runtimeChunk.windowSync);
  overworldWindowRenderer.commitScheduledTileWrites();
  updateMapWindowPresentation();
}

function runMovementAndCameraPhase(deltaMs: number): void {
  visualRuntimeTickAccumulatorMs = Math.min(
    visualRuntimeTickAccumulatorMs + deltaMs,
    VISUAL_RUNTIME_TICK_MS * 120,
  );
  while (visualRuntimeTickAccumulatorMs >= VISUAL_RUNTIME_TICK_MS) {
    playerMovementActionRuntime.tickTicks(1);
    playerAnimation.setHopArcAirborne(playerMovementActionRuntime.isHopArcAirborne());
    playerAnimation.tickTicks(1);
    visualRuntimeTickAccumulatorMs -= VISUAL_RUNTIME_TICK_MS;
  }
  walkInputController.tick();
  tickWalkTransition(deltaMs);
  playerAnimation.applyPendingModeChanges();
  presentPlayerAnimationFrame();
}

function runMetatileSliceRedrawEnqueuePhase(): void {
  redrawMapWindowSlicesFromMovement();
}

function runTilesetAnimationPhase(deltaMs: number): void {
  tickTilesetAnimationClock(deltaMs);
  presentTilesetAnimation();
}

function runMapLayerCommitAndPresentPhase(deltaMs: number): void {
  overworldWindowRenderer.commitScheduledTileWrites();
  bikeEffectRenderer.tick(deltaMs);
  hopParticleRenderer.tick(deltaMs);
  updateMapWindowPresentation();
  positionPlayerSprite();
  updateObjectDepthSorting();
  updateCamera();
  renderHud();
}

function createMapMutationApplier(): MapMutationApplier {
  const dirtyWorldTiles = new Set<string>();
  return {
    setMetatileAt: (tileX, tileY, tile) => {
      if (!activeRuntimeChunk || tileX < 0 || tileY < 0 || tileX >= activeRuntimeChunk.width || tileY >= activeRuntimeChunk.height) {
        return false;
      }
      const tileIndex = tileY * activeRuntimeChunk.width + tileX;
      activeRuntimeChunk.tiles[tileIndex] = tile;
      dirtyWorldTiles.add(`${tileX}:${tileY}`);
      return true;
    },
    redrawDirtyIfVisible: () => {
      for (const key of dirtyWorldTiles) {
        const [rawTileX, rawTileY] = key.split(':');
        const tileX = Number(rawTileX);
        const tileY = Number(rawTileY);
        if (Number.isNaN(tileX) || Number.isNaN(tileY)) {
          continue;
        }
        const minVisibleTileX = activeWindowCenterTileX - 16;
        const maxVisibleTileX = activeWindowCenterTileX + 15;
        const minVisibleTileY = activeWindowCenterTileY - 16;
        const maxVisibleTileY = activeWindowCenterTileY + 15;
        if (tileX >= minVisibleTileX && tileX <= maxVisibleTileX && tileY >= minVisibleTileY && tileY <= maxVisibleTileY) {
          overworldWindowRenderer.redrawWorldTileAt(tileX, tileY);
        }
      }
      dirtyWorldTiles.clear();
    },
  };
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

function unregisterSubtileBindings(bindings: RenderedSubtileBinding[]): void {
  for (const binding of bindings) {
    const index = renderedSubtileBindings.indexOf(binding);
    if (index >= 0) {
      renderedSubtileBindings.splice(index, 1);
    }

    const tileKey = `${binding.pageId}:${binding.localTileIndex}`;
    const paletteKey = `${binding.sourceTileset}:${binding.paletteIndex}`;
    const tileBindings = subtileBindingsByTile.get(tileKey);
    if (tileBindings) {
      const tileIndex = tileBindings.indexOf(binding);
      if (tileIndex >= 0) {
        tileBindings.splice(tileIndex, 1);
      }
      if (tileBindings.length === 0) {
        subtileBindingsByTile.delete(tileKey);
      }
    }
    const paletteBindings = subtileBindingsByPalette.get(paletteKey);
    if (paletteBindings) {
      const paletteIndex = paletteBindings.indexOf(binding);
      if (paletteIndex >= 0) {
        paletteBindings.splice(paletteIndex, 1);
      }
      if (paletteBindings.length === 0) {
        subtileBindingsByPalette.delete(paletteKey);
      }
    }
  }
}

function renderWindowSlot({
  slotIndex,
  slotTileX,
  slotTileY,
  worldTileX,
  worldTileY,
  tile,
}: {
  slotIndex: number;
  slotTileX: number;
  slotTileY: number;
  worldTileX: number;
  worldTileY: number;
  tile: LayoutTile | undefined;
}): void {
  const existing = windowSlotRenderStates.get(slotIndex);
  if (existing) {
    for (const sprite of existing.bg3Sprites) mapBg3Layer.removeChild(sprite);
    for (const sprite of existing.bg2Sprites) mapBg2Layer.removeChild(sprite);
    for (const sprite of existing.bg1Sprites) mapBg1Layer.removeChild(sprite);
    if (existing.debugOverlay) {
      debugOverlayLayer.removeChild(existing.debugOverlay);
    }
    unregisterSubtileBindings(existing.bindings);
  }

  if (!tile || !activeTextureCache || !activeIndexedAtlasPages || !activeLayout || !activeTilesetAnimationState) {
    windowSlotRenderStates.delete(slotIndex);
    return;
  }

  const isPrimaryMetatile = tile.metatile_id < activePrimaryMetatiles.length;
  const metatile = isPrimaryMetatile
    ? activePrimaryMetatiles[tile.metatile_id]
    : activeSecondaryMetatiles[tile.metatile_id - activePrimaryMetatiles.length];
  if (!metatile) {
    windowSlotRenderStates.delete(slotIndex);
    return;
  }

  const sourcePalettes = isPrimaryMetatile ? activePrimaryPalettes : activeSecondaryPalettes;
  const sortedSubtiles = [...metatile.subtiles].sort((a, b) => a.layer_order - b.layer_order);
  const bg1Sprites: Sprite[] = [];
  const bg2Sprites: Sprite[] = [];
  const bg3Sprites: Sprite[] = [];
  const bindings: RenderedSubtileBinding[] = [];
  for (const subtile of sortedSubtiles) {
    const sourcePage = subtile.tile_index >= activePrimaryTileCount ? 1 : 0;
    const localTileIndex =
      sourcePage === 0 ? subtile.tile_index : subtile.tile_index - activePrimaryTileCount;
    if (localTileIndex < 0) {
      continue;
    }

    const sourceTilesetName =
      sourcePage === 0 ? activeLayout.primary_tileset : activeLayout.secondary_tileset;
    const subtileTexture = activeTextureCache.getTexture({
      atlasPages: activeIndexedAtlasPages,
      pageId: sourcePage,
      localTileIndex,
      sourceTileIndices: resolveFramePayloadTileIndices(activeTilesetAnimationState, sourcePage, localTileIndex),
      paletteIndex: resolveActivePaletteSwap(sourceTilesetName, subtile.palette_index),
      palettes: activePalettesBySource.get(sourceTilesetName) ?? sourcePalettes,
      animationKey: `${activeTilesetAnimationState.tickSerial}`,
    });
    if (!subtileTexture) {
      continue;
    }

    const sprite = new Sprite(subtileTexture);
    const binding: RenderedSubtileBinding = {
      sprite,
      pageId: sourcePage,
      localTileIndex,
      paletteIndex: subtile.palette_index,
      sourceTileset: sourceTilesetName,
    };
    registerSubtileBinding(binding);
    bindings.push(binding);
    const subtileX = subtile.subtile_index % 2;
    const subtileY = Math.floor(subtile.subtile_index / 2) % 2;
    sprite.x = slotTileX * TILE_SIZE + subtileX * SUBTILE_SIZE;
    sprite.y = slotTileY * TILE_SIZE + subtileY * SUBTILE_SIZE;

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
        bg3Sprites.push(sprite);
        break;
      case MapRenderStratum.BG2:
        mapBg2Layer.addChild(sprite);
        bg2Sprites.push(sprite);
        break;
      case MapRenderStratum.BG1:
        mapBg1Layer.addChild(sprite);
        bg1Sprites.push(sprite);
        break;
    }
  }

  const overlayColor = tile.collision === 0 ? 0x16a34a : 0xdc2626;
  const overlay = new Graphics()
    .rect(slotTileX * TILE_SIZE, slotTileY * TILE_SIZE, TILE_SIZE, TILE_SIZE)
    .fill({ color: overlayColor, alpha: 0.25 })
    .stroke({ color: 0x0f172a, width: 1, alpha: 0.35 });
  overlay.visible = debugOverlayEnabled;
  overlay.label = `x=${worldTileX} y=${worldTileY} collision=${tile.collision} behavior=${tile.behavior_id}`;
  debugOverlayLayer.addChild(overlay);

  windowSlotRenderStates.set(slotIndex, {
    bg1Sprites,
    bg2Sprites,
    bg3Sprites,
    debugOverlay: overlay,
    bindings,
  });
}

function redrawMapWindowSlicesFromMovement(): void {
  if (!activeRuntimeChunk) {
    return;
  }
  const deltaTileX = state.windowOriginTileX - activeWindowCenterTileX;
  const deltaTileY = state.windowOriginTileY - activeWindowCenterTileY;
  if (deltaTileX !== 0 || deltaTileY !== 0) {
    if (ENABLE_WINDOW_STREAM_RUNTIME) {
      applyWindowSyncMessages([{
        kind: 'tile_boundary_camera_delta',
        deltaTileX,
        deltaTileY,
      }]);
      return;
    }
    overworldWindowRenderer.redrawEdgeSlices(deltaTileX, deltaTileY);
    activeWindowCenterTileX = state.windowOriginTileX;
    activeWindowCenterTileY = state.windowOriginTileY;
  }
}

function applyWindowSyncMessages(messages: WindowSyncMessage[]): void {
  for (const message of messages) {
    if (message.kind === 'initial_window_center') {
      activeWindowCenterTileX = message.centerTileX;
      activeWindowCenterTileY = message.centerTileY;
      continue;
    }
    if (message.kind === 'tile_boundary_camera_delta') {
      overworldWindowRenderer.redrawEdgeSlices(message.deltaTileX, message.deltaTileY);
      activeWindowCenterTileX += message.deltaTileX;
      activeWindowCenterTileY += message.deltaTileY;
      continue;
    }
    if (message.kind === 'dirty_metatile_patch') {
      activeMapMutationApplier?.setMetatileAt(message.tileX, message.tileY, message.tile);
    }
  }
  activeMapMutationApplier?.redrawDirtyIfVisible();
}

function updateMapWindowPresentation(): void {
  if (!activeRuntimeChunk) {
    return;
  }
  const windowOffset = overworldWindowRenderer.applyWindowScroll(
    state.windowOriginTileX * TILE_SIZE + state.pixelOffsetX,
    state.windowOriginTileY * TILE_SIZE + state.pixelOffsetY + state.verticalCameraBiasPx,
  );
  mapBg3Layer.x = windowOffset.x;
  mapBg3Layer.y = windowOffset.y;
  mapBg2Layer.x = windowOffset.x;
  mapBg2Layer.y = windowOffset.y;
  mapBg1Layer.x = windowOffset.x;
  mapBg1Layer.y = windowOffset.y;
  debugOverlayLayer.x = windowOffset.x;
  debugOverlayLayer.y = windowOffset.y;
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

function resolveRuntimeMapChunk(snapshot: WorldSnapshot, layout: LayoutFile): ResolvedRuntimeMapChunk {
  try {
    const decoded = decodeWorldSnapshotMapChunk(snapshot.map_chunk);
    return {
      chunk: decoded.chunk,
      windowSync: [
        {
          kind: 'initial_window_center',
          centerTileX: state.windowOriginTileX,
          centerTileY: state.windowOriginTileY,
        },
        ...decoded.hooks.dirtyPatches,
      ],
    };
  } catch (error) {
    if (import.meta.env.DEV) {
      console.warn(
        `[world-snapshot] using local layout fallback after map_chunk decode failure map_id=${snapshot.map_id} hash=${toHex(snapshot.map_chunk_hash)} reason=${String(error)}`,
      );
      return {
        chunk: {
          width: layout.width,
          height: layout.height,
          tiles: layout.tiles,
        },
        windowSync: [{
          kind: 'initial_window_center',
          centerTileX: state.windowOriginTileX,
          centerTileY: state.windowOriginTileY,
        }],
      };
    }

    throw error;
  }
}

function decodeWorldSnapshotMapChunk(rawChunk: Uint8Array): { chunk: DecodedMapChunk; hooks: DecodedMapChunkHooks } {
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
      return {
        chunk: validateDecodedChunk({
          width: parsed.width,
          height: parsed.height,
          tiles: parsed.tiles as LayoutTile[],
        }),
        hooks: { dirtyPatches: [] },
      };
    }
  }

  if (rawChunk.length < 8) {
    throw new Error(`map_chunk payload too short: ${rawChunk.length}`);
  }

  const width = readU16(rawChunk, 0);
  const height = readU16(rawChunk, 2);
  const tileCount = readU32(rawChunk, 4);
  const payload = rawChunk.subarray(8);

  if (payload.length >= tileCount * 4) {
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
    return {
      chunk: validateDecodedChunk({ width, height, tiles }),
      hooks: decodeWindowSyncHooks(payload.subarray(tileCount * 4)),
    };
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
    return {
      chunk: validateDecodedChunk({ width, height, tiles }),
      hooks: { dirtyPatches: [] },
    };
  }

  throw new Error(
    `map_chunk payload length did not match known schemas (payload=${payload.length}, tile_count=${tileCount})`,
  );
}

function decodeWindowSyncHooks(trailer: Uint8Array): DecodedMapChunkHooks {
  if (!ENABLE_WINDOW_STREAM_RUNTIME || trailer.length === 0) {
    return { dirtyPatches: [] };
  }
  if (trailer.length < 4 || trailer[0] !== 0x57 || trailer[1] !== 0x53) {
    return { dirtyPatches: [] };
  }
  const eventCount = readU16(trailer, 2);
  const dirtyPatches: DirtyMetatilePatchSync[] = [];
  let offset = 4;
  for (let i = 0; i < eventCount; i += 1) {
    if (offset + 9 > trailer.length) {
      break;
    }
    const eventType = readU8(trailer, offset);
    const tileX = readS16(trailer, offset + 1);
    const tileY = readS16(trailer, offset + 3);
    const metatileId = readU16(trailer, offset + 5);
    const collision = readU8(trailer, offset + 7);
    const behaviorId = readU8(trailer, offset + 8);
    if (eventType === 3) {
      dirtyPatches.push({
        kind: 'dirty_metatile_patch',
        tileX,
        tileY,
        tile: {
          metatile_id: metatileId,
          collision,
          behavior_id: behaviorId,
        },
      });
    }
    offset += 9;
  }
  return { dirtyPatches };
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
    if (event.key === 'c' || event.key === 'C') {
      event.preventDefault();
      walkInputController.setVirtualBHeld(true);
      return;
    }
    if (event.key === 'b' || event.key === 'B') {
      event.preventDefault();
      if (event.repeat) {
        return;
      }
      walkInputController.toggleMovementMode();
      return;
    }
    if (event.key === 'm' || event.key === 'M') {
      event.preventDefault();
      if (event.repeat) {
        return;
      }
      sendPlayerActionInput(PlayerAction.USE_REGISTERED_BIKE);
      return;
    }
    if (event.key === 'n' || event.key === 'N') {
      event.preventDefault();
      if (event.repeat) {
        return;
      }
      sendPlayerActionInput(PlayerAction.SWAP_BIKE_TYPE);
      return;
    }
    if (
      ENABLE_DEV_DEBUG_ACTIONS &&
      (event.key === 'F6' || event.key === 'F7')
    ) {
      event.preventDefault();
      if (event.repeat) {
        return;
      }
      sendDebugTraversalInput(
        event.key === 'F6'
          ? DebugTraversalAction.TOGGLE_MOUNT
          : DebugTraversalAction.SWAP_BIKE_TYPE,
      );
      return;
    }
    walkInputController.handleKeyDown(event);
  });
  window.addEventListener('keyup', (event) => {
    if (event.key === 'c' || event.key === 'C') {
      event.preventDefault();
      walkInputController.setVirtualBHeld(false);
      return;
    }
    walkInputController.handleKeyUp(event);
  });
}

function sendDebugTraversalInput(action: DebugTraversalAction): void {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    return;
  }
  if (!ENABLE_DEV_DEBUG_ACTIONS) {
    return;
  }
  socket.send(encodeDebugTraversalInput(action));
}

function sendPlayerActionInput(action: PlayerAction): void {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    return;
  }
  socket.send(encodePlayerActionInput(action));
}

function sendWalkInput(
  direction: Direction,
  movementMode: MovementMode,
  heldButtons: number,
): void {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    return;
  }

  const inputSeq = state.lastInputSeq;
  state.lastInputSeq += 1;
  socket.send(
    encodeWalkInput(direction, movementMode, heldButtons, inputSeq, BigInt(Date.now())),
  );
  pendingMovementModesByInputSeq.set(inputSeq, movementMode);

  if (ENABLE_CLIENT_PREDICTION) {
    applyPredictedWalk(direction, inputSeq, movementMode);
  }
}

function sendHeldInputState(heldDpad: number, heldButtons: number): number | null {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    return null;
  }

  const inputSeq = state.lastHeldInputSeq;
  state.lastHeldInputSeq += 1;
  latestHeldDpad = heldDpad;
  latestHeldButtons = heldButtons;
  latestHeldInputSeq = inputSeq;
  socket.send(
    encodeHeldInputState(heldDpad, heldButtons, inputSeq, BigInt(Date.now())),
  );
  if (DEBUG_ACRO_HOP) {
    const shouldLogOutboundHeldState =
      lastLoggedOutboundHeldState === null ||
      lastLoggedOutboundHeldState.heldDpad !== heldDpad ||
      lastLoggedOutboundHeldState.heldButtons !== heldButtons;
    if (shouldLogOutboundHeldState) {
      console.info('[acro-hop][outbound] held_input_state (state-change)', {
        inputSeq,
        heldDpad,
        heldButtons,
      });
      lastLoggedOutboundHeldState = {
        heldDpad,
        heldButtons,
      };
    }
  }
  return inputSeq;
}

function latestHeldDirection(): Direction | null {
  return resolveDirectionFromHeldDpad(latestHeldDpad) ?? null;
}

function isBHeld(heldButtons: number): boolean {
  return (heldButtons & HeldButtons.B) !== 0;
}

function isStandingWheelie(
  traversalState: TraversalState,
  acroSubstate: AcroBikeSubstate | undefined,
): boolean {
  return (
    traversalState === TraversalState.ACRO_BIKE &&
    acroSubstate === AcroBikeSubstate.STANDING_WHEELIE
  );
}

function isBunnyHopTransition(
  acroSubstate: AcroBikeSubstate | undefined,
  bikeTransition: BikeTransitionType | undefined,
): boolean {
  return (
    bikeTransition === BikeTransitionType.WHEELIE_HOPPING_STANDING ||
    acroSubstate === AcroBikeSubstate.BUNNY_HOP
  );
}

function failAcroHopAttempt(
  attempt: AcroHopAttempt,
  reason: AcroHopFailureReason,
  details: {
    source: 'bike_runtime_delta' | 'walk_result';
    serverFrame: number;
    traversalState: TraversalState;
    acroSubstate: AcroBikeSubstate | undefined;
    bikeTransition: BikeTransitionType | undefined;
  },
): void {
  console.info(`[acro-hop][attempt ${attempt.id}] FAIL ${reason}`, {
    source: details.source,
    startedAtServerFrame: attempt.startedAtServerFrame,
    endedAtServerFrame: details.serverFrame,
    elapsedTicks: details.serverFrame - attempt.startedAtServerFrame,
    startedAtHeldInputSeq: attempt.startedAtHeldInputSeq,
    heldDirection: latestHeldDirection(),
    heldButtons: latestHeldButtons,
    traversal_state: details.traversalState,
    acro_substate: details.acroSubstate,
    bike_transition: details.bikeTransition,
  });
}

function trackAcroHopAttemptProgress(details: {
  source: 'bike_runtime_delta' | 'walk_result';
  serverFrame: number;
  traversalState: TraversalState;
  acroSubstate: AcroBikeSubstate | undefined;
  bikeTransition: BikeTransitionType | undefined;
}): void {
  if (!DEBUG_ACRO_HOP) {
    return;
  }

  const bHeld = isBHeld(latestHeldButtons);
  const directionHeld = latestHeldDirection() !== null;
  const standingWheelie = isStandingWheelie(details.traversalState, details.acroSubstate);
  const bunnyHopReached = isBunnyHopTransition(details.acroSubstate, details.bikeTransition);

  if (activeAcroHopAttempt) {
    lastLoggedPrereqBlockSignature = null;
    const attempt = activeAcroHopAttempt;
    if (bunnyHopReached) {
      console.info(`[acro-hop][attempt ${attempt.id}] SUCCESS`, {
        source: details.source,
        startedAtServerFrame: attempt.startedAtServerFrame,
        endedAtServerFrame: details.serverFrame,
        elapsedTicks: details.serverFrame - attempt.startedAtServerFrame,
        startedAtHeldInputSeq: attempt.startedAtHeldInputSeq,
        bike_transition: details.bikeTransition,
        acro_substate: details.acroSubstate,
      });
      activeAcroHopAttempt = null;
      return;
    }

    if (!bHeld) {
      failAcroHopAttempt(attempt, 'b_released', details);
      activeAcroHopAttempt = null;
      return;
    }

    if (directionHeld) {
      failAcroHopAttempt(attempt, 'direction_pressed', details);
      activeAcroHopAttempt = null;
      return;
    }

    if (!standingWheelie) {
      failAcroHopAttempt(attempt, 'left_acro_state', details);
      activeAcroHopAttempt = null;
      return;
    }

    if (details.serverFrame - attempt.startedAtServerFrame > 50) {
      failAcroHopAttempt(attempt, 'stale_or_missing_authoritative_progress', details);
      activeAcroHopAttempt = null;
      return;
    }

    console.info(`[acro-hop][attempt ${attempt.id}] progress`, {
      source: details.source,
      serverFrame: details.serverFrame,
      heldDirection: latestHeldDirection(),
      heldButtons: latestHeldButtons,
      traversal_state: details.traversalState,
      acro_substate: details.acroSubstate,
      bike_transition: details.bikeTransition,
    });
    return;
  }

  if (!standingWheelie || !bHeld || directionHeld) {
    if (bHeld && !directionHeld) {
      const prereqBlockSignature = `${details.source}|${details.serverFrame}|${details.traversalState}|${details.acroSubstate ?? 'none'}|${details.bikeTransition ?? 'none'}`;
      if (prereqBlockSignature !== lastLoggedPrereqBlockSignature) {
        const blockReason =
          details.traversalState !== TraversalState.ACRO_BIKE
            ? 'not_on_acro_bike'
            : details.acroSubstate !== AcroBikeSubstate.STANDING_WHEELIE
              ? 'not_in_standing_wheelie'
              : 'blocked_before_attempt_start';
        console.info('[acro-hop][attempt] prerequisites-not-met', {
          source: details.source,
          serverFrame: details.serverFrame,
          blockReason,
          heldDirection: latestHeldDirection(),
          heldButtons: latestHeldButtons,
          traversal_state: details.traversalState,
          acro_substate: details.acroSubstate,
          bike_transition: details.bikeTransition,
        });
        lastLoggedPrereqBlockSignature = prereqBlockSignature;
      }
    } else {
      lastLoggedPrereqBlockSignature = null;
    }
    return;
  }

  lastLoggedPrereqBlockSignature = null;
  const attempt: AcroHopAttempt = {
    id: nextAcroHopAttemptId,
    startedAtServerFrame: details.serverFrame,
    startedAtHeldInputSeq: latestHeldInputSeq,
  };
  nextAcroHopAttemptId += 1;
  activeAcroHopAttempt = attempt;
  console.info(`[acro-hop][attempt ${attempt.id}] START`, {
    source: details.source,
    serverFrame: details.serverFrame,
    startedAtHeldInputSeq: attempt.startedAtHeldInputSeq,
    heldDirection: latestHeldDirection(),
    heldButtons: latestHeldButtons,
    traversal_state: details.traversalState,
    acro_substate: details.acroSubstate,
    bike_transition: details.bikeTransition,
  });
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

function encodeDebugTraversalInput(action: DebugTraversalAction): Uint8Array {
  const payload = new Uint8Array(1);
  const payloadView = new DataView(payload.buffer);
  payloadView.setUint8(0, action);

  const frame = new Uint8Array(7 + payload.length);
  const view = new DataView(frame.buffer);
  view.setUint16(0, PROTOCOL_VERSION, true);
  view.setUint8(2, MessageType.DEBUG_TRAVERSAL_INPUT);
  view.setUint32(3, payload.length, true);
  frame.set(payload, 7);
  return frame;
}

function encodePlayerActionInput(action: PlayerAction): Uint8Array {
  const payload = new Uint8Array(1);
  const payloadView = new DataView(payload.buffer);
  payloadView.setUint8(0, action);

  const frame = new Uint8Array(7 + payload.length);
  const view = new DataView(frame.buffer);
  view.setUint16(0, PROTOCOL_VERSION, true);
  view.setUint8(2, MessageType.PLAYER_ACTION_INPUT);
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
    const traversalState = readU8(payload, offset) as TraversalState;
    offset += 1;
    const preferredBikeType = readU8(payload, offset) as TraversalState;
    offset += 1;
    const playerElevation = readU8(payload, offset);
    offset += 1;
    const bikeRuntimeFlags = readU8(payload, offset);
    offset += 1;
    // Optional for compatibility with older servers that don't include step speed.
    const authoritativeStepSpeed =
      bikeRuntimeFlags & 0b1000 ? (readU8(payload, offset++) as StepSpeed) : undefined;
    const machSpeedStage = bikeRuntimeFlags & 0b001 ? readU8(payload, offset++) : undefined;
    const acroSubstate =
      bikeRuntimeFlags & 0b010 ? (readU8(payload, offset++) as AcroBikeSubstate) : undefined;
    const bikeTransition =
      bikeRuntimeFlags & 0b100 ? (readU8(payload, offset++) as BikeTransitionType) : undefined;
    const bunnyHopCycleTick = bikeRuntimeFlags & 0b1_0000 ? readU8(payload, offset++) : undefined;
    const bikeEffectFlags = readU8(payload, offset);
    offset += 1;

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
        traversal_state: traversalState,
        preferred_bike_type: preferredBikeType,
        player_elevation: playerElevation,
        authoritative_step_speed: authoritativeStepSpeed,
        mach_speed_stage: machSpeedStage,
        acro_substate: acroSubstate,
        bike_transition: bikeTransition,
        bunny_hop_cycle_tick: bunnyHopCycleTick,
        bike_effect_flags: bikeEffectFlags,
      },
    };
  }

  if (messageType === MessageType.WALK_RESULT) {
    let offset = 0;
    const inputSeq = readU32(payload, offset);
    offset += 4;
    const accepted = readU8(payload, offset) === 1;
    offset += 1;
    const x = readU16(payload, offset);
    offset += 2;
    const y = readU16(payload, offset);
    offset += 2;
    const facing = readU8(payload, offset) as Direction;
    offset += 1;
    const reason = readU8(payload, offset) as RejectionReason;
    offset += 1;
    const serverFrame = readU32(payload, offset);
    offset += 4;
    const traversalState = readU8(payload, offset) as TraversalState;
    offset += 1;
    const preferredBikeType = readU8(payload, offset) as TraversalState;
    offset += 1;
    const playerElevation = readU8(payload, offset);
    offset += 1;
    const bikeRuntimeFlags = readU8(payload, offset);
    offset += 1;
    // Optional for compatibility with older servers that don't include step speed.
    const authoritativeStepSpeed =
      bikeRuntimeFlags & 0b1000 ? (readU8(payload, offset++) as StepSpeed) : undefined;
    const machSpeedStage = bikeRuntimeFlags & 0b001 ? readU8(payload, offset++) : undefined;
    const acroSubstate =
      bikeRuntimeFlags & 0b010 ? (readU8(payload, offset++) as AcroBikeSubstate) : undefined;
    const bikeTransition =
      bikeRuntimeFlags & 0b100 ? (readU8(payload, offset++) as BikeTransitionType) : undefined;
    const bunnyHopCycleTick = bikeRuntimeFlags & 0b1_0000 ? readU8(payload, offset++) : undefined;
    const bikeEffectFlags = readU8(payload, offset);
    offset += 1;
    const hasHopLandingParticleClass = readU8(payload, offset) !== 0;
    offset += 1;
    const hopLandingParticleClass = hasHopLandingParticleClass
      ? (readU8(payload, offset) as HopLandingParticleClass)
      : undefined;
    offset += 1;
    const hasHopLandingTile = offset + 1 <= payload.length && readU8(payload, offset) !== 0;
    if (offset + 1 <= payload.length) {
      offset += 1;
    }
    const hopLandingTileX =
      hasHopLandingTile && offset + 2 <= payload.length ? readU16(payload, offset) : undefined;
    if (hasHopLandingTile && offset + 2 <= payload.length) {
      offset += 2;
    }
    const hopLandingTileY =
      hasHopLandingTile && offset + 2 <= payload.length ? readU16(payload, offset) : undefined;
    if (hasHopLandingTile && offset + 2 <= payload.length) {
      offset += 2;
    }

    return {
      type: MessageType.WALK_RESULT,
      payload: {
        input_seq: inputSeq,
        accepted,
        authoritative_pos: { x, y },
        facing,
        reason,
        server_frame: serverFrame,
        traversal_state: traversalState,
        preferred_bike_type: preferredBikeType,
        player_elevation: playerElevation,
        authoritative_step_speed: authoritativeStepSpeed,
        mach_speed_stage: machSpeedStage,
        acro_substate: acroSubstate,
        bike_transition: bikeTransition,
        bunny_hop_cycle_tick: bunnyHopCycleTick,
        bike_effect_flags: bikeEffectFlags,
        hop_landing_particle_class: hopLandingParticleClass,
        hop_landing_tile_x: hopLandingTileX,
        hop_landing_tile_y: hopLandingTileY,
      },
    };
  }

  if (messageType === MessageType.BIKE_RUNTIME_DELTA) {
    let offset = 0;
    const serverFrame = readU32(payload, offset);
    offset += 4;
    const traversalState = readU8(payload, offset) as TraversalState;
    offset += 1;
    const playerElevation = readU8(payload, offset);
    offset += 1;
    const facing = readU8(payload, offset) as Direction;
    offset += 1;
    const bikeRuntimeFlags = readU8(payload, offset);
    offset += 1;
    const authoritativeStepSpeed =
      bikeRuntimeFlags & 0b1000 ? (readU8(payload, offset++) as StepSpeed) : undefined;
    const machSpeedStage = bikeRuntimeFlags & 0b001 ? readU8(payload, offset++) : undefined;
    const acroSubstate =
      bikeRuntimeFlags & 0b010 ? (readU8(payload, offset++) as AcroBikeSubstate) : undefined;
    const bikeTransition =
      bikeRuntimeFlags & 0b100 ? (readU8(payload, offset++) as BikeTransitionType) : undefined;
    const bunnyHopCycleTick = bikeRuntimeFlags & 0b1_0000 ? readU8(payload, offset++) : undefined;
    const hasHopLandingParticleClass = readU8(payload, offset) !== 0;
    offset += 1;
    const hopLandingParticleClass = hasHopLandingParticleClass
      ? (readU8(payload, offset) as HopLandingParticleClass)
      : undefined;
    offset += 1;
    const hasHopLandingTile = offset + 1 <= payload.length && readU8(payload, offset) !== 0;
    if (offset + 1 <= payload.length) {
      offset += 1;
    }
    const hopLandingTileX =
      hasHopLandingTile && offset + 2 <= payload.length ? readU16(payload, offset) : undefined;
    if (hasHopLandingTile && offset + 2 <= payload.length) {
      offset += 2;
    }
    const hopLandingTileY =
      hasHopLandingTile && offset + 2 <= payload.length ? readU16(payload, offset) : undefined;
    if (hasHopLandingTile && offset + 2 <= payload.length) {
      offset += 2;
    }
    return {
      type: MessageType.BIKE_RUNTIME_DELTA,
      payload: {
        server_frame: serverFrame,
        traversal_state: traversalState,
        player_elevation: playerElevation,
        facing,
        authoritative_step_speed: authoritativeStepSpeed,
        mach_speed_stage: machSpeedStage,
        acro_substate: acroSubstate,
        bike_transition: bikeTransition,
        bunny_hop_cycle_tick: bunnyHopCycleTick,
        hop_landing_particle_class: hopLandingParticleClass,
        hop_landing_tile_x: hopLandingTileX,
        hop_landing_tile_y: hopLandingTileY,
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
  playerAnimation.setTraversalState({
    traversalState: state.traversalState,
    machSpeedStage: state.machSpeedStage,
    acroSubstate: state.acroSubstate,
    bikeTransition: state.bikeTransition,
  });
  playerAnimation.stopMoving(state.facing);
  visualRuntimeLastServerFrame = state.lastAckServerTick;
  playerSprite.anchor.set(
    playerAnimationAssets.anchorX / playerAnimationAssets.frameWidth,
    playerAnimationAssets.anchorY / playerAnimationAssets.frameHeight,
  );
}

function syncVisualRuntimesToServerFrame(serverFrame: number): void {
  if (visualRuntimeLastServerFrame === null) {
    visualRuntimeLastServerFrame = serverFrame;
    return;
  }

  if (serverFrame <= visualRuntimeLastServerFrame) {
    return;
  }

  visualRuntimeLastServerFrame = serverFrame;
}

function readU8(raw: Uint8Array, offset: number): number {
  return new DataView(raw.buffer, raw.byteOffset, raw.byteLength).getUint8(offset);
}

function readU16(raw: Uint8Array, offset: number): number {
  return new DataView(raw.buffer, raw.byteOffset, raw.byteLength).getUint16(offset, true);
}

function readS16(raw: Uint8Array, offset: number): number {
  const value = readU16(raw, offset);
  return value >= 0x8000 ? value - 0x10000 : value;
}

function readU32(raw: Uint8Array, offset: number): number {
  return new DataView(raw.buffer, raw.byteOffset, raw.byteLength).getUint32(offset, true);
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
  setRenderPositionToTile(state.playerTileX, state.playerTileY);
  state.facing = direction;
  playerAnimation.startStep(
    direction,
    resolveAnimationStepMode({
      traversalState: state.traversalState,
      movementMode,
    }),
  );
}

function resolveAnimationStepMode({
  traversalState,
  movementMode,
}: {
  traversalState: TraversalState;
  movementMode: MovementMode;
}): 'walk' | 'run' {
  if (traversalState === TraversalState.ON_FOOT && movementMode === MovementMode.RUN) {
    return 'run';
  }
  return 'walk';
}

function queueHopParticleLandingEvent(input: HopParticleLandingQueueInput): void {
  const queuedLandingEvent = buildHopParticleLandingEvent(input);
  if (!queuedLandingEvent) {
    return;
  }
  pendingHopLandingParticleEvent = queuedLandingEvent;
  if (DEBUG_ACRO_HOP) {
    console.info('[acro-hop][landing-particle]', {
      server_frame: input.serverFrame,
      particle_class: input.particleClass,
      traversal_state: input.traversalState,
      acro_substate: input.acroSubstate,
      bike_transition: input.bikeTransition,
      useFieldEffectPriority: queuedLandingEvent.useFieldEffectPriority,
    });
  }
}

function flushPendingHopParticleLandingEvent(): void {
  if (!pendingHopLandingParticleEvent) {
    return;
  }

  hopParticleRenderer.onLandingEvent(pendingHopLandingParticleEvent);
  pendingHopLandingParticleEvent = null;
}

function resolveAuthoritativeWalkTransitionStartTile(input: {
  traversalState: TraversalState;
  acroSubstate?: AcroBikeSubstate;
  previousAuthoritativeTileX: number;
  previousAuthoritativeTileY: number;
}): WalkTransitionStart | undefined {
  if (
    input.traversalState !== TraversalState.ACRO_BIKE ||
    input.acroSubstate !== AcroBikeSubstate.BUNNY_HOP
  ) {
    return undefined;
  }
  return {
    tileX: input.previousAuthoritativeTileX,
    tileY: input.previousAuthoritativeTileY,
  };
}


function resolveMapBehaviorIdAtTile(tileX: number, tileY: number): number | undefined {
  if (tileX < 0 || tileY < 0 || tileX >= state.mapWidth || tileY >= state.mapHeight) {
    return undefined;
  }
  const tileContext = activeMapTileRenderPriorityContexts[tileY * state.mapWidth + tileX];
  return tileContext?.behaviorId;
}

function updateHopShadowSuppressionContext(): void {
  const currentBehaviorId = resolveMapBehaviorIdAtTile(state.playerTileX, state.playerTileY);
  const previousBehaviorId =
    activeWalkTransition === null
      ? currentBehaviorId
      : resolveMapBehaviorIdAtTile(activeWalkTransition.startX, activeWalkTransition.startY);

  const isPokeGrassCurrent =
    currentBehaviorId === MB_TALL_GRASS || currentBehaviorId === MB_LONG_GRASS;
  const isWaterCurrentOrPrevious =
    (currentBehaviorId !== undefined && SURFABLE_WATER_BEHAVIOR_IDS.has(currentBehaviorId)) ||
    (previousBehaviorId !== undefined && SURFABLE_WATER_BEHAVIOR_IDS.has(previousBehaviorId));
  const isReflectiveCurrentOrPrevious =
    (currentBehaviorId !== undefined && REFLECTIVE_BEHAVIOR_IDS.has(currentBehaviorId)) ||
    (previousBehaviorId !== undefined && REFLECTIVE_BEHAVIOR_IDS.has(previousBehaviorId));

  hopShadowRenderer.setSuppressionContext({
    isPokeGrass: isPokeGrassCurrent,
    isWaterSurface: isWaterCurrentOrPrevious,
    isReflectiveSurface: isReflectiveCurrentOrPrevious,
  });
}

function positionPlayerSprite(): void {
  updatePlayerActorLayer();
  const movementActionVisual = playerMovementActionRuntime.getVisualState();
  const playerPixelX = state.windowOriginTileX * TILE_SIZE + state.pixelOffsetX;
  const playerPixelY = state.windowOriginTileY * TILE_SIZE + state.pixelOffsetY;
  playerSprite.x = playerPixelX + TILE_SIZE / 2;
  playerSprite.y = playerPixelY + TILE_SIZE + movementActionVisual.yOffsetPx;
  updateHopShadowSuppressionContext();
  hopShadowRenderer.presentFrame({
    tileX: state.renderTileX,
    tileY: state.renderTileY,
    visualState: movementActionVisual,
  });
}

function createHopShadowSprite(variant: HopShadowSizeVariant): Sprite {
  const texture = hopShadowTextures.get(variant);
  if (!texture) {
    throw new Error(`hop shadow texture not preloaded for variant=${variant}`);
  }
  const sprite = new Sprite(texture);
  sprite.anchor.set(0.5, 1);
  return sprite;
}

async function preloadHopShadowTextures(): Promise<void> {
  const paletteColors = loadJascPaletteHexColorsFromAssets(HOP_SHADOW_PALETTE_PATH);
  for (const [variant, repoRelativePath] of Object.entries(HOP_SHADOW_ASSET_PATHS) as [
    HopShadowSizeVariant,
    string,
  ][]) {
    const texture = await loadIndexed4bppTextureFromAssets(repoRelativePath, paletteColors);
    hopShadowTextures.set(variant, texture);
  }
}

async function preloadBikeTireTracksConfig(): Promise<{
  atlas: BikeTireTrackAtlas;
  metadata: BikeTireTrackManifestMetadata;
}> {
  const manifest = await loadJsonFromAssets<FieldEffectsManifest>(FIELD_EFFECTS_MANIFEST_PATH);
  const bikeTireTracksEffect = resolveBikeTireTracksMetadataOrThrow(manifest);
  const bikeTireTracksTemplate = bikeTireTracksEffect.template;

  const paletteColors = loadJascPaletteHexColorsFromAssets(BIKE_TIRE_TRACKS_PALETTE_PATH);
  const sourcePath = bikeTireTracksTemplate.sources[0]?.source_path;
  if (!sourcePath) {
    throw new Error('missing bike_tire_tracks source path in manifest');
  }
  const runtimePngPath = sourcePath
    .replace(/^graphics\/field_effects\/pics\//, 'field_effects/acro_bike/pics/')
    .replace(/\.4bpp$/i, '.png');
  const baseTexture = await loadIndexed4bppTextureFromAssets(runtimePngPath, paletteColors);
  const sourceWidth = baseTexture.source.width;

  const frameTextures = bikeTireTracksTemplate.pic_table_entries.map((entry) => {
    const frameWidthPx = entry.tile_width * 8;
    const frameHeightPx = entry.tile_height * 8;
    const columns = Math.max(1, Math.floor(sourceWidth / frameWidthPx));
    const frameX = (entry.frame_index % columns) * frameWidthPx;
    const frameY = Math.floor(entry.frame_index / columns) * frameHeightPx;
    return new Texture({
      source: baseTexture.source,
      frame: new Rectangle(frameX, frameY, frameWidthPx, frameHeightPx),
    });
  });

  const variantByAnimTableIndex = new Map<number, BikeTireTrackAnimId>();
  bikeTireTracksTemplate.anim_table.anim_cmd_symbols.forEach((animSymbol, animTableIndex) => {
    const variant = resolveBikeTireTrackVariantFromAnimSymbol(animSymbol);
    if (variant) {
      variantByAnimTableIndex.set(animTableIndex, variant);
    }
  });

  const atlasEntries = BIKE_TIRE_TRACK_VARIANTS.map((variant) => {
      const animTableIndex = findAnimTableIndexForVariant(variantByAnimTableIndex, variant);
      const animSymbol = animTableIndex !== undefined
        ? bikeTireTracksTemplate.anim_table.anim_cmd_symbols[animTableIndex]
        : undefined;
      if (!animSymbol) {
        throw new Error(`missing bike tire tracks anim symbol for variant=${variant}`);
      }
      const steps = bikeTireTracksTemplate.anim_table.sequences[animSymbol];
      const firstStep = steps?.[0];
      if (!firstStep) {
        throw new Error(`missing bike tire tracks first frame for variant=${variant}`);
      }
      const texture = frameTextures[firstStep.frame];
      if (!texture) {
        throw new Error(
          `bike tire tracks frame index out of range for variant=${variant} frame=${firstStep.frame}`,
        );
      }
      return [
        variant,
        {
          texture,
          hFlip: firstStep.h_flip ?? false,
          vFlip: firstStep.v_flip ?? false,
        },
      ] as const;
    });

  return {
    atlas: Object.fromEntries(atlasEntries) as BikeTireTrackAtlas,
    metadata: {
      transition_mapping: bikeTireTracksEffect.transition_mapping,
      anim_table: bikeTireTracksTemplate.anim_table,
      fade_timing: bikeTireTracksEffect.fade_timing,
    },
  };
}

function findAnimTableIndexForVariant(
  variantByAnimTableIndex: Map<number, BikeTireTrackAnimId>,
  variant: BikeTireTrackAnimId,
): number | undefined {
  for (const [animTableIndex, mappedVariant] of variantByAnimTableIndex.entries()) {
    if (mappedVariant === variant) {
      return animTableIndex;
    }
  }
  return undefined;
}

async function loadIndexed4bppTextureFromAssets(
  repoRelativePath: string,
  paletteColors: string[],
): Promise<Texture> {
  const textureUrl = await resolveImageUrlFromAssets(repoRelativePath);
  const decoded = await decodeIndexed4bppPngFromUrl(textureUrl, Number.MAX_SAFE_INTEGER);
  const rgba = buildPlayerSheetRgba(
    decoded.width,
    decoded.height,
    decoded.tileIndices,
    paletteColors,
  );
  return bakeRgbaTexture(decoded.width, decoded.height, rgba);
}

function bakeRgbaTexture(width: number, height: number, rgba: Uint8ClampedArray<ArrayBufferLike>): Texture {
  const expectedSize = width * height * 4;
  if (rgba.length !== expectedSize) {
    throw new Error(`rgba buffer size mismatch for texture baking: expected=${expectedSize}, actual=${rgba.length}`);
  }
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('failed to acquire 2d context while baking indexed texture');
  }
  ctx.putImageData(new ImageData(new Uint8ClampedArray(rgba), width, height), 0, 0);
  const texture = Texture.from(canvas);
  texture.source.scaleMode = 'nearest';
  return texture;
}

function loadJascPaletteHexColorsFromAssets(repoRelativePath: string): string[] {
  const normalized = normalizeRepoRelative(repoRelativePath);
  const modulePath = `../../assets/${normalized}`;
  const raw = rawTextAssetContents[modulePath];
  if (!raw) {
    throw new Error(`missing palette asset at ${modulePath}`);
  }
  return parseJascPaletteToHexColors(raw);
}

function parseJascPaletteToHexColors(raw: string): string[] {
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if ((lines[0] ?? '') !== 'JASC-PAL') {
    throw new Error('unsupported palette header (expected JASC-PAL)');
  }
  const expectedColorCount = Number(lines[2] ?? 0);
  if (!Number.isInteger(expectedColorCount) || expectedColorCount <= 0) {
    throw new Error(`invalid JASC palette color count: ${lines[2] ?? ''}`);
  }
  const colorLines = lines.slice(3, 3 + expectedColorCount);
  if (colorLines.length !== expectedColorCount) {
    throw new Error(
      `JASC palette length mismatch: expected=${expectedColorCount}, actual=${colorLines.length}`,
    );
  }
  return colorLines.map((line, index) => {
    const [rRaw, gRaw, bRaw] = line.split(/\s+/);
    const r = Number(rRaw);
    const g = Number(gRaw);
    const b = Number(bRaw);
    if (![r, g, b].every((value) => Number.isInteger(value) && value >= 0 && value <= 255)) {
      throw new Error(`invalid JASC palette color at index ${index}: '${line}'`);
    }
    return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
  });
}

function updatePlayerActorLayer(): void {
  const sampleTile = resolveCurrentPlayerLayerSampleTile();
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

function resolveCurrentPlayerLayerSampleTile(): { x: number; y: number } {
  return resolvePlayerLayerSampleTile({
    playerTileX: state.playerTileX,
    playerTileY: state.playerTileY,
    activeWalkTransition,
  });
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
    return objectDepthBelowBg2Layer;
  }
  return objectDepthBetweenBg2Bg1Layer;
}

function resolveShadowLayerForPlayer(tileX: number, tileY: number): Container {
  const actorLayer = resolveActorLayerForPlayer(tileX, tileY);
  if (actorLayer === objectDepthBelowBg2Layer) {
    return shadowBelowBg2Layer;
  }
  return shadowBetweenBg2Bg1Layer;
}

function resolveHopEffectLayerForPlayer(tileX: number, tileY: number): Container {
  const actorLayer = resolveActorLayerForPlayer(tileX, tileY);
  if (actorLayer === objectDepthBelowBg2Layer) {
    return objectDepthBelowBg2Layer;
  }
  return objectDepthBetweenBg2Bg1Layer;
}

function resolveBikeEffectLayerForPlayer(tileX: number, tileY: number): Container {
  const actorLayer = resolveActorLayerForPlayer(tileX, tileY);
  if (actorLayer === objectDepthBelowBg2Layer) {
    return bikeEffectsBelowBg2Layer;
  }
  return bikeEffectsBetweenBg2Bg1Layer;
}

function updateObjectDepthSorting(): void {
  const playerDepth = computeObjectDepth({
    screenY: playerSprite.y,
    halfHeightPx: playerAnimationAssets.frameHeight * 0.5,
    elevation: state.playerElevation,
    baseSubpriority: 1,
  });
  playerSprite.zIndex = playerDepth;

  for (const sample of hopParticleRenderer.getDepthSamples()) {
    const frameAdjustment = resolveHopParticleFrameSubpriorityAdjustment(sample);
    const particleDepth = computeObjectDepth({
      screenY: sample.screenY,
      halfHeightPx: sample.halfHeightPx,
      elevation: sample.elevation,
      baseSubpriority:
        resolveHopParticleBaseSubpriority({
          facing: sample.facing,
          particleClass: sample.particleClass,
          useFieldEffectPriority: sample.useFieldEffectPriority,
        }) + frameAdjustment,
    });
    const shouldForceAbovePlayer = shouldRenderHopParticleAbovePlayer({
      facing: sample.facing,
      useFieldEffectPriority: sample.useFieldEffectPriority,
    });
    sample.sprite.zIndex = shouldForceAbovePlayer
      ? Math.max(particleDepth, playerDepth + 1)
      : particleDepth;
  }

  objectDepthBelowBg2Layer.sortChildren();
  objectDepthBetweenBg2Bg1Layer.sortChildren();
}

function resolveHopParticleFrameSubpriorityAdjustment(_sample: {
  facing: Direction;
  particleClass: HopLandingParticleClass;
  useFieldEffectPriority: boolean;
}): number {
  return 0;
}

function presentPlayerAnimationFrame(): void {
  const selection = playerAnimation.getCurrentFrame();
  playerSprite.texture = selection.texture;
  playerSprite.scale.x = selection.hFlip ? -1 : 1;
}

function updateCamera(): void {
  const centerX = state.windowOriginTileX * TILE_SIZE + state.pixelOffsetX + TILE_SIZE / 2;
  const centerY =
    state.windowOriginTileY * TILE_SIZE +
    state.pixelOffsetY +
    TILE_SIZE / 2 +
    state.verticalCameraBiasPx;
  gameContainer.x = app.screen.width / 2 - centerX * RENDER_SCALE;
  gameContainer.y = app.screen.height / 2 - centerY * RENDER_SCALE;
}

function setRenderPositionToTile(tileX: number, tileY: number): void {
  state.renderTileX = tileX;
  state.renderTileY = tileY;
  syncCameraWindowFromRenderPosition();
}

function syncCameraWindowFromRenderPosition(): void {
  const renderPixelX = Math.floor(state.renderTileX * TILE_SIZE);
  const renderPixelY = Math.floor(state.renderTileY * TILE_SIZE);
  state.windowOriginTileX = Math.floor(renderPixelX / TILE_SIZE);
  state.windowOriginTileY = Math.floor(renderPixelY / TILE_SIZE);
  state.pixelOffsetX = ((renderPixelX % TILE_SIZE) + TILE_SIZE) % TILE_SIZE;
  state.pixelOffsetY = ((renderPixelY % TILE_SIZE) + TILE_SIZE) % TILE_SIZE;
}

function startAuthoritativeWalkTransition(
  facing: Direction,
  stepSpeedInput: AuthoritativeStepSpeedInput,
  startTile?: WalkTransitionStart,
): void {
  activeWalkTransition = createAuthoritativeWalkTransition(
    state,
    facing,
    stepSpeedInput,
    startTile,
  );
}

function resolveAuthoritativeStepSpeedInput(
  authoritativeStepSpeed: StepSpeed | undefined,
  traversalState: TraversalState,
  machSpeedStage: number | undefined,
  movementMode: MovementMode,
): AuthoritativeStepSpeedInput {
  if (traversalState === TraversalState.ON_FOOT) {
    return {
      authoritativeStepSpeed,
      traversalState,
      movementMode,
    };
  }

  return {
    authoritativeStepSpeed,
    traversalState,
    machSpeedStage,
    movementMode: MovementMode.WALK,
  };
}

function tickWalkTransition(deltaMs: number): void {
  const walkTransitionState: WalkTransitionMutableState = state;
  activeWalkTransition = tickWalkTransitionState({
    activeWalkTransition,
    state: walkTransitionState,
    deltaMs,
    hasPendingAcceptedOrDispatchableStep: () =>
      walkInputController.hasPendingAcceptedOrDispatchableStep(),
    noteWalkTransitionProgress: (normalizedProgress) => {
      walkInputController.noteWalkTransitionProgress(normalizedProgress);
    },
    markWalkTransitionCompleted: () => {
      walkInputController.markWalkTransitionCompleted();
    },
    stopMoving: (direction) => {
      playerAnimation.stopMoving(direction);
    },
  });
  syncCameraWindowFromRenderPosition();
}

function renderHud(): void {
  hud.mapId && (hud.mapId.textContent = `${state.mapId}`);
  hud.tile && (hud.tile.textContent = `${state.playerTileX}, ${state.playerTileY}`);
  hud.facing && (hud.facing.textContent = Direction[state.facing]);
  hud.movementMode &&
    (hud.movementMode.textContent = MovementMode[walkInputController.getMovementMode()]);
  hud.traversalState && (hud.traversalState.textContent = TraversalState[state.traversalState]);
  hud.bikeType && (hud.bikeType.textContent = TraversalState[state.preferredBikeType]);
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

import { Application, Text } from "pixi.js";
import { V2_PROTOCOL_VERSION } from "./assetConfig";
import { OverworldCompositor } from "./compositor";
import { InputPipeline, runInputPipelineFixtures } from "./inputPipeline";
import { parseServerMessage, type AssetManifest, type RenderStateV1Message } from "./protocol";

const appElement = document.querySelector<HTMLDivElement>("#app");
if (!appElement) {
  throw new Error("Missing #app element");
}

const app = new Application();
await app.init({
  width: 640,
  height: 480,
  background: "#1a1d29",
  antialias: false
});
appElement.appendChild(app.canvas);

const compositor = new OverworldCompositor();
compositor.root.visible = false;
app.stage.addChild(compositor.root);

const banner = new Text({
  text: [
    "Emerald Rebuild V2",
    "Asset root: pending server manifest",
    "Target: 32x32 (16-metatile) buffer-wheel renderer",
    "Handshake: connecting..."
  ].join("\n"),
  style: {
    fill: "#ffffff",
    fontFamily: "monospace",
    fontSize: 14,
    lineHeight: 20
  }
});

banner.position.set(16, 64);
app.stage.addChild(banner);

const debugOverlay = new Text({
  text: "dpad=NONE run=NOT_MOVING transition=T_NOT_MOVING step=0",
  style: {
    fill: "#00ff7f",
    fontFamily: "monospace",
    fontSize: 11,
    lineHeight: 14
  }
});
debugOverlay.position.set(308, 226);
debugOverlay.visible = false;
app.stage.addChild(debugOverlay);

const playButton = document.createElement("button");
playButton.textContent = "Play";
playButton.disabled = true;
playButton.style.position = "absolute";
playButton.style.left = "16px";
playButton.style.top = "16px";
playButton.style.padding = "8px 16px";
playButton.style.fontFamily = "monospace";
playButton.style.fontSize = "16px";
playButton.style.cursor = "pointer";
appElement.style.position = "relative";
appElement.appendChild(playButton);

let latestRenderState: RenderStateV1Message | null = null;
let assetManifest: AssetManifest | null = null;
let launched = false;
let latestResolvedDirection = "NONE";

runInputPipelineFixtures();
const inputPipeline = new InputPipeline();

playButton.addEventListener("click", async () => {
  if (!latestRenderState) {
    return;
  }
  try {
    launched = true;
    playButton.style.display = "none";
    banner.visible = false;
    compositor.root.visible = true;
    compositor.setDebugMarkerVisible(true);
    debugOverlay.visible = true;
    if (!assetManifest) {
      throw new Error("Missing asset manifest from server hello");
    }
    await compositor.fullRedraw(latestRenderState, assetManifest);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error("[v2-client] initial redraw failed", error);
    launched = false;
    playButton.style.display = "block";
    banner.visible = true;
    compositor.root.visible = false;
    compositor.setDebugMarkerVisible(false);
    banner.text = `Render error: ${reason}`;
  }
});

const ws = new WebSocket(
  `ws://127.0.0.1:4100/ws?clientVersion=v2-client-proto-${V2_PROTOCOL_VERSION}`
);

window.addEventListener("keydown", (event) => {
  inputPipeline.handleKeyDown(event.code);
});

window.addEventListener("keyup", (event) => {
  inputPipeline.handleKeyUp(event.code);
});

let inputInterval: number | null = null;
ws.addEventListener("open", () => {
  inputInterval = window.setInterval(() => {
    if (ws.readyState !== WebSocket.OPEN) {
      return;
    }
    const frame = inputPipeline.synthesizeFrame();
    latestResolvedDirection = frame.resolvedDirection;
    ws.send(
      JSON.stringify({
        type: "input_frame",
        heldKeys: frame.heldKeys,
        newKeys: frame.newKeys
      })
    );
    refreshDebugOverlay();
  }, 1000 / 60);
});

ws.addEventListener("message", async (event) => {
  const raw = String(event.data);
  const message = parseServerMessage(raw, {
    requirePlayerRenderProxy: debugOverlay.visible
  });
  if (!message) {
    if (!reportManifestParseError(raw)) {
      banner.text = `Invalid message: ${raw}`;
    }
    return;
  }

  if (message.type === "server_hello") {
    if (!message.assetManifest.assetBaseUrl || !message.assetManifest.assetVersion || !message.assetManifest.tilesetPairId) {
      const reason =
        "Server hello missing required asset manifest fields: assetBaseUrl, assetVersion, and tilesetPairId are required.";
      console.error(`[v2-client] ${reason}`, message);
      banner.text = reason;
      return;
    }
    assetManifest = message.assetManifest;
    banner.text = [
      "Emerald Rebuild V2",
      `Asset root: ${message.assetManifest.assetBaseUrl}`,
      `Asset version: ${message.assetManifest.assetVersion}`,
      "Target: 32x32 (16-metatile) buffer-wheel renderer",
      `Handshake: protocol=${message.protocolVersion} authority=${message.serverAuthority}`,
      "Press Play when render state arrives"
    ].join("\n");
    return;
  }

  latestRenderState = message;
  playButton.disabled = false;

  if (!assetManifest) {
    const reason =
      "Render state arrived before a valid asset manifest. Expected server_hello with assetBaseUrl, assetVersion, and tilesetPairId.";
    console.error(`[v2-client] ${reason}`, message);
    banner.text = reason;
    return;
  }

  if (!launched) {
    banner.text = [
      "Emerald Rebuild V2",
      `Map ready: ${message.mapId}`,
      `Tileset pair: ${message.tilesetPairId}`,
      "Press Play to enter world"
    ].join("\n");
    return;
  }

  try {
    await compositor.fullRedraw(message, assetManifest);
    refreshDebugOverlay();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error("[v2-client] redraw failed", error);
    banner.visible = true;
    banner.text = `Render error: ${reason}`;
  }
});

ws.addEventListener("error", () => {
  banner.text = [
    "Emerald Rebuild V2",
    "Asset root: pending server manifest",
    "Target: 32x32 (16-metatile) buffer-wheel renderer",
    "Handshake: unable to connect to ws://127.0.0.1:4100/ws"
  ].join("\n");
});

ws.addEventListener("close", () => {
  if (inputInterval !== null) {
    window.clearInterval(inputInterval);
    inputInterval = null;
  }
});

function refreshDebugOverlay(): void {
  if (!latestRenderState || !debugOverlay.visible) {
    return;
  }
  debugOverlay.text = [
    `dpad=${latestResolvedDirection}`,
    `run=${latestRenderState.movement.runningState}`,
    `transition=${latestRenderState.movement.tileTransitionState}`,
    `step=${latestRenderState.movement.stepTimer}`
  ].join(" ");
}

function reportManifestParseError(raw: string): boolean {
  try {
    const parsed = JSON.parse(raw) as { type?: string };
    if (parsed?.type === "server_hello") {
      const reason =
        "Server hello rejected: missing required asset manifest fields (assetBaseUrl, assetVersion, tilesetPairId).";
      console.error(`[v2-client] ${reason}`, parsed);
      banner.text = reason;
      return true;
    }
  } catch {
    // intentionally ignore parse failures; generic invalid message text is already set by caller.
  }
  return false;
}

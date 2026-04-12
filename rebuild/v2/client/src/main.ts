import { Application, Text } from "pixi.js";
import { V2_PROTOCOL_VERSION } from "./assetConfig";
import {
  OverworldCompositor,
  VISIBLE_HEIGHT_PX,
  VISIBLE_METATILES_H,
  VISIBLE_METATILES_W,
  VISIBLE_WIDTH_PX
} from "./compositor";
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
    `Viewport: ${VISIBLE_WIDTH_PX}x${VISIBLE_HEIGHT_PX} (${VISIBLE_METATILES_W}x${VISIBLE_METATILES_H} metatiles)`,
    "Backing: 32x32 subtiles (16x16 metatiles) buffer-wheel renderer",
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

playButton.addEventListener("click", async () => {
  if (!latestRenderState) {
    return;
  }
  try {
    launched = true;
    playButton.style.display = "none";
    banner.visible = false;
    compositor.root.visible = true;
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
    banner.text = `Render error: ${reason}`;
  }
});

const ws = new WebSocket(
  `ws://127.0.0.1:4100/ws?clientVersion=v2-client-proto-${V2_PROTOCOL_VERSION}`
);

ws.addEventListener("message", async (event) => {
  const raw = String(event.data);
  const message = parseServerMessage(raw);
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
      `Viewport: ${VISIBLE_WIDTH_PX}x${VISIBLE_HEIGHT_PX} (${VISIBLE_METATILES_W}x${VISIBLE_METATILES_H} metatiles)`,
      "Backing: 32x32 subtiles (16x16 metatiles) buffer-wheel renderer",
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
    `Viewport: ${VISIBLE_WIDTH_PX}x${VISIBLE_HEIGHT_PX} (${VISIBLE_METATILES_W}x${VISIBLE_METATILES_H} metatiles)`,
    "Backing: 32x32 subtiles (16x16 metatiles) buffer-wheel renderer",
    "Handshake: unable to connect to ws://127.0.0.1:4100/ws"
  ].join("\n");
});

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

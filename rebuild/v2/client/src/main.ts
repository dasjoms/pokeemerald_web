import { Application, Text } from "pixi.js";
import { DEFAULT_DEV_ASSET_ROOT, V2_PROTOCOL_VERSION } from "./assetConfig";
import { OverworldCompositor } from "./compositor";
import { parseServerMessage, type RenderStateV1Message } from "./protocol";

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

const assetRoot = DEFAULT_DEV_ASSET_ROOT;

const banner = new Text({
  text: [
    "Emerald Rebuild V2",
    `Asset root: ${assetRoot}`,
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
    await compositor.fullRedraw(latestRenderState, assetRoot);
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
    banner.text = `Invalid message: ${raw}`;
    return;
  }

  if (message.type === "server_hello") {
    banner.text = [
      "Emerald Rebuild V2",
      `Asset root: ${assetRoot}`,
      "Target: 32x32 (16-metatile) buffer-wheel renderer",
      `Handshake: protocol=${message.protocolVersion} authority=${message.serverAuthority}`,
      "Press Play when render state arrives"
    ].join("\n");
    return;
  }

  latestRenderState = message;
  playButton.disabled = false;

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
    await compositor.fullRedraw(message, assetRoot);
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
    `Asset root: ${assetRoot}`,
    "Target: 32x32 (16-metatile) buffer-wheel renderer",
    "Handshake: unable to connect to ws://127.0.0.1:4100/ws"
  ].join("\n");
});

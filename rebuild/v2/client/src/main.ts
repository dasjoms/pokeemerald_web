import { Application, Text } from "pixi.js";
import { DEFAULT_DEV_ASSET_ROOT, V2_PROTOCOL_VERSION } from "./assetConfig";
import { OverworldCompositor } from "./compositor";
import { parseServerMessage } from "./protocol";

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
app.stage.addChild(compositor.root);

const banner = new Text({
  text: [
    "Emerald Rebuild V2",
    `Asset root (dev default): ${DEFAULT_DEV_ASSET_ROOT}`,
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

banner.position.set(16, 340);
app.stage.addChild(banner);

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
      `Asset root (dev default): ${DEFAULT_DEV_ASSET_ROOT}`,
      "Target: 32x32 (16-metatile) buffer-wheel renderer",
      `Handshake: protocol=${message.protocolVersion} authority=${message.serverAuthority}`
    ].join("\n");
    return;
  }

  try {
    await compositor.fullRedraw(message, DEFAULT_DEV_ASSET_ROOT);
    banner.text = [
      "Emerald Rebuild V2",
      `Map: ${message.mapId}`,
      `Tileset pair: ${message.tilesetPairId}`,
      `Camera runtime: (${message.camera.runtimeX}, ${message.camera.runtimeY})`,
      `Window origin: (${message.window.originRuntimeX}, ${message.window.originRuntimeY})`
    ].join("\n");
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    banner.text = `Render error: ${reason}`;
  }
});

ws.addEventListener("error", () => {
  banner.text = [
    "Emerald Rebuild V2",
    `Asset root (dev default): ${DEFAULT_DEV_ASSET_ROOT}`,
    "Target: 32x32 (16-metatile) buffer-wheel renderer",
    "Handshake: unable to connect to ws://127.0.0.1:4100/ws"
  ].join("\n");
});

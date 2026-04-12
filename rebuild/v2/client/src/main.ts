import { Application, Text } from "pixi.js";
import { DEFAULT_DEV_ASSET_ROOT, V2_PROTOCOL_VERSION } from "./assetConfig";

const appElement = document.querySelector<HTMLDivElement>("#app");
if (!appElement) {
  throw new Error("Missing #app element");
}

const app = new Application();
await app.init({
  width: 640,
  height: 480,
  background: "#1a1d29"
});
appElement.appendChild(app.canvas);

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
    fontSize: 16,
    lineHeight: 24
  }
});

banner.position.set(16, 16);
app.stage.addChild(banner);

const ws = new WebSocket(
  `ws://127.0.0.1:4100/ws?clientVersion=v2-client-proto-${V2_PROTOCOL_VERSION}`
);

ws.addEventListener("message", (event) => {
  banner.text = [
    "Emerald Rebuild V2",
    `Asset root (dev default): ${DEFAULT_DEV_ASSET_ROOT}`,
    "Target: 32x32 (16-metatile) buffer-wheel renderer",
    `Handshake: ${String(event.data)}`
  ].join("\n");
});

ws.addEventListener("error", () => {
  banner.text = [
    "Emerald Rebuild V2",
    `Asset root (dev default): ${DEFAULT_DEV_ASSET_ROOT}`,
    "Target: 32x32 (16-metatile) buffer-wheel renderer",
    "Handshake: unable to connect to ws://127.0.0.1:4100/ws"
  ].join("\n");
});

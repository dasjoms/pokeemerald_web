import { existsSync } from "node:fs";
import path from "node:path";

const rawAssetRoot = process.env.V2_ASSET_ROOT ?? "../../assets";
const assetRoot = path.resolve(process.cwd(), rawAssetRoot);
const required = ["layouts", "render", "players"];

if (!existsSync(assetRoot)) {
  console.error(
    `[v2-client] Missing asset root: ${assetRoot}. Set V2_ASSET_ROOT or ensure rebuild/assets exists.`
  );
  process.exit(1);
}

for (const subdir of required) {
  const full = path.join(assetRoot, subdir);
  if (!existsSync(full)) {
    console.error(
      `[v2-client] Missing required asset directory: ${full} (asset root: ${assetRoot}).`
    );
    process.exit(1);
  }
}

console.log(`[v2-client] Asset root OK: ${assetRoot}`);

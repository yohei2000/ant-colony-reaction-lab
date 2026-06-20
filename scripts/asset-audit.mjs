import { readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, join } from "node:path";

const ASSET_EXTENSIONS = new Set([".glb", ".gltf", ".fbx", ".obj", ".png", ".jpg", ".jpeg", ".hdr", ".ktx2", ".webp"]);
const roots = ["assets", "public", "src"];
const assets = [];

async function walk(root) {
  if (!existsSync(root)) return;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      await walk(path);
      continue;
    }
    const extension = extname(entry.name).toLowerCase();
    if (!ASSET_EXTENSIONS.has(extension)) continue;
    const info = await stat(path);
    assets.push({ path, extension, bytes: info.size });
  }
}

for (const root of roots) await walk(root);

const totalBytes = assets.reduce((sum, asset) => sum + asset.bytes, 0);
const report = {
  count: assets.length,
  totalBytes,
  assets,
  notes: [
    "No binary runtime assets are required today; the scene is procedural.",
    "When GLB assets are introduced, prefer Meshopt first, Draco only for bandwidth-heavy static meshes.",
    "When color textures are introduced, convert large color maps to KTX2/BasisU and keep normal/roughness/metalness linear.",
  ],
};

console.log(JSON.stringify(report, null, 2));

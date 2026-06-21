import { readdir, stat } from 'node:fs/promises';
import { join, extname } from 'node:path';

const ROOTS = ['src', 'public', 'dist'];
const ASSET_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.gif',
  '.svg',
  '.glb',
  '.gltf',
  '.mp3',
  '.ogg',
  '.wav'
]);
const MAX_ASSET_BYTES = 512 * 1024;

const findings = [];

for (const root of ROOTS) {
  await scan(root).catch(() => undefined);
}

if (findings.length > 0) {
  console.error('Asset audit failed:');
  for (const finding of findings) {
    console.error(`- ${finding.path}: ${Math.round(finding.size / 1024)} KiB`);
  }
  process.exit(1);
}

console.log('Asset audit passed: no oversized raster/model/audio assets found.');

async function scan(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      await scan(path);
      continue;
    }
    if (!ASSET_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
      continue;
    }
    const info = await stat(path);
    if (info.size > MAX_ASSET_BYTES) {
      findings.push({ path, size: info.size });
    }
  }
}

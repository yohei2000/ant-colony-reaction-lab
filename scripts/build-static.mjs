import { cp, mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const outDir = resolve("dist");
await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

for (const entry of ["index.html", "styles.css", ".nojekyll", "src"]) {
  if (!existsSync(entry)) throw new Error(`Missing build input: ${entry}`);
  await cp(resolve(entry), resolve(outDir, entry), { recursive: true });
}

console.log(`Built static site: ${outDir}`);

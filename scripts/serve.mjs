import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

export function createStaticServer({ root = process.cwd(), port = 0 } = {}) {
  const siteRoot = resolve(root);
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const pathname = decodeURIComponent(url.pathname);
      const requested = pathname === "/" ? "index.html" : pathname.slice(1);
      const target = normalize(resolve(join(siteRoot, requested)));
      if (target !== siteRoot && !target.startsWith(`${siteRoot}${sep}`)) {
        response.writeHead(403);
        response.end("Forbidden");
        return;
      }
      const filePath = existsSync(target) ? target : resolve(siteRoot, "index.html");
      const body = await readFile(filePath);
      response.writeHead(200, {
        "Content-Type": MIME_TYPES[extname(filePath)] ?? "application/octet-stream",
        "Cache-Control": "no-store",
      });
      response.end(body);
    } catch (error) {
      response.writeHead(500);
      response.end(String(error));
    }
  });

  return new Promise((resolveServer) => {
    server.listen(port, "127.0.0.1", () => resolveServer(server));
  });
}

if (import.meta.url === pathToFileURL(fileURLToPath(import.meta.url)).href && process.argv[1] === fileURLToPath(import.meta.url)) {
  const requestedPort = Number(process.env.PORT || 5173);
  const server = await createStaticServer({ port: requestedPort });
  const address = server.address();
  console.log(`http://127.0.0.1:${address.port}/`);
}

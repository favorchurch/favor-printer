// Serves dist/renderer for visual checks: `pnpm build && pnpm preview:renderer`,
// then open http://localhost:4173/index.html. Static files only, loopback only,
// no dependencies.

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const DEFAULT_PORT = 4173;

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

/** Maps a request URL to a file inside root, or null when it would leave root. */
export function resolveRequestPath(root, requestUrl) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(requestUrl, "http://localhost").pathname);
  } catch {
    return null;
  }
  if (pathname.includes("\0")) return null;
  const resolved = path.resolve(root, `.${pathname}`);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) return null;
  return resolved;
}

export function createPreviewServer({ root }) {
  const absoluteRoot = path.resolve(root);
  return http.createServer(async (req, res) => {
    const reply = (status, body = "", headers = {}) => {
      res.writeHead(status, { "Cache-Control": "no-store", ...headers });
      res.end(req.method === "HEAD" ? undefined : body);
    };
    if (req.method !== "GET" && req.method !== "HEAD") return reply(405, "Method not allowed", { Allow: "GET, HEAD" });

    let file = resolveRequestPath(absoluteRoot, req.url ?? "/");
    if (!file) return reply(404, "Not found");
    try {
      let info = await stat(file);
      if (info.isDirectory()) {
        file = path.join(file, "index.html");
        info = await stat(file);
      }
      res.writeHead(200, {
        "Content-Type": MIME[path.extname(file)] ?? "application/octet-stream",
        "Content-Length": info.size,
        "Cache-Control": "no-store",
      });
      if (req.method === "HEAD") return res.end();
      createReadStream(file).on("error", () => res.destroy()).pipe(res);
    } catch {
      reply(404, "Not found");
    }
  });
}

export function startPreviewServer({ root, port = DEFAULT_PORT, host = "127.0.0.1" }) {
  const server = createPreviewServer({ root });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve(server));
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = path.join(repoRoot, "dist", "renderer");
  try {
    await stat(path.join(root, "index.html"));
  } catch {
    console.error("dist/renderer/index.html not found. Run `pnpm build` first.");
    process.exit(1);
  }
  const port = Number(process.env.PORT ?? DEFAULT_PORT);
  startPreviewServer({ root, port }).then(
    () => console.log(`Serving dist/renderer at http://localhost:${port}/index.html`),
    (error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    },
  );
}

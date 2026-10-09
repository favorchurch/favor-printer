#!/usr/bin/env node
// Captures legible screenshots for every state in FIXTURE_NAMES.
//
// Usage:
//   node scripts/capture-screenshots.mjs [--out-dir=docs/verification/screenshots]

import { spawn } from "node:child_process";
import { access, mkdir, readFile, stat } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const FIXTURE_NAMES = [
  "default",
  "no-printer",
  "several-printers",
  "queue-fallback",
  "enter-code",
  "invalid-code",
  "connected",
  "test-print-confirm",
  "revoked",
  "legacy-relay",
  "legacy-confirm",
  "legacy-failed",
];

const CHROME_PATHS = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  "google-chrome",
  "google-chrome-stable",
  "chromium",
  "chromium-browser",
];

export async function findChromeBinary() {
  if (process.env.CHROME_BIN) {
    try {
      await access(process.env.CHROME_BIN);
      return process.env.CHROME_BIN;
    } catch {
      // not found at specified path
    }
  }

  for (const candidate of CHROME_PATHS) {
    if (candidate.startsWith("/")) {
      try {
        await access(candidate);
        return candidate;
      } catch {
        continue;
      }
    }
  }

  return "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
}

/**
 * Creates an internal preview server serving dist/renderer, injecting a small
 * clean style override to hide the preview-only fixture bar and ensure the
 * setup window screen maintains its standard 640px height for clear, clean screenshots.
 */
export function createCaptureServer({ root }) {
  const absoluteRoot = path.resolve(root);

  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");

    if (url.pathname === "/styles.css") {
      try {
        let css = await readFile(path.join(absoluteRoot, "styles.css"), "utf8");
        css += `
/* Injected by capture-screenshots.mjs for clean production-like captures */
.fixture-bar { display: none !important; }
body[data-preview] .screen { min-height: 640px !important; }
`;
        res.writeHead(200, {
          "Content-Type": "text/css; charset=utf-8",
          "Cache-Control": "no-store",
        });
        res.end(css);
        return;
      } catch {
        res.writeHead(404);
        res.end("Not found");
        return;
      }
    }

    if (url.pathname === "/" || url.pathname === "/index.html") {
      try {
        const html = await readFile(path.join(absoluteRoot, "index.html"), "utf8");
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
        });
        res.end(html);
        return;
      } catch {
        res.writeHead(404);
        res.end("Not found");
        return;
      }
    }

    const filePath = path.resolve(absoluteRoot, `.${url.pathname}`);
    if (!filePath.startsWith(absoluteRoot + path.sep)) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }

    try {
      const content = await readFile(filePath);
      const ext = path.extname(filePath);
      const mime =
        ext === ".js"
          ? "text/javascript; charset=utf-8"
          : ext === ".json"
            ? "application/json; charset=utf-8"
            : ext === ".svg"
              ? "image/svg+xml"
              : ext === ".png"
                ? "image/png"
                : "application/octet-stream";
      res.writeHead(200, {
        "Content-Type": mime,
        "Cache-Control": "no-store",
      });
      res.end(content);
    } catch {
      res.writeHead(404);
      res.end("Not found");
    }
  });
}

export function startCaptureServer({ root, port = 0, host = "127.0.0.1" }) {
  const server = createCaptureServer({ root });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve(server));
  });
}

export async function captureScreenshot({ chromePath, url, outputFile, width = 520, height = 640 }) {
  return new Promise((resolve, reject) => {
    const args = [
      "--headless=new",
      "--disable-gpu",
      `--screenshot=${outputFile}`,
      `--window-size=${width},${height}`,
      "--force-device-scale-factor=2",
      "--hide-scrollbars",
      url,
    ];

    const child = spawn(chromePath, args, { stdio: "ignore" });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Chrome exited with code ${code} while capturing ${url}`));
      }
    });
  });
}

export async function captureAllScreenshots(options = {}) {
  const outDir = options.outDir ?? path.join(repoRoot, "docs", "verification", "screenshots");
  const rendererRoot = options.rendererRoot ?? path.join(repoRoot, "dist", "renderer");
  const fixtureList = options.fixtures ?? FIXTURE_NAMES;

  await stat(path.join(rendererRoot, "index.html")).catch(() => {
    throw new Error(`Renderer bundle not found at ${rendererRoot}. Run \`pnpm build\` first.`);
  });

  const chromePath = await findChromeBinary();
  await mkdir(outDir, { recursive: true });

  const server = await startCaptureServer({ root: rendererRoot });
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 4173;

  const results = [];

  try {
    for (const name of fixtureList) {
      const url = `http://127.0.0.1:${port}/index.html?state=${encodeURIComponent(name)}`;
      const outputFile = path.join(outDir, `${name}.png`);

      await captureScreenshot({ chromePath, url, outputFile });
      const fileStat = await stat(outputFile);

      results.push({
        fixture: name,
        path: outputFile,
        size: fileStat.size,
      });

      if (options.onProgress) {
        options.onProgress(name, fileStat.size);
      }
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }

  return results;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let customOutDir;
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith("--out-dir=")) {
      customOutDir = path.resolve(arg.slice("--out-dir=".length));
    }
  }

  const outDir = customOutDir ?? path.join(repoRoot, "docs", "verification", "screenshots");
  console.log(`Capturing ${FIXTURE_NAMES.length} screenshots into ${outDir}...`);

  captureAllScreenshots({
    outDir,
    onProgress: (name, bytes) => {
      console.log(`  ✓ ${name}.png (${Math.round(bytes / 1024)} KB)`);
    },
  })
    .then((results) => {
      console.log(`Successfully captured ${results.length} screenshots.`);
      process.exit(0);
    })
    .catch((err) => {
      console.error("Screenshot capture failed:", err);
      process.exit(1);
    });
}

// Bundles everything the packaged app runs into dist/:
//   dist/main.js       app/src/main/index.ts      (optional until the app shell lands)
//   dist/preload.js    app/src/preload/index.ts   (optional until the app shell lands)
//   dist/relay.js      vendor/relay/embedded.ts   (required: the vendored relay child entry)
//   dist/renderer/     app/src/renderer/          (optional until the app shell lands)
//
// Optional entries that are absent are skipped and reported, so the scaffold
// builds before the app shell exists. A missing relay entry always fails.

import { cp, mkdir, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build as esbuild } from "esbuild";

// Electron 44 ships Node 24 and Chromium 152.
const NODE_TARGET = "node24";
const CHROME_TARGET = "chrome152";

export const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Entries that run in Node (Electron main, preload, relay child). */
const NODE_ENTRIES = [
  { name: "main", entry: "app/src/main/index.ts", out: "main.js", required: false },
  { name: "preload", entry: "app/src/preload/index.ts", out: "preload.js", required: false },
  { name: "relay", entry: "vendor/relay/embedded.ts", out: "relay.js", required: true },
];

const RENDERER_DIR = "app/src/renderer";

const exists = (file) =>
  stat(file).then(
    () => true,
    () => false,
  );

async function listFiles(dir) {
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await listFiles(full)));
    else found.push(full);
  }
  return found;
}

async function buildNodeEntry(root, outDir, { entry, out }) {
  await esbuild({
    absWorkingDir: root,
    entryPoints: [entry],
    outfile: path.join(outDir, out),
    bundle: true,
    platform: "node",
    format: "cjs",
    target: NODE_TARGET,
    external: ["electron"],
    sourcemap: true,
    logLevel: "warning",
  });
}

/**
 * The renderer is plain static files plus one script. Everything in the renderer
 * directory that is not TypeScript (index.html, css, images) is copied as is, and
 * index.ts is bundled to index.js next to index.html.
 */
async function buildRenderer(root, outDir) {
  const srcDir = path.join(root, RENDERER_DIR);
  const dest = path.join(outDir, "renderer");
  await mkdir(dest, { recursive: true });
  for (const file of await listFiles(srcDir)) {
    if (/\.(ts|tsx)$/.test(file)) continue;
    const target = path.join(dest, path.relative(srcDir, file));
    await mkdir(path.dirname(target), { recursive: true });
    await cp(file, target);
  }
  const script = path.join(srcDir, "index.ts");
  if (await exists(script)) {
    await esbuild({
      absWorkingDir: root,
      entryPoints: [script],
      outfile: path.join(dest, "index.js"),
      bundle: true,
      platform: "browser",
      format: "iife",
      target: CHROME_TARGET,
      define: { "process.env.NODE_ENV": '"production"' },
      sourcemap: true,
      logLevel: "warning",
    });
  }
}

/** @returns {Promise<{ built: string[], skipped: string[] }>} */
export async function buildApp({ root = defaultRoot, outDir = path.join(root, "dist"), log = () => {} } = {}) {
  const built = [];
  const skipped = [];

  // Fail before touching dist/ when the one required input is missing.
  for (const target of NODE_ENTRIES) {
    if (target.required && !(await exists(path.join(root, target.entry)))) {
      throw new Error(`${target.entry} is missing: cannot build ${target.out}. Sync vendor/relay from the RSVP repository.`);
    }
  }

  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  for (const target of NODE_ENTRIES) {
    if (await exists(path.join(root, target.entry))) {
      await buildNodeEntry(root, outDir, target);
      built.push(target.name);
      log(`built ${target.name}: ${target.entry} -> dist/${target.out}`);
    } else {
      skipped.push(target.name);
      log(`skipped ${target.name}: ${target.entry} does not exist yet`);
    }
  }

  if (await exists(path.join(root, RENDERER_DIR, "index.html"))) {
    await buildRenderer(root, outDir);
    built.push("renderer");
    log(`built renderer: ${RENDERER_DIR} -> dist/renderer`);
  } else {
    skipped.push("renderer");
    log(`skipped renderer: ${RENDERER_DIR}/index.html does not exist yet`);
  }

  return { built, skipped };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  buildApp({ log: (line) => console.log(line) }).catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}

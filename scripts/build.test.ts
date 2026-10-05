import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// @ts-expect-error plain .mjs script without type declarations
import { buildApp } from "./build.mjs";
// @ts-expect-error plain .mjs script without type declarations
import { resolveRequestPath, startPreviewServer } from "./preview-renderer.mjs";

type BuildResult = { built: string[]; skipped: string[] };
const build = buildApp as (options: { root: string }) => Promise<BuildResult>;

let root: string;

async function write(relative: string, text: string) {
  const file = path.join(root, relative);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text);
}

const exists = (relative: string) =>
  stat(path.join(root, relative)).then(
    () => true,
    () => false,
  );

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "favor-printer-build-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("buildApp", () => {
  it("bundles the relay and skips the app entries that do not exist yet", async () => {
    await write("vendor/relay/embedded.ts", `import { value } from "./index";\nconsole.log(value);\n`);
    await write("vendor/relay/index.ts", `export const value: string = "relay-ok";\n`);

    const result = await build({ root });

    expect(result).toEqual({ built: ["relay"], skipped: ["main", "preload", "renderer"] });
    expect(await exists("dist/relay.js")).toBe(true);
    expect(await exists("dist/main.js")).toBe(false);
    expect(await exists("dist/preload.js")).toBe(false);
    expect(await exists("dist/renderer")).toBe(false);
  });

  it("emits a single self-contained CommonJS relay that runs under plain node", async () => {
    await write("vendor/relay/embedded.ts", `import { value } from "./index";\nconsole.log(value);\n`);
    await write("vendor/relay/index.ts", `export const value: string = "relay-ok";\n`);

    await build({ root });

    const output = execFileSync(process.execPath, [path.join(root, "dist/relay.js")], { encoding: "utf8" });
    expect(output.trim()).toBe("relay-ok");
  });

  it("fails and leaves dist alone when the vendored relay entry is missing", async () => {
    await write("dist/keep.txt", "previous build");
    await write("app/src/main/index.ts", `export {};\n`);

    await expect(build({ root })).rejects.toThrow(/vendor\/relay\/embedded\.ts is missing/);
    expect(await exists("dist/keep.txt")).toBe(true);
  });

  it("builds main, preload and the renderer when they exist, keeping electron external", async () => {
    await write("vendor/relay/embedded.ts", `export {};\n`);
    await write("app/src/main/index.ts", `import { app } from "electron";\nimport { name } from "../shared/name";\napp.setName(name);\n`);
    await write("app/src/shared/name.ts", `export const name = "Favor Printer";\n`);
    await write("app/src/preload/index.ts", `import { contextBridge } from "electron";\ncontextBridge.exposeInMainWorld("x", {});\n`);
    await write("app/src/renderer/index.html", `<!doctype html><script src="./index.js"></script>\n`);
    await write("app/src/renderer/index.ts", `document.title = "renderer-ok";\n`);
    await write("app/src/renderer/style.css", `body { margin: 0; }\n`);

    const result = await build({ root });

    expect(result).toEqual({ built: ["main", "preload", "relay", "renderer"], skipped: [] });
    const main = await readFile(path.join(root, "dist/main.js"), "utf8");
    expect(main).toContain(`require("electron")`);
    expect(main).toContain("Favor Printer");
    const preload = await readFile(path.join(root, "dist/preload.js"), "utf8");
    expect(preload).toContain(`require("electron")`);
    expect(await exists("dist/renderer/index.html")).toBe(true);
    expect(await exists("dist/renderer/style.css")).toBe(true);
    expect(await readFile(path.join(root, "dist/renderer/index.js"), "utf8")).toContain("renderer-ok");
    expect(await exists("dist/renderer/index.ts")).toBe(false);
  });

  it("removes stale output from a previous build", async () => {
    await write("vendor/relay/embedded.ts", `export {};\n`);
    await write("dist/main.js", "stale");
    await write("dist/renderer/old.html", "stale");

    await build({ root });

    expect(await exists("dist/main.js")).toBe(false);
    expect(await exists("dist/renderer/old.html")).toBe(false);
  });
});

describe("preview renderer server", () => {
  it("maps request paths inside the root and refuses paths that leave it", () => {
    const base = path.resolve("/srv/renderer");
    expect(resolveRequestPath(base, "/index.html")).toBe(path.join(base, "index.html"));
    expect(resolveRequestPath(base, "/index.html?state=revoked")).toBe(path.join(base, "index.html"));
    // The URL parser already collapses plain dot segments, so these stay inside the root.
    expect(resolveRequestPath(base, "/../secret.txt")).toBe(path.join(base, "secret.txt"));
    // Encoded slashes survive URL parsing and decode to a real traversal.
    expect(resolveRequestPath(base, "/..%2fsecret.txt")).toBeNull();
    expect(resolveRequestPath(base, "/%2e%2e%2fsecret.txt")).toBeNull();
    expect(resolveRequestPath(base, "/a/..%2f..%2fsecret.txt")).toBeNull();
    expect(resolveRequestPath(base, "/%00")).toBeNull();
  });

  it("serves files with content types, falls back to index.html for directories and 404s the rest", async () => {
    await write("renderer/index.html", "<h1>hello</h1>");
    await write("renderer/index.js", "console.log(1)");
    await write("secret.txt", "outside the served root");

    const server = await startPreviewServer({ root: path.join(root, "renderer"), port: 0 });
    try {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

      const page = await fetch(`${base}/index.html?state=revoked`);
      expect(page.status).toBe(200);
      expect(page.headers.get("content-type")).toContain("text/html");
      expect(await page.text()).toBe("<h1>hello</h1>");

      const dir = await fetch(`${base}/`);
      expect(await dir.text()).toBe("<h1>hello</h1>");

      const script = await fetch(`${base}/index.js`);
      expect(script.headers.get("content-type")).toContain("text/javascript");

      expect((await fetch(`${base}/missing.html`)).status).toBe(404);
      expect((await fetch(`${base}/..%2fsecret.txt`)).status).toBe(404);
      expect((await fetch(`${base}/index.html`, { method: "POST" })).status).toBe(405);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

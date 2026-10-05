import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AppSnapshot, FavorPrinterApi } from "../shared";
import { boot } from "./boot";
import { createMockApi, FIXTURE_NAMES, fixtureFor } from "./fixtures";
import { fixtureButtons, shouldShowFixtureBar, startPreview } from "./preview";

/** Just enough of a DOM element for `h()` and the preview bar. The renderer runs in a real browser; these run in Node. */
class FakeElement {
  children: (FakeElement | { text: string })[] = [];
  attrs = new Map<string, string>();
  listeners = new Map<string, ((event: unknown) => void)[]>();
  className = "";
  constructor(readonly tagName: string) {}
  setAttribute(name: string, value: string) {
    this.attrs.set(name, value);
  }
  getAttribute(name: string) {
    return this.attrs.get(name) ?? null;
  }
  addEventListener(event: string, listener: (event: unknown) => void) {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
  }
  append(...nodes: (FakeElement | { text: string })[]) {
    this.children.push(...nodes);
  }
  replaceChildren(...nodes: (FakeElement | { text: string })[]) {
    this.children = nodes;
  }
  click() {
    for (const listener of this.listeners.get("click") ?? []) listener({});
  }
}

const el = () => new FakeElement("div") as unknown as HTMLElement & FakeElement;

function descendants(root: FakeElement): FakeElement[] {
  return root.children.flatMap((child) => (child instanceof FakeElement ? [child, ...descendants(child)] : []));
}

const withAttr = (root: FakeElement, name: string) => descendants(root).filter((node) => node.attrs.has(name));
const fixtureButton = (root: FakeElement, name: string) => withAttr(root, "data-fixture").find((node) => node.getAttribute("data-fixture") === name);

beforeEach(() => {
  vi.stubGlobal("document", {
    createElement: (tag: string) => new FakeElement(tag),
    createTextNode: (text: string) => ({ text }),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("shouldShowFixtureBar", () => {
  it("shows only when the preload API is absent", () => {
    expect(shouldShowFixtureBar(undefined)).toBe(true);
    expect(shouldShowFixtureBar(null)).toBe(true);
  });

  it("never shows when the preload API exists", () => {
    expect(shouldShowFixtureBar(createMockApi(fixtureFor(null).snapshot))).toBe(false);
    expect(shouldShowFixtureBar({})).toBe(false);
  });
});

describe("fixtureButtons", () => {
  it("is one button per fixture, in order, each with data-fixture", () => {
    const buttons = fixtureButtons("revoked", () => undefined) as unknown as FakeElement[];
    expect(buttons.map((button) => button.getAttribute("data-fixture"))).toEqual([...FIXTURE_NAMES]);
    expect(buttons.every((button) => button.tagName === "button" && button.getAttribute("type") === "button")).toBe(true);
  });

  it("marks only the active one as pressed", () => {
    const buttons = fixtureButtons("connected", () => undefined) as unknown as FakeElement[];
    expect(buttons.filter((button) => button.getAttribute("aria-pressed") === "true").map((button) => button.getAttribute("data-fixture"))).toEqual(["connected"]);
  });

  it("selects the fixture that was clicked", () => {
    const onSelect = vi.fn();
    const buttons = fixtureButtons("default", onSelect) as unknown as FakeElement[];
    buttons.find((button) => button.getAttribute("data-fixture") === "no-printer")?.click();
    expect(onSelect).toHaveBeenCalledExactlyOnceWith("no-printer");
  });
});

describe("startPreview", () => {
  function setup(requested: string | null) {
    const body = el();
    const root = el();
    const page = el();
    const stops: ReturnType<typeof vi.fn>[] = [];
    const run = vi.fn(() => {
      const stop = vi.fn();
      stops.push(stop);
      return stop;
    });
    const preview = startPreview({ body, markers: [root, page], requested, run, fixtureFor });
    return { body, root, page, run, stops, preview };
  }

  it("starts on the state the page was opened with, and says so on the root", () => {
    const { root, page, run, preview } = setup("several");
    expect(preview.active()).toBe("several-printers");
    expect(root.getAttribute("data-fixture-active")).toBe("several-printers");
    expect(page.getAttribute("data-fixture-active")).toBe("several-printers");
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith(fixtureFor("several-printers"));
  });

  it("starts on the default screen when no state was asked for, or an unknown one", () => {
    expect(setup(null).preview.active()).toBe("default");
    expect(setup("nonsense").preview.active()).toBe("default");
    expect(setup(null).root.getAttribute("data-fixture-active")).toBe("default");
  });

  it("puts the bar in the page with a button for every fixture", () => {
    const { body } = setup(null);
    expect(withAttr(body, "data-preview-only")).toHaveLength(1);
    expect(withAttr(body, "data-fixture").map((button) => button.getAttribute("data-fixture"))).toEqual([...FIXTURE_NAMES]);
    expect(body.getAttribute("data-preview")).toBe("");
  });

  it.each(FIXTURE_NAMES)("clicking %s shows that fixture in place and marks it active", (name) => {
    const { body, root, page, run, stops } = setup("revoked");
    fixtureButton(body, name)?.click();

    expect(root.getAttribute("data-fixture-active")).toBe(name);
    expect(page.getAttribute("data-fixture-active")).toBe(name);
    expect(run).toHaveBeenLastCalledWith(fixtureFor(name));
    // The one that was showing was stopped first.
    expect(stops[0]).toHaveBeenCalledTimes(1);
    expect(withAttr(body, "aria-pressed").filter((button) => button.getAttribute("aria-pressed") === "true").map((button) => button.getAttribute("data-fixture"))).toEqual([name]);
  });

  it("stops each fixture exactly once as the bar is used", () => {
    const { body, run, stops } = setup(null);
    fixtureButton(body, "no-printer")?.click();
    fixtureButton(body, "enter-code")?.click();
    fixtureButton(body, "revoked")?.click();
    expect(run).toHaveBeenCalledTimes(4);
    expect(stops.slice(0, 3).map((stop) => stop.mock.calls.length)).toEqual([1, 1, 1]);
    expect(stops[3]).not.toHaveBeenCalled();
  });
});

describe("boot", () => {
  const snapshot = fixtureFor(null).snapshot;
  const realApi = (): FavorPrinterApi => ({ ...createMockApi(snapshot), getSnapshot: vi.fn(async () => snapshot) });

  function setup(api: FavorPrinterApi | undefined, search = "", hash = "") {
    const body = el();
    const root = el();
    const page = el();
    const start = vi.fn((..._args: Parameters<Parameters<typeof boot>[0]["start"]>) => () => undefined);
    boot({ api, root, body, markers: [root, page], search, hash, start });
    return { body, root, page, start };
  }

  describe("inside Electron (the preload API exists)", () => {
    it("starts the app on the real API and snapshot", async () => {
      const api = realApi();
      const { root, start } = setup(api);
      await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(1));
      expect(start.mock.calls[0][0]).toBe(root);
      expect(start.mock.calls[0][1]).toBe(api);
      expect(start.mock.calls[0][2]).toBe(snapshot);
    });

    it("renders no fixture bar, no preview marker and no active-fixture attribute", async () => {
      const { body, root, page, start } = setup(realApi());
      await vi.waitFor(() => expect(start).toHaveBeenCalled());
      expect(descendants(body)).toEqual([]);
      expect(withAttr(body, "data-fixture")).toEqual([]);
      expect(body.getAttribute("data-preview")).toBeNull();
      expect(root.getAttribute("data-fixture-active")).toBeNull();
      expect(page.getAttribute("data-fixture-active")).toBeNull();
    });

    it("ignores ?state= and #state=: a window cannot be pointed at a fixture", async () => {
      const api = realApi();
      const { body, root, start } = setup(api, "?state=revoked", "#state=legacy-failed");
      await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(1));
      expect(start.mock.calls[0][1]).toBe(api);
      expect(start.mock.calls[0][2]).toBe(snapshot);
      expect(descendants(body)).toEqual([]);
      expect(root.getAttribute("data-fixture-active")).toBeNull();
    });

    it("never builds a mock API", async () => {
      const { start } = setup(realApi());
      await vi.waitFor(() => expect(start).toHaveBeenCalled());
      expect(start).toHaveBeenCalledTimes(1);
    });
  });

  describe("in the preview server (no preload API)", () => {
    it("renders the bar with one data-fixture button per state", () => {
      const { body } = setup(undefined);
      expect(withAttr(body, "data-fixture").map((button) => button.getAttribute("data-fixture"))).toEqual([...FIXTURE_NAMES]);
    });

    it("starts on ?state= and marks it active on the root", () => {
      const { root, page, start } = setup(undefined, "?state=queue-fallback");
      expect(root.getAttribute("data-fixture-active")).toBe("queue-fallback");
      expect(page.getAttribute("data-fixture-active")).toBe("queue-fallback");
      expect(start).toHaveBeenCalledTimes(1);
      expect(start.mock.calls[0][2]).toEqual(fixtureFor("queue-fallback").snapshot);
      expect(start.mock.calls[0][3]).toEqual({ initialLocal: fixtureFor("queue-fallback").local });
    });

    it("also reads a short name or a hash", () => {
      expect(setup(undefined, "?state=several").root.getAttribute("data-fixture-active")).toBe("several-printers");
      expect(setup(undefined, "", "#fallback").root.getAttribute("data-fixture-active")).toBe("queue-fallback");
    });

    it("re-renders in place when a button is clicked, with a fresh mock API for that state", () => {
      const { body, root, start } = setup(undefined);
      fixtureButton(body, "test-print-confirm")?.click();

      expect(start).toHaveBeenCalledTimes(2);
      expect(start.mock.calls[1][0]).toBe(root);
      expect(start.mock.calls[1][2]).toEqual(fixtureFor("test-print-confirm").snapshot);
      expect(start.mock.calls[1][3]).toEqual({ initialLocal: fixtureFor("test-print-confirm").local });
      expect(root.getAttribute("data-fixture-active")).toBe("test-print-confirm");
    });

    it("gives the failure fixture an API that refuses to turn the old relay off", async () => {
      const { body, start } = setup(undefined);
      fixtureButton(body, "legacy-failed")?.click();
      const api = start.mock.calls[1][1] as FavorPrinterApi;
      await expect(api.migrateLegacyRelay()).resolves.toEqual({ ok: false, reason: "bootout_failed" });
    });

    it("hands every state a snapshot that differs from the welcome screen's, except the welcome itself", () => {
      const { body, start } = setup(undefined);
      const seen = new Map<string, AppSnapshot>();
      for (const name of FIXTURE_NAMES) {
        fixtureButton(body, name)?.click();
        seen.set(name, start.mock.lastCall?.[2] as AppSnapshot);
      }
      expect(seen.size).toBe(FIXTURE_NAMES.length);
      const welcome = JSON.stringify(seen.get("default"));
      for (const [name, state] of seen) if (name !== "default") expect(JSON.stringify(state)).not.toBe(welcome);
    });
  });

  it("is wired from the page with the real preload API as the only switch", async () => {
    const { readFile } = await import("node:fs/promises");
    const source = await readFile(new URL("./index.ts", import.meta.url), "utf8");
    expect(source).toMatch(/api:\s*window\.favorPrinter/);
    // No other route to the bar: nothing in index.ts reads the query, or builds a fixture itself.
    expect(source).not.toMatch(/startPreview|fixtureButtons|createMockApi|data-fixture/);
  });
});

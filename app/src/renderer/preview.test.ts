import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AppSnapshot, FavorPrinterApi } from "../shared";
import { boot } from "./boot";
import { ENROLL_CONFLICT_COPY, ENROLL_CONFLICT_REASONS, type EnrollConflictReason } from "../shared";
import { startApp } from "./app";
import { INITIAL_LOCAL, ENROLL_ERROR_COPY, LOCAL_TEST_COPY, RENAME_ERROR_COPY } from "./model";
import { channelLabel, renderScreen, updateStatusText } from "./screens";
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
  querySelector() {
    return null;
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

describe("printer_not_found on the plug-in screen", () => {
  const text = (root: FakeElement): string[] =>
    root.children.flatMap((child) => (child instanceof FakeElement ? text(child) : [(child as { text: string }).text]));
  const render = (codeError: "printer_not_found" | null) =>
    renderScreen("printer-none", {
      snapshot: fixtureFor("no-printer").snapshot,
      local: { ...INITIAL_LOCAL, codeError },
      actions: {} as never,
    }) as unknown as FakeElement;

  it("shows the copy after a printer_not_found result", () => {
    expect(text(render("printer_not_found"))).toContain(ENROLL_ERROR_COPY.printer_not_found);
  });

  it("shows no error otherwise", () => {
    expect(text(render(null))).not.toContain(ENROLL_ERROR_COPY.printer_not_found);
  });
});

describe("status / about screen rendering", () => {
  const text = (root: FakeElement): string[] =>
    root.children.flatMap((child) => (child instanceof FakeElement ? text(child) : [(child as { text: string }).text]));

  it.each([
    [{ kind: "idle" as const }, "Up to date"],
    [{ kind: "checking" as const }, "Checking for updates..."],
    [{ kind: "downloading" as const }, "Downloading update..."],
    [{ kind: "ready" as const, version: "0.2.0" }, "Update ready. Restart to apply."],
    [{ kind: "ready" as const, version: "" }, "Update ready. Restart to apply."],
    [{ kind: "error" as const }, "Update check failed."],
  ])("renders update state %o as %s", (update, expected) => {
    const rendered = renderScreen("status", {
      snapshot: { ...fixtureFor("status").snapshot, update, channel: "stable", version: "0.1.0" },
      local: INITIAL_LOCAL,
      actions: {} as never,
    }) as unknown as FakeElement;
    expect(text(rendered)).toContain(expected);
    expect(text(rendered)).toContain("Version 0.1.0 (Stable)");
  });

  it("displays preview channel clearly when on preview", () => {
    const rendered = renderScreen("status", {
      snapshot: { ...fixtureFor("status").snapshot, channel: "preview", version: "0.1.0" },
      local: INITIAL_LOCAL,
      actions: {} as never,
    }) as unknown as FakeElement;
    expect(text(rendered)).toContain("Version 0.1.0 (Preview)");
  });

  it("matches the copy deck strings directly from docs/design/copy-deck.md", async () => {
    const { readFile } = await import("node:fs/promises");
    const deckPath = new URL("../../../docs/design/copy-deck.md", import.meta.url);
    const deck = await readFile(deckPath, "utf8");

    // Copy deck specifies exact status window lines:
    expect(deck).toContain("`idle`: `Up to date`");
    expect(deck).toContain("`checking`: `Checking for updates...`");
    expect(deck).toContain("`downloading`: `Downloading update...`");
    expect(deck).toContain("`ready`: `Update ready. Restart to apply.`");
    expect(deck).toContain("`error`: `Update check failed.`");
    expect(deck).toContain("`stable` → `Stable`");
    expect(deck).toContain("`preview` → `Preview`");

    // Verify all helper outputs match the deck strings
    expect(updateStatusText({ kind: "idle" })).toBe("Up to date");
    expect(updateStatusText({ kind: "checking" })).toBe("Checking for updates...");
    expect(updateStatusText({ kind: "downloading" })).toBe("Downloading update...");
    expect(updateStatusText({ kind: "ready", version: "1.0.0" })).toBe("Update ready. Restart to apply.");
    expect(updateStatusText({ kind: "error" })).toBe("Update check failed.");
    expect(channelLabel("stable")).toBe("Stable");
    expect(channelLabel("preview")).toBe("Preview");
  });

  it("handles empty detail gracefully", () => {
    const rendered = renderScreen("status", {
      snapshot: { ...fixtureFor("status").snapshot, status: { color: "green", headline: "Ready to print", detail: null } },
      local: INITIAL_LOCAL,
      actions: {} as never,
    }) as unknown as FakeElement;
    expect(text(rendered)).toContain("Ready to print");
  });

  it("renders fiveState and recoveryAction hint on status screen", () => {
    const rendered = renderScreen("status", {
      snapshot: {
        ...fixtureFor("status").snapshot,
        fiveState: "Connected",
        recoveryAction: "Run a local test print in Favor Printer to verify labels.",
      },
      local: INITIAL_LOCAL,
      actions: {} as never,
    }) as unknown as FakeElement;
    expect(text(rendered)).toContain("Connected: Run a local test print in Favor Printer to verify labels.");
  });

  it("renders In use elsewhere state and its recovery action on status screen", () => {
    const rendered = renderScreen("status", {
      snapshot: {
        ...fixtureFor("status").snapshot,
        fiveState: "In use elsewhere",
        recoveryAction: "Ask an admin to disconnect this printer from the other laptop.",
      },
      local: INITIAL_LOCAL,
      actions: {} as never,
    }) as unknown as FakeElement;
    expect(text(rendered)).toContain(
      "In use elsewhere: Ask an admin to disconnect this printer from the other laptop.",
    );
  });
});

describe("edge case rendering in screens", () => {
  const text = (root: FakeElement): string[] =>
    root.children.flatMap((child) => (child instanceof FakeElement ? text(child) : [(child as { text: string }).text]));

  it("renders long laptop labels in connected screen", () => {
    const longLabel = "Very Long Sanctuary Stage Left Check-in MacBook Pro Label That Might Wrap Across Lines";
    const rendered = renderScreen("connected", {
      snapshot: { ...fixtureFor("connected").snapshot, label: longLabel },
      local: INITIAL_LOCAL,
      actions: {} as never,
    }) as unknown as FakeElement;
    expect(text(rendered)).toContain(`This Mac is now ${longLabel} in Favor RSVP.`);
  });

  it("renders long printer model strings in printer-ready screen", () => {
    const longModel = "Zebra Technologies ZTC ZD421-203dpi ZPL Extended Long Name Industrial High Density";
    const rendered = renderScreen("printer-ready", {
      snapshot: {
        ...fixtureFor("default").snapshot,
        printer: {
          kind: "found",
          devices: [{ id: "p1", deviceUri: "p1", usbSerial: "123", model: longModel }],
          selectedId: "p1",
          queue: "ready",
        },
      },
      local: INITIAL_LOCAL,
      actions: {} as never,
    }) as unknown as FakeElement;
    expect(text(rendered)).toContain(`${longModel} is connected and set up.`);
  });

  it("renders empty warnings list in done screen without breaking", () => {
    const rendered = renderScreen("done", {
      snapshot: { ...fixtureFor("done").snapshot, warnings: [] },
      local: INITIAL_LOCAL,
      actions: {} as never,
    }) as unknown as FakeElement;
    const ul = descendants(rendered).find((n) => n.tagName === "ul");
    expect(ul).toBeDefined();
    expect(ul?.children).toHaveLength(0);
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

  it("defines specific motion transitions and disables motion under prefers-reduced-motion: reduce", async () => {
    const { readFile } = await import("node:fs/promises");
    const css = await readFile(new URL("./styles.css", import.meta.url), "utf8");

    // Must not use unconstrained 'transition: all'
    expect(css).not.toMatch(/transition:\s*all/);

    // Transitions must specify explicit properties
    expect(css).toMatch(/transition:\s*[\s\S]*?background\s+150ms/);
    expect(css).toMatch(/border-color\s+150ms/);
    expect(css).toMatch(/opacity\s+150ms/);
    expect(css).toMatch(/transform\s+150ms/);

    // Must include prefers-reduced-motion: reduce media query
    expect(css).toMatch(/@media\s*\(\s*prefers-reduced-motion:\s*reduce\s*\)/);
    expect(css).toMatch(/transition-duration:\s*0\.01ms\s*!important/);
  });
});


describe("bound printer on the connected and status screens", () => {
  const text = (root: FakeElement): string[] =>
    root.children.flatMap((child) => (child instanceof FakeElement ? text(child) : [(child as { text: string }).text]));
  const render = (screen: "connected" | "status", patch: Partial<AppSnapshot>) =>
    text(
      renderScreen(screen, {
        snapshot: { ...fixtureFor("connected").snapshot, ...patch },
        local: INITIAL_LOCAL,
        actions: {} as never,
      }) as unknown as FakeElement,
    );

  it.each(["connected", "status"] as const)("%s shows the printer name and campus id", (screen) => {
    expect(render(screen, { printerName: "Lobby Zebra", campusId: 7 })).toContain("Printer: Lobby Zebra · Campus ID 7");
  });

  it.each(["connected", "status"] as const)("%s shows just the name when there is no campus", (screen) => {
    const lines = render(screen, { printerName: "Lobby Zebra", campusId: null });
    expect(lines).toContain("Printer: Lobby Zebra");
    expect(lines.join(" ")).not.toMatch(/campus/i);
  });

  it.each(["connected", "status"] as const)("%s shows no printer line when the cloud did not name one", (screen) => {
    expect(render(screen, { printerName: null, campusId: null }).join(" ")).not.toContain("Printer:");
  });
});

describe("local hardware test copy", () => {
  const text = (root: FakeElement): string[] =>
    root.children.flatMap((child) => (child instanceof FakeElement ? text(child) : [(child as { text: string }).text]));
  const render = (testPrint: (typeof INITIAL_LOCAL)["testPrint"]) =>
    text(
      renderScreen("test-print", {
        snapshot: fixtureFor("test-print-confirm").snapshot,
        local: { ...INITIAL_LOCAL, testPrint },
        actions: {} as never,
      }) as unknown as FakeElement,
    );

  it("says it is a local hardware test and points to RSVP Set up printing", () => {
    const lines = render({ kind: "idle" });
    expect(lines).toContain("Local hardware test");
    expect(lines.join(" ")).toMatch(/does not test check-in/);
    expect(lines).toContain("To test check-in printing from Favor RSVP, use Set up printing in RSVP.");
    expect(lines).toContain(LOCAL_TEST_COPY.start);
  });

  it("keeps the pointer while asking whether a label came out", () => {
    const lines = render({ kind: "sent" });
    expect(lines).toContain("Did a label come out?");
    expect(lines.join(" ")).toContain("Set up printing in RSVP");
  });
});

describe("a refused enrollment on the code screen", () => {
  const text = (root: FakeElement): string[] =>
    root.children.flatMap((child) => (child instanceof FakeElement ? text(child) : [(child as { text: string }).text]));

  it.each([...ENROLL_CONFLICT_REASONS, "unknown"] as EnrollConflictReason[])("shows the copy for conflict %s", (codeConflict) => {
    const rendered = renderScreen("code", {
      snapshot: fixtureFor("enter-code").snapshot,
      local: { ...INITIAL_LOCAL, codeConflict },
      actions: {} as never,
    }) as unknown as FakeElement;
    expect(text(rendered)).toContain(ENROLL_CONFLICT_COPY[codeConflict]);
    expect(withAttr(rendered, "aria-invalid").some((node) => node.getAttribute("aria-invalid") === "true")).toBe(true);
  });

  const submit = async (enrollResult: Awaited<ReturnType<FavorPrinterApi["enroll"]>>) => {
    const api = { ...createMockApi(fixtureFor("enter-code").snapshot), enroll: vi.fn(async () => enrollResult) } as unknown as FavorPrinterApi;
    const root = new FakeElement("div");
    startApp(root as unknown as HTMLElement, api, fixtureFor("enter-code").snapshot);
    const input = descendants(root).find((node) => node.tagName === "input") as unknown as { value: string };
    input.value = "123456";
    const form = descendants(root).find((node) => node.tagName === "form") as FakeElement;
    form.listeners.get("submit")?.[0]({ preventDefault: () => undefined });
    await vi.waitFor(() => expect(api.enroll).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 0));
    return text(root);
  };

  it("turns a conflict from main into its own copy, not a generic error", async () => {
    const lines = await submit({ ok: false, reason: "printer_conflict", conflict: "serial_in_use" });
    expect(lines).toContain(ENROLL_CONFLICT_COPY.serial_in_use);
  });

  it("shows the used-up code copy when main reports code_used", async () => {
    const lines = await submit({ ok: false, reason: "code_used" });
    expect(lines).toContain(ENROLL_ERROR_COPY.code_used);
    expect(lines).not.toContain(ENROLL_CONFLICT_COPY.unknown);
  });

  it("shows distinct error copy for invalid, expired, and already-used codes", async () => {
    const invalidLines = await submit({ ok: false, reason: "invalid_code" });
    expect(invalidLines).toContain(ENROLL_ERROR_COPY.invalid_code);
    expect(invalidLines).not.toContain(ENROLL_ERROR_COPY.code_expired);
    expect(invalidLines).not.toContain(ENROLL_ERROR_COPY.code_used);

    const expiredLines = await submit({ ok: false, reason: "code_expired" });
    expect(expiredLines).toContain(ENROLL_ERROR_COPY.code_expired);
    expect(expiredLines).not.toContain(ENROLL_ERROR_COPY.invalid_code);
    expect(expiredLines).not.toContain(ENROLL_ERROR_COPY.code_used);

    const usedLines = await submit({ ok: false, reason: "code_used" });
    expect(usedLines).toContain(ENROLL_ERROR_COPY.code_used);
    expect(usedLines).not.toContain(ENROLL_ERROR_COPY.invalid_code);
    expect(usedLines).not.toContain(ENROLL_ERROR_COPY.code_expired);

    expect(ENROLL_ERROR_COPY.invalid_code).not.toBe(ENROLL_ERROR_COPY.code_expired);
    expect(ENROLL_ERROR_COPY.code_expired).not.toBe(ENROLL_ERROR_COPY.code_used);
    expect(ENROLL_ERROR_COPY.invalid_code).not.toBe(ENROLL_ERROR_COPY.code_used);
  });

  it("still shows the plain copy for other failures", async () => {
    const lines = await submit({ ok: false, reason: "throttled" });
    expect(lines).toContain(ENROLL_ERROR_COPY.throttled);
  });
});

describe("rename controls on the connected screen", () => {
  const snapshot = (patch: Partial<AppSnapshot> = {}): AppSnapshot => ({ ...fixtureFor("connected").snapshot, label: "Front desk", printerName: "Lobby Zebra", ...patch });
  const connected = (local = INITIAL_LOCAL, patch?: Partial<AppSnapshot>) => {
    const actions = { renameLaptop: vi.fn(), renamePrinter: vi.fn() };
    const root = renderScreen("connected", { snapshot: snapshot(patch), local, actions: actions as never }) as unknown as FakeElement;
    return { root, actions };
  };
  const field = (root: FakeElement, id: string) => descendants(root).find((node) => node.attrs.get("id") === id) as FakeElement & { value?: string };
  const submit = (root: FakeElement, id: string) => {
    const form = descendants(root).find((node) => node.tagName === "form" && descendants(node).some((child) => child.attrs.get("id") === id));
    form?.listeners.get("submit")?.[0]({ preventDefault: vi.fn() });
  };

  it("saves the laptop and the printer name separately, as typed", () => {
    const { root, actions } = connected();
    field(root, "laptop-name").value = "Lobby desk";
    submit(root, "laptop-name");
    expect(actions.renameLaptop).toHaveBeenCalledExactlyOnceWith("Lobby desk");
    expect(actions.renamePrinter).not.toHaveBeenCalled();

    field(root, "printer-name").value = "Front Zebra";
    submit(root, "printer-name");
    expect(actions.renamePrinter).toHaveBeenCalledExactlyOnceWith("Front Zebra");
  });

  it("shows the RSVP reason under the field that failed, and keeps the typed name there", () => {
    const { root } = connected({ ...INITIAL_LOCAL, renameError: { target: "printer", reason: "name_taken", name: "Front Zebra" } });
    expect(field(root, "printer-name").getAttribute("value")).toBe("Front Zebra");
    expect(field(root, "printer-name").getAttribute("aria-invalid")).toBe("true");
    expect(field(root, "laptop-name").getAttribute("aria-invalid")).toBe("false");
    const message = descendants(root).find((node) => node.attrs.get("id") === "printer-name-error");
    expect(message?.children).toEqual([{ text: RENAME_ERROR_COPY.name_taken }]);
  });

  it("offers no printer name to edit before a printer is bound", () => {
    const { root } = connected(INITIAL_LOCAL, { printerName: null });
    expect(field(root, "printer-name")).toBeUndefined();
    expect(field(root, "laptop-name")).toBeDefined();
  });
});

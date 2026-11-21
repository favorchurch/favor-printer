import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { printerSetupFailureCopy, type AppSnapshot, type FavorPrinterApi, type PrinterSetupResult } from "../shared";
import { startApp } from "./app";
import { createMockApi, FIXTURE_NAMES, fixtureFor } from "./fixtures";
import { INITIAL_LOCAL, PRINTER_SETUP_COPY } from "./model";
import { renderScreen } from "./screens";

/** Just enough of a DOM element for `h()`. The renderer runs in a browser; these run in Node. */
class FakeElement {
  children: (FakeElement | { text: string })[] = [];
  attrs = new Map<string, string>();
  listeners = new Map<string, ((event: unknown) => void)[]>();
  className = "";
  disabled = false;
  tabIndex = 0;
  constructor(readonly tagName: string) {}
  setAttribute(name: string, value: string) {
    this.attrs.set(name, value);
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

const descendants = (root: FakeElement): FakeElement[] =>
  root.children.flatMap((child) => (child instanceof FakeElement ? [child, ...descendants(child)] : []));
const text = (root: FakeElement): string[] =>
  root.children.flatMap((child) => (child instanceof FakeElement ? text(child) : [(child as { text: string }).text]));
const control = (root: FakeElement) => descendants(root).find((node) => node.attrs.get("data-action") === "setup-printer");
const buttonLabelled = (root: FakeElement, label: string) =>
  descendants(root).find((node) => node.tagName === "button" && text(node).includes(label));

beforeEach(() => {
  vi.stubGlobal("document", {
    createElement: (tag: string) => new FakeElement(tag),
    createTextNode: (value: string) => ({ text: value }),
  });
});
afterEach(() => vi.unstubAllGlobals());

const noop = {} as never;
const render = (snapshot: AppSnapshot, screen: Parameters<typeof renderScreen>[0] = "status") =>
  renderScreen(screen, { snapshot, local: INITIAL_LOCAL, actions: noop }) as unknown as FakeElement;

describe("the Set up printer control", () => {
  it("shows on the status screen when a queue is ready", () => {
    const rendered = control(render(fixtureFor("status").snapshot));
    expect(rendered).toBeDefined();
    expect(rendered?.attrs.get("data-state")).toBe("idle");
  });

  it("shows on the printer-ready and connected screens too", () => {
    const snapshot = fixtureFor("connected").snapshot;
    expect(control(render(snapshot, "printer-ready"))).toBeDefined();
    expect(control(render(snapshot, "connected"))).toBeDefined();
  });

  it.each([
    ["no printer", { printer: { kind: "none" } } as Partial<AppSnapshot>],
    ["no ready queue", { printer: { kind: "found", devices: [], selectedId: "x", queue: "missing" } } as Partial<AppSnapshot>],
    ["no selected printer", { printer: { kind: "found", devices: [], selectedId: null, queue: "ready" } } as Partial<AppSnapshot>],
  ])("is absent with %s", (_name, patch) => {
    expect(control(render({ ...fixtureFor("status").snapshot, ...patch }))).toBeUndefined();
  });
});

describe("the plug-in screen when Windows has a Zebra queue it cannot use", () => {
  const windows = (printer: AppSnapshot["printer"]) => ({ ...fixtureFor("status").snapshot, platform: "win32" as const, setupStep: "printer" as const, printer });

  it("shows what to change instead of asking for a printer", () => {
    const notice = 'Favor Printer cannot print to a queue named "Kids Zebra #1".';
    const shown = text(render(windows({ kind: "none", notice }), "printer-none")).join(" ");
    expect(shown).toContain(notice);
    expect(shown).toContain("Look again");
    expect(shown).not.toContain("Plug in your Zebra printer");
  });

  it("still asks for a printer when no Zebra queue was seen", () => {
    expect(text(render(windows({ kind: "none" }), "printer-none")).join(" ")).toContain("Plug in your Zebra printer");
  });
});

describe("the confirm copy", () => {
  it("says it is for Zebra printers with a cutter and that blank labels feed", () => {
    const rendered = renderScreen("status", {
      snapshot: fixtureFor("setup-printer-confirm").snapshot,
      local: { ...INITIAL_LOCAL, ...fixtureFor("setup-printer-confirm").local },
      actions: noop,
    }) as unknown as FakeElement;
    const shown = text(rendered).join(" ");
    expect(shown).toContain("Set up printer?");
    expect(shown).toContain("For Zebra printers with a cutter. The printer feeds a few blank labels while it calibrates.");
  });
});

describe("the Set up printer fixtures", () => {
  const states = {
    "setup-printer-confirm": "confirm",
    "setup-printer-running": "running",
    "setup-printer-done": "done",
    "setup-printer-failed": "failed",
  } as const;

  it.each(Object.entries(states))("%s is in the fixture bar and shows the %s state", (name, state) => {
    expect(FIXTURE_NAMES).toContain(name);
    const { snapshot, local } = fixtureFor(name);
    const rendered = renderScreen("status", { snapshot, local: { ...INITIAL_LOCAL, ...local }, actions: noop }) as unknown as FakeElement;
    expect(control(rendered)?.attrs.get("data-state")).toBe(state);
  });

  it("the failed fixture names the step that failed", () => {
    const { snapshot, local } = fixtureFor("setup-printer-failed");
    const rendered = renderScreen("status", { snapshot, local: { ...INITIAL_LOCAL, ...local }, actions: noop }) as unknown as FakeElement;
    expect(text(rendered).join(" ")).toContain("calibrating");
  });

  it("the running state disables its button", () => {
    const { snapshot, local } = fixtureFor("setup-printer-running");
    const rendered = renderScreen("status", { snapshot, local: { ...INITIAL_LOCAL, ...local }, actions: noop }) as unknown as FakeElement;
    expect(buttonLabelled(rendered, PRINTER_SETUP_COPY.running)?.disabled).toBe(true);
  });
});

describe("driving the control", () => {
  const start = (configurePrinter: FavorPrinterApi["configurePrinter"]) => {
    const snapshot = fixtureFor("status").snapshot;
    const api = { ...createMockApi(snapshot), configurePrinter: vi.fn(configurePrinter) } as FavorPrinterApi & {
      configurePrinter: ReturnType<typeof vi.fn>;
    };
    const root = new FakeElement("div");
    startApp(root as unknown as HTMLElement, api, snapshot);
    return { api, root };
  };
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  it("asks first: the first click sends nothing", () => {
    const { api, root } = start(async () => ({ ok: true }));
    buttonLabelled(root, PRINTER_SETUP_COPY.start)?.click();
    expect(api.configurePrinter).not.toHaveBeenCalled();
    expect(control(root)?.attrs.get("data-state")).toBe("confirm");
  });

  it("cancel goes back without sending", () => {
    const { api, root } = start(async () => ({ ok: true }));
    buttonLabelled(root, PRINTER_SETUP_COPY.start)?.click();
    buttonLabelled(root, "Cancel")?.click();
    expect(api.configurePrinter).not.toHaveBeenCalled();
    expect(control(root)?.attrs.get("data-state")).toBe("idle");
  });

  it("confirming runs it once, shows running, then done", async () => {
    let release: ((result: PrinterSetupResult) => void) | undefined;
    const { api, root } = start(() => new Promise((resolve) => (release = resolve)));
    buttonLabelled(root, PRINTER_SETUP_COPY.start)?.click();
    buttonLabelled(root, PRINTER_SETUP_COPY.confirmYes)?.click();
    expect(control(root)?.attrs.get("data-state")).toBe("running");
    expect(api.configurePrinter).toHaveBeenCalledTimes(1);

    release?.({ ok: true });
    await settle();
    expect(control(root)?.attrs.get("data-state")).toBe("done");
    expect(text(root)).toContain(PRINTER_SETUP_COPY.done);
  });

  it("shows which step failed", async () => {
    const result: PrinterSetupResult = { ok: false, reason: "failed", step: "save" };
    const { root } = start(async () => result);
    buttonLabelled(root, PRINTER_SETUP_COPY.start)?.click();
    buttonLabelled(root, PRINTER_SETUP_COPY.confirmYes)?.click();
    await settle();
    expect(control(root)?.attrs.get("data-state")).toBe("failed");
    expect(text(root)).toContain(printerSetupFailureCopy(result));
    expect(printerSetupFailureCopy(result)).toContain("saving");
  });

  it("shows busy and no-queue refusals as failures", async () => {
    for (const reason of ["busy", "no-queue"] as const) {
      const { root } = start(async () => ({ ok: false, reason }));
      buttonLabelled(root, PRINTER_SETUP_COPY.start)?.click();
      buttonLabelled(root, PRINTER_SETUP_COPY.confirmYes)?.click();
      await settle();
      expect(text(root)).toContain(printerSetupFailureCopy({ ok: false, reason }));
    }
  });

  it("a rejected call (invalid payload) is a failure, not a stuck spinner", async () => {
    const { root } = start(async () => {
      throw new Error("Invalid payload");
    });
    buttonLabelled(root, PRINTER_SETUP_COPY.start)?.click();
    buttonLabelled(root, PRINTER_SETUP_COPY.confirmYes)?.click();
    await settle();
    expect(control(root)?.attrs.get("data-state")).toBe("failed");
  });

  it("a rejected call does not blame a setup step", async () => {
    const { root } = start(async () => {
      throw new Error("Invalid payload");
    });
    buttonLabelled(root, PRINTER_SETUP_COPY.start)?.click();
    buttonLabelled(root, PRINTER_SETUP_COPY.confirmYes)?.click();
    await settle();
    const shown = text(root).join(" ");
    expect(shown).not.toMatch(/calibrating|setting the mode|saving/);
    expect(shown).toContain(printerSetupFailureCopy({ ok: false, reason: "rejected" }));
  });

  it("ignores a result that arrives after the window moved to another step", async () => {
    const snapshot = fixtureFor("connected").snapshot;
    const listeners: ((next: AppSnapshot) => void)[] = [];
    let release: ((result: PrinterSetupResult) => void) | undefined;
    const api = {
      ...createMockApi(snapshot),
      onSnapshot: (listener: (next: AppSnapshot) => void) => {
        listeners.push(listener);
        return () => undefined;
      },
      configurePrinter: () => new Promise<PrinterSetupResult>((resolve) => (release = resolve)),
    } as FavorPrinterApi;
    const root = new FakeElement("div");
    startApp(root as unknown as HTMLElement, api, snapshot);
    buttonLabelled(root, PRINTER_SETUP_COPY.start)?.click();
    buttonLabelled(root, PRINTER_SETUP_COPY.confirmYes)?.click();
    expect(control(root)?.attrs.get("data-state")).toBe("running");

    for (const listener of listeners) listener({ ...snapshot, setupStep: null });
    expect(control(root)?.attrs.get("data-state")).toBe("idle");
    release?.({ ok: true });
    await settle();
    expect(control(root)?.attrs.get("data-state")).toBe("idle");
  });
});

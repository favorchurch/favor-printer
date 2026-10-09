import { describe, expect, it, vi } from "vitest";

import type { AppSnapshot } from "../../shared";
import { buildMenuTemplate, createTrayView, jobCountsLabel, trayTooltip, type MenuItemTemplate, type TrayActions } from "./tray";
import { snapshotFor } from "./testing/snapshot";
import { deriveStatus, type StatusInputs } from "../services/statusSummary";
import type { RelayStatus } from "../../../../vendor/relay/status";

const actions = (): { [K in keyof TrayActions]: ReturnType<typeof vi.fn> } & TrayActions =>
  ({
    pause: vi.fn(),
    resume: vi.fn(),
    testPrint: vi.fn(),
    openSetup: vi.fn(),
    reenroll: vi.fn(),
    migrateLegacy: vi.fn(),
    setOpenAtLogin: vi.fn(),
    checkForUpdates: vi.fn(),
    setChannel: vi.fn(),
    quit: vi.fn(),
  }) as never;

const labels = (items: MenuItemTemplate[]) => items.filter((item) => item.type !== "separator").map((item) => item.label);
const find = (items: MenuItemTemplate[], label: string) => items.find((item) => item.label === label);

const RED: Partial<AppSnapshot> = {
  enrolled: false,
  status: { color: "red", headline: "This laptop was removed. Ask an admin for a new code.", detail: null },
};

describe("buildMenuTemplate", () => {
  it("shows the status, job counts, controls, open at login, update, version and quit", () => {
    const items = buildMenuTemplate(snapshotFor({ recentJobs: { sent: 4, failed: 1, ambiguous: 0 } }), actions());
    expect(labels(items)).toEqual([
      "Ready to print",
      "Labels this session: 4 sent, 1 failed",
      "Pause printing",
      "Test print...",
      "Keep printing",
      "Open at login",
      "Check for updates",
      "Update channel",
      "Favor Printer 0.1.0",
      "Quit Favor Printer",
    ]);
  });

  it("shows the headline and the help line", () => {
    const items = buildMenuTemplate(
      snapshotFor({ status: { color: "amber", headline: "No printer found", detail: "Plug in the Zebra with its USB cable." } }),
      actions(),
    );
    expect(labels(items).slice(0, 2)).toEqual(["No printer found", "Plug in the Zebra with its USB cable."]);
    expect(items[0].enabled).toBe(false);
  });

  it("names the laptop when an admin did", () => {
    expect(labels(buildMenuTemplate(snapshotFor({ label: "Front desk" }), actions()))).toContain("This laptop: Front desk");
  });

  it("counts labels to check separately", () => {
    expect(jobCountsLabel({ sent: 2, failed: 0, ambiguous: 1 })).toBe("Labels this session: 2 sent, 0 failed, 1 to check");
    expect(jobCountsLabel({ sent: 0, failed: 0, ambiguous: 0 })).toBe("Labels this session: 0 sent, 0 failed");
  });

  it("offers Resume while paused and wires the click", () => {
    const a = actions();
    const items = buildMenuTemplate(snapshotFor({ paused: true }), a);
    expect(find(items, "Pause printing")).toBeUndefined();
    find(items, "Resume printing")?.click?.();
    expect(a.resume).toHaveBeenCalled();
  });

  it("wires pause, test print and quit", () => {
    const a = actions();
    const items = buildMenuTemplate(snapshotFor(), a);
    find(items, "Pause printing")?.click?.();
    find(items, "Test print...")?.click?.();
    find(items, "Quit Favor Printer")?.click?.();
    expect([a.pause, a.testPrint, a.quit].map((fn) => fn.mock.calls.length)).toEqual([1, 1, 1]);
  });

  it("lists the power warnings and never says printing works with the lid closed", () => {
    const items = buildMenuTemplate(snapshotFor({ warnings: ["Keep the lid open while printing.", "This Mac is on battery."] }), actions());
    const submenu = find(items, "Keep printing")?.submenu ?? [];
    expect(labels(submenu)).toEqual(["Keep the lid open while printing.", "This Mac is on battery."]);
    expect(submenu.every((item) => item.enabled === false)).toBe(true);
  });

  describe("open at login", () => {
    it("is a checkbox that reflects the setting and flips it", () => {
      const a = actions();
      const on = find(buildMenuTemplate(snapshotFor({ openAtLogin: true }), a), "Open at login");
      expect(on).toMatchObject({ type: "checkbox", checked: true });
      on?.click?.();
      expect(a.setOpenAtLogin).toHaveBeenLastCalledWith(false);

      const off = find(buildMenuTemplate(snapshotFor({ openAtLogin: false }), a), "Open at login");
      expect(off?.checked).toBe(false);
      off?.click?.();
      expect(a.setOpenAtLogin).toHaveBeenLastCalledWith(true);
    });
  });

  describe("update state", () => {
    it.each([
      [{ kind: "idle" }, "Check for updates", true],
      [{ kind: "checking" }, "Checking for updates...", false],
      [{ kind: "downloading" }, "Downloading an update...", false],
      [{ kind: "ready", version: "0.2.0" }, "Update 0.2.0 ready. It installs when you quit.", false],
      [{ kind: "ready", version: "" }, "An update is ready. It installs when you quit.", false],
      [{ kind: "error" }, "Update check failed. Try again", true],
    ] as const)("%j shows %s", (update, label, clickable) => {
      const a = actions();
      const items = buildMenuTemplate(snapshotFor({ update }), a);
      const item = find(items, label);
      expect(item).toBeDefined();
      if (clickable) {
        item?.click?.();
        expect(a.checkForUpdates).toHaveBeenCalled();
      } else {
        expect(item?.enabled).toBe(false);
      }
    });
  });

  it("offers the two channels as radio items", () => {
    const a = actions();
    const channel = find(buildMenuTemplate(snapshotFor({ channel: "preview" }), a), "Update channel");
    expect(channel?.submenu?.map((item) => [item.label, item.type, item.checked])).toEqual([
      ["Stable", "radio", false],
      ["Preview", "radio", true],
    ]);
    channel?.submenu?.[0].click?.();
    expect(a.setChannel).toHaveBeenCalledWith("stable");
  });

  describe("setup entries", () => {
    it("offers setup when not enrolled", () => {
      const a = actions();
      const items = buildMenuTemplate(snapshotFor({ enrolled: false, setupStep: "welcome" }), a);
      find(items, "Set up Favor Printer...")?.click?.();
      expect(a.openSetup).toHaveBeenCalled();
      expect(find(items, "Pause printing")?.enabled).toBe(false);
      expect(find(items, "Test print...")?.enabled).toBe(false);
    });

    it("offers to finish an unfinished setup", () => {
      expect(find(buildMenuTemplate(snapshotFor({ setupStep: "test-print" }), actions()), "Finish setup...")).toBeDefined();
    });

    it("offers a new code from the red state and turns printing controls off", () => {
      const a = actions();
      const items = buildMenuTemplate(snapshotFor(RED), a);
      find(items, "Enter a new code...")?.click?.();
      expect(a.reenroll).toHaveBeenCalled();
      expect(find(items, "Set up Favor Printer...")).toBeUndefined();
      expect(find(items, "Pause printing")?.enabled).toBe(false);
      expect(find(items, "Test print...")?.enabled).toBe(false);
    });

    it("offers the move while the old relay runs and turns printing controls off", () => {
      const a = actions();
      const items = buildMenuTemplate(snapshotFor({ legacyRelayLoaded: true }), a);
      find(items, "Move to Favor Printer...")?.click?.();
      expect(a.migrateLegacy).toHaveBeenCalled();
      expect(find(items, "Test print...")?.enabled).toBe(false);
    });

    it("shows no setup entry for a finished setup", () => {
      const items = buildMenuTemplate(snapshotFor(), actions());
      expect(labels(items).some((label) => /set up|finish setup|new code|move to/i.test(label ?? ""))).toBe(false);
    });
  });

  it("carries no emoji and nothing but counts, states and fixed copy", () => {
    const text = JSON.stringify(buildMenuTemplate(snapshotFor({ recentJobs: { sent: 1, failed: 0, ambiguous: 0 } }), actions()));
    expect(text).not.toMatch(/\p{Extended_Pictographic}/u);
  });
});

// docs/design/tray-spec.md section 2: the menu for every `deriveStatus` outcome.
describe("menu for each status", () => {
  const relay = (overrides: Partial<RelayStatus> = {}): RelayStatus => ({
    state: "running",
    cloud: "ok",
    printerIds: ["printer-1"],
    inFlight: false,
    counts: { claimed: 0, sent: 0, failed: 0, ambiguous: 0 },
    lastJobAt: null,
    lastHeartbeatAt: null,
    lastError: null,
    ...overrides,
  });
  const inputs = (overrides: Partial<StatusInputs>): StatusInputs => ({
    enrolled: true,
    revoked: false,
    legacyRelayLoaded: false,
    relay: relay(),
    relayRestarting: false,
    printerAttached: true,
    queue: "ready",
    paused: false,
    update: { kind: "idle" },
    ...overrides,
  });

  it.each([
    ["revoked", { relay: relay({ cloud: "revoked" }) }, "Enter a new code...", "Pause printing", false],
    ["legacy", { legacyRelayLoaded: true }, "Move to Favor Printer...", "Pause printing", false],
    ["not enrolled", { enrolled: false, relay: null }, "Set up Favor Printer...", "Pause printing", false],
    ["restarting", { relayRestarting: true }, null, "Pause printing", true],
    ["no printer", { printerAttached: false }, null, "Pause printing", true],
    ["queue missing", { queue: "missing" }, null, "Pause printing", true],
    ["queue disabled", { queue: "disabled" }, null, "Pause printing", true],
    ["starting", { relay: null }, null, "Pause printing", true],
    ["unreachable", { relay: relay({ cloud: "unreachable" }) }, null, "Pause printing", true],
    ["paused", { paused: true }, null, "Resume printing", true],
    ["downloading", { update: { kind: "downloading" } }, null, "Pause printing", true],
    ["ambiguous", { relay: relay({ lastError: "send_ambiguous" }) }, null, "Pause printing", true],
    ["failed", { relay: relay({ lastError: "send_failed" }) }, null, "Pause printing", true],
    ["update ready", { update: { kind: "ready", version: "0.2.0" } }, null, "Pause printing", true],
    ["healthy", {}, null, "Pause printing", true],
  ] as Array<[string, Partial<StatusInputs>, string | null, string, boolean]>)(
    "%s",
    (_name, overrides, setupAction, printControl, canPrint) => {
      const state = inputs(overrides);
      const status = deriveStatus(state);
      const snapshot = snapshotFor({
        status,
        enrolled: state.enrolled,
        paused: state.paused,
        legacyRelayLoaded: state.legacyRelayLoaded,
        update: state.update,
      });
      const items = buildMenuTemplate(snapshot, actions());
      const header = [status.headline, ...(status.detail ? [status.detail] : [])];

      expect(labels(items).slice(0, header.length)).toEqual(header);
      expect(items.slice(0, header.length).every((item) => item.enabled === false)).toBe(true);
      expect(trayTooltip(snapshot)).toBe(`Favor Printer: ${status.headline}`);

      const firstAction = items.find((item) => item.click);
      expect(firstAction?.label).toBe(setupAction ?? printControl);
      if (setupAction) expect(firstAction?.enabled).not.toBe(false);
      expect(find(items, printControl)?.enabled).toBe(canPrint);
      expect(find(items, "Test print...")?.enabled).toBe(canPrint);
    },
  );
});

describe("createTrayView", () => {
  const icons = { green: "G", amber: "A", red: "R" } as const;

  function view() {
    const tray = { setImage: vi.fn(), setToolTip: vi.fn(), setContextMenu: vi.fn() };
    const buildMenu = vi.fn((template: MenuItemTemplate[]) => ({ template }));
    return { tray, buildMenu, view: createTrayView({ tray, icons, buildMenu, actions: actions() }) };
  }

  it("sets the icon for the status colour, the tooltip and the menu", () => {
    const { tray, view: v } = view();
    v.render(snapshotFor({ status: { color: "amber", headline: "Printing is paused", detail: null } }));
    expect(tray.setImage).toHaveBeenCalledWith("A");
    expect(tray.setToolTip).toHaveBeenCalledWith("Favor Printer: Printing is paused");
    expect(tray.setContextMenu).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["green", "G"],
    ["amber", "A"],
    ["red", "R"],
  ] as const)("uses the %s icon", (color, image) => {
    const { tray, view: v } = view();
    v.render(snapshotFor({ status: { color, headline: "x", detail: null } }));
    expect(tray.setImage).toHaveBeenCalledWith(image);
  });

  it("does not rebuild an identical menu, which would close it while open", () => {
    const { tray, buildMenu, view: v } = view();
    v.render(snapshotFor());
    v.render(snapshotFor());
    expect(buildMenu).toHaveBeenCalledTimes(1);
    expect(tray.setContextMenu).toHaveBeenCalledTimes(1);
  });

  it("rebuilds when anything shown changes", () => {
    const { buildMenu, view: v } = view();
    v.render(snapshotFor());
    v.render(snapshotFor({ recentJobs: { sent: 1, failed: 0, ambiguous: 0 } }));
    expect(buildMenu).toHaveBeenCalledTimes(2);
  });

  it("has a tooltip that names the app and the status", () => {
    expect(trayTooltip(snapshotFor())).toBe("Favor Printer: Ready to print");
  });
});

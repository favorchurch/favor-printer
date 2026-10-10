/**
 * Fixture states for `index.html?state=<name>`, served by `pnpm preview:renderer`
 * with no Electron around. The page falls back to a small in-memory API so every
 * screen can be opened and clicked through. Nothing here is real data.
 */

import type { AppSnapshot, FavorPrinterApi, PrinterDevice, SetupStep } from "../shared";
import type { LocalState } from "./model";

const ZD421: PrinterDevice = {
  id: "usb://Zebra%20Technologies/ZTC%20ZD421-203dpi%20ZPL?serial=D2J190800123",
  deviceUri: "usb://Zebra%20Technologies/ZTC%20ZD421-203dpi%20ZPL?serial=D2J190800123",
  usbSerial: "D2J190800123",
  model: "ZD421-203dpi ZPL",
};
const GK420: PrinterDevice = {
  id: "usb://Zebra%20Technologies/ZTC%20GK420d?serial=50J123456789",
  deviceUri: "usb://Zebra%20Technologies/ZTC%20GK420d?serial=50J123456789",
  usbSerial: "50J123456789",
  model: "GK420d",
};

const base: AppSnapshot = {
  version: "0.1.0",
  status: { color: "amber", headline: "Not set up yet", detail: "Enter the six-digit code from an admin." },
  enrolled: false,
  label: null,
  paused: false,
  openAtLogin: true,
  channel: "stable",
  update: { kind: "idle" },
  recentJobs: { sent: 0, failed: 0, ambiguous: 0 },
  setupStep: "welcome",
  printer: { kind: "none" },
  legacyRelayLoaded: false,
  warnings: ["Keep the lid open while printing. Closing the lid can stop labels from printing."],
};

const ready: AppSnapshot["status"] = { color: "green", headline: "Ready to print", detail: null };

const LEGACY_STATUS: AppSnapshot["status"] = {
  color: "amber",
  headline: "The old print relay is still running",
  detail: "Move to Favor Printer to start printing.",
};

const withStep = (setupStep: SetupStep | null, patch: Partial<AppSnapshot> = {}): AppSnapshot => ({ ...base, setupStep, ...patch });

export const FIXTURE_NAMES = [
  "default",
  "no-printer",
  "several-printers",
  "queue-fallback",
  "enter-code",
  "invalid-code",
  "connected",
  "test-print-confirm",
  "done",
  "revoked",
  "legacy-relay",
  "legacy-confirm",
  "legacy-failed",
  "status",
  "update-ready",
  "update-error",
] as const;
export type FixtureName = (typeof FIXTURE_NAMES)[number];

export type Fixture = {
  snapshot: AppSnapshot;
  local?: Partial<LocalState>;
  /** The mock API refuses to turn the old relay off, so the failure state can be walked through. */
  failMigration?: boolean;
};

/** Short names a capture script is likely to use, mapped to the fixture they mean. */
const ALIASES: Record<string, FixtureName> = {
  welcome: "default",
  noprinter: "no-printer",
  several: "several-printers",
  fallback: "queue-fallback",
  code: "enter-code",
  invalid: "invalid-code",
  test: "test-print-confirm",
  "test-print": "test-print-confirm",
  legacy: "legacy-relay",
  migrate: "legacy-relay",
};

/** `?state=x`, `#state=x` or `#x`. */
export function stateFromLocation(search: string, hash: string): string | null {
  const fromQuery = new URLSearchParams(search).get("state");
  if (fromQuery) return fromQuery;
  const fromHash = hash.replace(/^#/, "");
  if (!fromHash) return null;
  return new URLSearchParams(fromHash).get("state") ?? (fromHash.includes("=") ? null : fromHash);
}

export function normalizeFixtureName(name: string | null): FixtureName {
  const key = (name ?? "").trim().toLowerCase().replace(/_/g, "-");
  if ((FIXTURE_NAMES as readonly string[]).includes(key)) return key as FixtureName;
  return ALIASES[key] ?? ALIASES[key.replace(/-/g, "")] ?? "default";
}

export function fixtureFor(requested: string | null): Fixture {
  const name = normalizeFixtureName(requested);
  const oneReady: AppSnapshot["printer"] = { kind: "found", devices: [ZD421], selectedId: ZD421.id, queue: "ready" };
  const enrolled = { enrolled: true, label: "Front desk laptop", status: ready, printer: oneReady };
  switch (name) {
    case "no-printer":
      return { snapshot: withStep("printer") };
    case "several-printers":
      return { snapshot: withStep("printer", { printer: { kind: "found", devices: [ZD421, GK420], selectedId: null, queue: "missing" } }) };
    case "queue-fallback":
      return {
        snapshot: withStep("printer", { printer: { kind: "found", devices: [ZD421], selectedId: ZD421.id, queue: "missing" } }),
        local: { setUpRefused: true },
      };
    case "enter-code":
      return { snapshot: withStep("code", { printer: oneReady }) };
    case "invalid-code":
      return { snapshot: withStep("code", { printer: oneReady }), local: { codeError: "invalid_code" } };
    case "connected":
      return { snapshot: withStep("connected", enrolled) };
    case "test-print-confirm":
      return { snapshot: withStep("test-print", enrolled), local: { testPrint: { kind: "sent" } } };
    case "done":
      return { snapshot: withStep("done", enrolled) };
    case "revoked":
      return {
        snapshot: withStep(null, {
          status: { color: "red", headline: "This laptop was removed. Ask an admin for a new code.", detail: null },
          printer: oneReady,
        }),
      };
    case "legacy-relay":
      return { snapshot: withStep("welcome", { legacyRelayLoaded: true, status: LEGACY_STATUS }) };
    case "legacy-confirm":
      return {
        snapshot: withStep("welcome", { legacyRelayLoaded: true, status: LEGACY_STATUS }),
        local: { confirmingMigration: true },
      };
    case "legacy-failed":
      return {
        snapshot: withStep("welcome", { legacyRelayLoaded: true, status: LEGACY_STATUS }),
        local: { migrateError: true },
        failMigration: true,
      };
    case "status":
      return {
        snapshot: withStep(null, {
          ...enrolled,
          update: { kind: "idle" },
        }),
      };
    case "update-ready":
      return {
        snapshot: withStep(null, {
          ...enrolled,
          update: { kind: "ready", version: "0.2.0" },
        }),
      };
    case "update-error":
      return {
        snapshot: withStep(null, {
          ...enrolled,
          update: { kind: "error" },
        }),
      };
    default:
      return { snapshot: base };
  }
}

/** A stand-in for the preload API: steps move forward as they would in the app. */
export function createMockApi(start: AppSnapshot, options: { failMigration?: boolean } = {}): FavorPrinterApi {
  let snapshot = start;
  const listeners = new Set<(next: AppSnapshot) => void>();
  const set = (patch: Partial<AppSnapshot>) => {
    snapshot = { ...snapshot, ...patch };
    for (const listener of listeners) listener(snapshot);
    return snapshot;
  };
  const next: Record<string, SetupStep | null> = {
    welcome: "printer",
    printer: "code",
    code: "connected",
    connected: "test-print",
    "test-print": "done",
    done: null,
  };
  return {
    getSnapshot: async () => snapshot,
    onSnapshot(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    scanPrinters: async () => set({ printer: { kind: "found", devices: [ZD421], selectedId: ZD421.id, queue: "missing" } }),
    selectPrinter: async (deviceId) => set({ printer: { kind: "found", devices: [ZD421, GK420], selectedId: deviceId, queue: "ready" } }),
    setUpPrinter: async () => {
      set({ printer: { kind: "found", devices: [ZD421], selectedId: ZD421.id, queue: "ready" } });
      return { ok: true };
    },
    openPrinterSettings: async () => undefined,
    enroll: async (code) => {
      if (code === "000000") return { ok: false, reason: "invalid_code" };
      set({ enrolled: true, label: "Front desk laptop", status: ready });
      return { ok: true };
    },
    requestTestPrint: async () => ({ ok: true }),
    confirmTestPrint: async () => undefined,
    setPaused: async () => undefined,
    setOpenAtLogin: async () => undefined,
    setChannel: async () => undefined,
    migrateLegacyRelay: async () => {
      if (options.failMigration) return { ok: false, reason: "bootout_failed" };
      set({ legacyRelayLoaded: false, status: { color: "amber", headline: "Not set up yet", detail: "Enter the six-digit code from an admin." } });
      return { ok: true };
    },
    advance: async () => {
      const step = snapshot.setupStep;
      if (step === null) return set({ setupStep: "code" });
      return set({ setupStep: next[step] ?? null });
    },
    quit: async () => undefined,
  };
}

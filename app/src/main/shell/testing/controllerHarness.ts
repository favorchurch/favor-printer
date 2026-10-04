/** Builds an `AppController` out of fakes, with the real supervisor and prefs store. Used by tests only. */

import { vi } from "vitest";

import type { PrinterDevice, QueueState } from "../../../shared";
import type { EnrollOutcome, PrinterService, ScanOutcome, SetUpOutcome, StoredCredentials } from "../../services";
import { createFakeTimers } from "../../services/testing/fakes";
import { createAppController, type ControllerDeps } from "../controller";
import { createPrefsStore, type Prefs } from "../prefs";
import { createRelaySupervisor } from "../supervisor";
import { createForkHarness } from "./fakeChild";

export const DEVICE: PrinterDevice = {
  id: "usb://Zebra%20Technologies/ZTC%20ZD421?serial=S1",
  deviceUri: "usb://Zebra%20Technologies/ZTC%20ZD421?serial=S1",
  usbSerial: "S1",
  model: "ZD421",
};

export const NO_PRINTER: ScanOutcome = { scan: { kind: "none" }, queue: null, listFailed: false };
export const LIST_FAILED: ScanOutcome = { scan: { kind: "none" }, queue: null, listFailed: true };

export function foundPrinter(queue: QueueState = "ready", queueName = "Favor_S1"): ScanOutcome {
  return {
    scan: { kind: "found", devices: [DEVICE], selectedId: DEVICE.id, queue },
    queue: queue === "ready" ? queueName : null,
    listFailed: false,
  };
}

export const CREDENTIALS: StoredCredentials = { relayId: "relay-1", token: "tok-secret-value" };

export function memoryPrefsFs(initial?: Partial<Prefs>) {
  let content: string | null = initial ? JSON.stringify(initial) : null;
  return {
    fs: {
      read: async () => content,
      write: async (_file: string, data: string) => {
        content = data;
      },
    },
    saved: (): Partial<Prefs> | null => (content === null ? null : (JSON.parse(content) as Partial<Prefs>)),
  };
}

export type HarnessOptions = {
  prefs?: Partial<Prefs>;
  credentials?: StoredCredentials | null;
  scan?: ScanOutcome;
  legacyLoaded?: boolean;
  enroll?: () => Promise<EnrollOutcome>;
  setUp?: () => Promise<SetUpOutcome>;
};

export function createControllerHarness(options: HarnessOptions = {}) {
  const prefsFs = memoryPrefsFs(options.prefs);
  const prefs = createPrefsStore({ file: "/prefs.json", fs: prefsFs.fs });
  let credentials = options.credentials ?? null;
  const secrets = {
    load: vi.fn(async () => credentials),
    save: vi.fn(async (next: StoredCredentials) => {
      credentials = next;
    }),
    clear: vi.fn(async () => {
      credentials = null;
    }),
  };

  let legacyLoaded = options.legacyLoaded ?? false;
  const legacy = {
    detect: vi.fn(async () => ({ plistPresent: legacyLoaded, loaded: legacyLoaded })),
    migrate: vi.fn(async () => {
      legacyLoaded = false;
      return { ok: true } as const;
    }),
    canStartRelay: vi.fn(async () => (legacyLoaded ? ({ allowed: false, reason: "legacy_loaded" } as const) : ({ allowed: true } as const))),
  };

  const state = { scan: options.scan ?? NO_PRINTER };
  const printers: PrinterService = {
    scan: vi.fn(async () => state.scan),
    setUp: vi.fn(options.setUp ?? (async () => ({ ok: true, queue: "Favor_S1" }) as SetUpOutcome)),
  };

  const enroll = vi.fn(
    options.enroll ?? (async () => ({ ok: true, credentials: { ...CREDENTIALS, label: "Front desk" } }) as EnrollOutcome),
  );

  const forks = createForkHarness();
  const timers = createFakeTimers();
  const power = { update: vi.fn(), dispose: vi.fn() };
  const updates = { setChannel: vi.fn(async () => undefined), checkNow: vi.fn(async () => undefined) };
  const ui = {
    showSetupWindow: vi.fn(),
    closeSetupWindow: vi.fn(),
    askLabelCameOut: vi.fn(async () => true),
    openPrinterSettings: vi.fn(async () => undefined),
  };
  const applyOpenAtLogin = vi.fn();
  const logLines: string[] = [];

  const deps: ControllerDeps = {
    version: "0.1.0",
    osVersion: "macOS 15",
    appSupportDir: "/Users/v/Library/Application Support/Favor Printer",
    prefs,
    secrets,
    printers,
    legacy,
    enroll,
    createSupervisor: (hooks) =>
      createRelaySupervisor({
        fork: forks.fork,
        timers: timers.timers,
        tuning: { stopWaitMs: 100, inFlightCeilingMs: 300, testPrintTimeoutMs: 700, healthyAfterMs: 5_000 },
        ...hooks,
      }),
    power,
    updates,
    ui,
    applyOpenAtLogin,
    log: (level, scope, message) => void logLines.push(`${level} ${scope} ${message}`),
    timers: timers.timers,
  };
  const controller = createAppController(deps);

  return { controller, prefsFs, prefs, secrets, legacy, printers, state, enroll, forks, timers, power, updates, ui, applyOpenAtLogin, logLines };
}

export type ControllerHarness = ReturnType<typeof createControllerHarness>;

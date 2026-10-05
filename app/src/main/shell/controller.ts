/**
 * The app's brain. It owns the state the tray and the setup window show, runs
 * the actions the window asks for, and keeps the relay supervisor, the power
 * hold and the printer scan in step. Everything it touches arrives through
 * `ControllerDeps`, so tests drive it without Electron.
 */

import {
  isEnrollmentCode,
  isUpdateChannel,
  type AppSnapshot,
  type EnrollResult,
  type MigrateLegacyResult,
  type PrinterDevice,
  type PrinterScan,
  type SetUpPrinterResult,
  type SetupStep,
  type TestPrintResult,
  type UpdateChannel,
  type UpdateState,
} from "../../shared";
import type { RelayStatus } from "../../../../vendor/relay/status";
import {
  deriveStatus,
  powerWarnings,
  recentJobs,
  type EnrollOutcome,
  type EnrollRequest,
  type LegacyRelay,
  type PowerController,
  type PrinterService,
  type SecretStore,
  type Timers,
} from "../services";
import { systemTimers } from "../services";
import type { Logger } from "./log";
import type { PrefsStore } from "./prefs";
import { advanceStep, initialStep, printerReady } from "./setupFlow";
import { createStartResolver } from "./startGate";
import type { RelaySupervisor, StartResolution, StopOutcome, SupervisorState } from "./supervisor";

export const SCAN_INTERVAL_MS = 30_000;

export type SupervisorFactory = (hooks: {
  resolveStart: () => Promise<StartResolution>;
  onChange: (state: SupervisorState) => void;
  onRelayStatus: (status: RelayStatus) => void;
}) => RelaySupervisor;

export type ControllerDeps = {
  version: string;
  osVersion: string;
  appSupportDir: string;
  apiUrl?: string;
  prefs: PrefsStore;
  secrets: SecretStore;
  printers: PrinterService;
  legacy: LegacyRelay;
  enroll(request: EnrollRequest): Promise<EnrollOutcome>;
  createSupervisor: SupervisorFactory;
  power: Pick<PowerController, "update" | "dispose">;
  updates: { setChannel(channel: UpdateChannel): Promise<void>; checkNow(): Promise<void> };
  ui: {
    /** Brings the setup window to the front. */
    showSetupWindow(): void;
    closeSetupWindow(): void;
    /** "Did a label come out?" for a test print started from the menu. */
    askLabelCameOut(): Promise<boolean>;
    openPrinterSettings(): Promise<void>;
  };
  applyOpenAtLogin(enabled: boolean): void;
  log: Logger;
  timers?: Timers;
};

export type PowerContext = { onBattery?: boolean; asleep?: boolean; locked?: boolean };

export type AppController = {
  initialize(): Promise<void>;
  snapshot(): AppSnapshot;
  subscribe(listener: (snapshot: AppSnapshot) => void): () => void;

  scanPrinters(): Promise<AppSnapshot>;
  selectPrinter(deviceId: string): Promise<AppSnapshot>;
  setUpPrinter(): Promise<SetUpPrinterResult>;
  openPrinterSettings(): Promise<void>;
  enroll(code: string): Promise<EnrollResult>;
  requestTestPrint(): Promise<TestPrintResult>;
  confirmTestPrint(labelCameOut: boolean): Promise<void>;
  setPaused(paused: boolean): Promise<void>;
  setOpenAtLogin(enabled: boolean): Promise<void>;
  setChannel(channel: UpdateChannel): Promise<void>;
  migrateLegacyRelay(): Promise<MigrateLegacyResult>;
  advance(): Promise<AppSnapshot>;

  /** Menu actions that combine a request with the confirmation question. */
  testPrintFromMenu(): Promise<void>;
  beginReenroll(): void;
  openSetup(): void;

  setUpdateState(state: UpdateState): void;
  setPowerContext(context: PowerContext): void;
  /** Re-reads the printer and the legacy agent. Call after wake or unlock. */
  refresh(): Promise<void>;
  /** Stops the relay for quit. `jobInFlight` says whether a send was still writing. */
  shutdown(): Promise<{ outcome: StopOutcome; jobInFlight: boolean }>;
  jobInFlight(): boolean;
  /** Resolves when the relay has stopped or exited. */
  settled(): Promise<void>;
};

/** Shown under the status while the old relay could not be turned off. Printing stays off. */
export const LEGACY_FAILED_DETAIL = "The old relay could not be turned off. Printing stays off. Ask an admin for help.";

const ASLEEP_WARNING = "This Mac went to sleep. Labels wait until it wakes.";
const LOCKED_WARNING = "The screen is locked. Keep the lid open so printing is not interrupted.";

export function createAppController(deps: ControllerDeps): AppController {
  const { prefs, secrets, printers, legacy, log } = deps;
  const timers = deps.timers ?? systemTimers;

  let enrolled = false;
  let legacyLoaded = false;
  let scan: PrinterScan = { kind: "none" };
  let liveQueue: string | null = null;
  /** The last `lpinfo` listing failed, so "no printer" may mean "could not look". */
  let scanFailed = false;
  let printerAttached = false;
  let paused = false;
  let update: UpdateState = { kind: "idle" };
  let setupStep: SetupStep | null = null;
  let testPrintConfirmed = false;
  let power: PowerContext = {};
  let scanning: Promise<void> | null = null;
  let enrolling: Promise<EnrollResult> | null = null;
  let scanTimer: unknown = null;
  let supervisorState: SupervisorState = {
    phase: "idle",
    blockedReason: null,
    restarts: 0,
    lastExitCode: null,
    lastErrorCode: null,
    relay: null,
  };
  const listeners = new Set<(snapshot: AppSnapshot) => void>();

  /**
   * The queue the relay prints to. With a printer attached, only a ready queue bound to that printer
   * counts: a remembered name could now belong to another device. The remembered queue is used only
   * when a scan found the printer absent, so the relay can start offline and report "no printer".
   * A scan that failed says nothing, so it does not unlock the remembered queue either.
   */
  const queueForRelay = (): string | null => {
    if (scan.kind === "found" || scanFailed) return liveQueue;
    return liveQueue ?? prefs.get().queue;
  };

  /** The queue the running relay was started with. The relay cannot change it, so a different one means a restart. */
  let startedQueue: string | null = null;
  /** The relay was stopped because the printer is attached with no ready queue; it starts again when one appears. */
  let relayHeldForQueue = false;

  const resolveRelayStart = createStartResolver({
    isRevoked: () => prefs.get().revoked,
    secrets,
    legacy,
    queue: queueForRelay,
    printerAttached: () => printerAttached,
    appSupportDir: deps.appSupportDir,
    appVersion: deps.version,
    osVersion: deps.osVersion,
    apiUrl: deps.apiUrl,
  });

  const supervisor = deps.createSupervisor({
    resolveStart: async () => {
      const resolution = await resolveRelayStart();
      if (resolution.ok) {
        relayHeldForQueue = false;
        startedQueue = resolution.options.transport.kind === "cups" ? resolution.options.transport.queue : null;
      }
      return resolution;
    },
    onChange: (state) => {
      supervisorState = state;
      emit();
    },
    onRelayStatus: (status) => {
      if (status.cloud === "revoked") void handleRevoked();
      updatePower();
    },
  });

  const selectedDevice = (): PrinterDevice | null => {
    const current = scan;
    return current.kind === "found" ? (current.devices.find((device) => device.id === current.selectedId) ?? null) : null;
  };

  const snapshot = (): AppSnapshot => {
    const current = prefs.get();
    const relay = supervisorState.relay;
    const derived = deriveStatus({
      enrolled,
      revoked: current.revoked,
      legacyRelayLoaded: legacyLoaded,
      relay,
      relayRestarting: supervisorState.phase === "restarting",
      printerAttached,
      queue: scan.kind === "found" ? scan.queue : "ready",
      paused,
      update,
    });
    const status = legacyLoaded && migrationFailed && derived.color !== "red" ? { ...derived, detail: LEGACY_FAILED_DETAIL } : derived;
    const warnings = powerWarnings({ onBattery: power.onBattery === true });
    if (power.asleep) warnings.push(ASLEEP_WARNING);
    if (power.locked) warnings.push(LOCKED_WARNING);
    return {
      version: deps.version,
      status,
      enrolled,
      label: current.label,
      paused,
      openAtLogin: current.openAtLogin ?? true,
      channel: current.channel,
      update,
      recentJobs: recentJobs(relay),
      setupStep,
      printer: scan,
      legacyRelayLoaded: legacyLoaded,
      warnings,
    };
  };

  function emit() {
    const next = snapshot();
    for (const listener of listeners) listener(next);
  }

  function updatePower() {
    // After shutdown the hold is released for good: a status event from a send that was still
    // finishing must not take it again while the app quits.
    if (shuttingDown) return;
    deps.power.update({ printerAttached, lastJobAt: supervisorState.relay?.lastJobAt ?? null });
  }

  const setStep = (step: SetupStep | null) => {
    const previous = setupStep;
    setupStep = step;
    if (step === null && previous !== null) {
      void prefs.update({ setupComplete: true }).catch(() => undefined);
      deps.ui.closeSetupWindow();
    }
  };

  /** The last move off the old relay failed. The relay stays blocked and this is shown until one succeeds. */
  let migrationFailed = false;
  let migrating: Promise<MigrateLegacyResult> | null = null;
  let shuttingDown = false;
  let revoking = false;
  async function handleRevoked() {
    // The relay can report the revocation more than once while this is still saving.
    if (revoking || prefs.get().revoked) return;
    revoking = true;
    log("warn", "cloud", "the cloud rejected this laptop's credentials");
    await prefs.update({ revoked: true }).catch(() => undefined);
    enrolled = false;
    // The token is dead: do not keep it, and stop the relay asking with it.
    await secrets.clear().catch(() => undefined);
    await supervisor.stop();
    if (setupStep !== null) setupStep = "code";
    revoking = false;
    emit();
  }

  async function runScan(): Promise<void> {
    const outcome = await printers.scan(prefs.get().selectedPrinterId);
    scan = outcome.scan;
    scanFailed = outcome.listFailed;
    // A failed listing says nothing about the queue, so the last answer stands.
    if (!outcome.listFailed) liveQueue = outcome.queue;

    const patch: { selectedPrinterId?: string; queue?: string | null } = {};
    if (outcome.scan.kind === "found" && outcome.scan.selectedId && outcome.scan.selectedId !== prefs.get().selectedPrinterId) {
      patch.selectedPrinterId = outcome.scan.selectedId;
    }
    // The printer is here: its ready queue is the one to remember, and no ready queue means the
    // remembered one is stale, so forget it.
    if (outcome.scan.kind === "found" && outcome.queue !== prefs.get().queue) patch.queue = outcome.queue;
    if (Object.keys(patch).length > 0) await prefs.update(patch).catch(() => undefined);

    // A failed `lpinfo` says nothing about the printer, so it never flips the flag.
    if (!outcome.listFailed) {
      const attached = outcome.scan.kind === "found";
      if (attached !== printerAttached) {
        printerAttached = attached;
        supervisor.setPrinterAttached(attached);
      }
    }
    updatePower();

    // A successful scan says what the selected printer's queue is now. The running relay keeps the
    // queue it started with, and that name may now belong to another printer, so make them agree.
    if (!outcome.listFailed && outcome.scan.kind === "found" && !shuttingDown && enrolled) {
      const active = ["starting", "running", "restarting"].includes(supervisorState.phase);
      if (active && !liveQueue) {
        log("warn", "printer", "the printer has no ready queue; stopping the relay until it does");
        relayHeldForQueue = true;
        await supervisor.stop();
      } else if (active && liveQueue !== startedQueue) {
        log("info", "printer", "the printer's queue changed; restarting the relay");
        await supervisor.restart();
      }
    }

    // The relay could not start without a queue, or was held until it had one; it can now.
    const waitingForQueue =
      relayHeldForQueue || (supervisorState.phase === "blocked" && supervisorState.blockedReason === "no_queue");
    if (!shuttingDown && enrolled && waitingForQueue && queueForRelay()) {
      await supervisor.start();
    }
    emit();
  }

  function scanOnce(): Promise<void> {
    scanning ??= runScan()
      .catch((error) => log("warn", "printer", `scan failed: ${error instanceof Error ? error.name : "error"}`))
      .finally(() => {
        scanning = null;
      });
    return scanning;
  }

  /** A failed move counts as "still loaded" until one succeeds, even if launchd no longer lists the label. */
  async function refreshLegacy() {
    legacyLoaded = (await legacy.detect()).loaded || migrationFailed;
  }

  const flowContext = () => ({
    legacyLoaded,
    step: setupStep,
    printerReady: printerReady(scan),
    enrolled,
    revoked: prefs.get().revoked,
    cloudOk: supervisorState.relay?.cloud === "ok",
    testPrintConfirmed,
  });

  const controller: AppController = {
    async initialize() {
      const loaded = await prefs.load();
      if (loaded.openAtLogin === null) {
        // First run: open at login unless the volunteer turns it off.
        await prefs.update({ openAtLogin: true }).catch(() => undefined);
        deps.applyOpenAtLogin(true);
      }
      enrolled = (await secrets.load()) !== null && !prefs.get().revoked;
      await refreshLegacy();
      setupStep = initialStep({ enrolled, revoked: prefs.get().revoked, setupComplete: prefs.get().setupComplete });
      await scanOnce();
      if (enrolled) await supervisor.start();
      scanTimer ??= timers.setInterval(() => void scanOnce(), SCAN_INTERVAL_MS);
      emit();
    },

    snapshot,

    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },

    async scanPrinters() {
      await scanOnce();
      return snapshot();
    },

    async selectPrinter(deviceId) {
      if (scan.kind === "found" && scan.devices.some((device) => device.id === deviceId)) {
        await prefs.update({ selectedPrinterId: deviceId }).catch(() => undefined);
        await scanOnce();
      }
      return snapshot();
    },

    async setUpPrinter() {
      const device = selectedDevice();
      if (!device) return { ok: false, reason: "failed" };
      const outcome = await printers.setUp(device);
      await scanOnce();
      if (!outcome.ok) return { ok: false, reason: outcome.reason };
      return { ok: true };
    },

    openPrinterSettings: () => deps.ui.openPrinterSettings(),

    enroll(code) {
      if (enrolling) return enrolling;
      enrolling = (async (): Promise<EnrollResult> => {
        if (!isEnrollmentCode(code)) return { ok: false, reason: "invalid_code" };
        const outcome = await deps.enroll({
          apiUrl: deps.apiUrl ?? "https://rsvp.favor.church",
          code,
          usbSerial: selectedDevice()?.usbSerial ?? null,
          appVersion: deps.version,
          osVersion: deps.osVersion,
        });
        if (!outcome.ok) return { ok: false, reason: outcome.reason };
        try {
          await secrets.save({ relayId: outcome.credentials.relayId, token: outcome.credentials.token });
        } catch (error) {
          // The token is not kept anywhere, so enrolling cannot finish. The error never carries it.
          log("error", "enroll", `could not save credentials: ${error instanceof Error ? error.name : "error"}`);
          return { ok: false, reason: "disabled" };
        }
        await prefs.update({ label: outcome.credentials.label, revoked: false }).catch(() => undefined);
        enrolled = true;
        testPrintConfirmed = false;
        setupStep = "connected";
        await supervisor.restart();
        emit();
        return { ok: true };
      })().finally(() => {
        enrolling = null;
      });
      return enrolling;
    },

    async requestTestPrint() {
      if (paused) return { ok: false, reason: "paused" };
      const relay = supervisorState.relay;
      const printerId = relay?.printerIds[0];
      if (!relay || !printerId) return { ok: false, reason: "no_printer" };
      const reply = await supervisor.testPrint(printerId);
      if (reply.ok) return { ok: true };
      switch (reply.error) {
        case "paused":
          return { ok: false, reason: "paused" };
        case "busy":
          return { ok: false, reason: "busy" };
        case "unknown_printer":
          return { ok: false, reason: "no_printer" };
        case "printer_unavailable":
          return { ok: false, reason: "printer_not_enabled" };
        default:
          return { ok: false, reason: "failed" };
      }
    },

    async confirmTestPrint(labelCameOut) {
      testPrintConfirmed = labelCameOut;
      emit();
    },

    async testPrintFromMenu() {
      const result = await controller.requestTestPrint();
      if (!result.ok) {
        deps.ui.showSetupWindow();
        return;
      }
      await controller.confirmTestPrint(await deps.ui.askLabelCameOut());
    },

    async setPaused(next) {
      paused = next;
      if (next) supervisor.pause();
      else supervisor.resume();
      emit();
    },

    async setOpenAtLogin(enabled) {
      await prefs.update({ openAtLogin: enabled });
      deps.applyOpenAtLogin(enabled);
      emit();
    },

    async setChannel(channel) {
      if (!isUpdateChannel(channel)) return;
      await prefs.update({ channel });
      emit();
      await deps.updates.setChannel(channel);
    },

    migrateLegacyRelay() {
      if (migrating) return migrating;
      migrating = (async (): Promise<MigrateLegacyResult> => {
        // Nothing to move: do not run launchctl for no reason.
        if (!legacyLoaded) return { ok: true };

        let result: MigrateLegacyResult;
        try {
          result = await legacy.migrate();
          // Trust launchd, not the exit codes: the label must really be gone before anything else happens.
          legacyLoaded = (await legacy.detect()).loaded;
          if (result.ok && legacyLoaded) result = { ok: false, reason: "bootout_failed" };
        } catch (error) {
          log("error", "legacy", `could not move off the old relay: ${error instanceof Error ? error.name : "error"}`);
          result = { ok: false, reason: "bootout_failed" };
        }

        migrationFailed = !result.ok;
        // Fail closed: after any failure the old relay counts as still running, so ours stays blocked.
        if (!result.ok) legacyLoaded = true;
        else if (enrolled && !prefs.get().revoked) await supervisor.start();
        emit();
        return result;
      })().finally(() => {
        migrating = null;
      });
      return migrating;
    },

    async advance() {
      const next = advanceStep(flowContext());
      if (next === "printer") await scanOnce();
      setStep(next);
      emit();
      return snapshot();
    },

    beginReenroll() {
      setupStep = "code";
      emit();
      deps.ui.showSetupWindow();
    },

    openSetup() {
      deps.ui.showSetupWindow();
    },

    setUpdateState(state) {
      update = state;
      emit();
    },

    setPowerContext(context) {
      power = { ...power, ...context };
      emit();
    },

    async refresh() {
      await refreshLegacy();
      await scanOnce();
      emit();
    },

    async shutdown() {
      shuttingDown = true;
      if (scanTimer !== null) timers.clearInterval(scanTimer);
      scanTimer = null;
      deps.power.dispose();
      const outcome = await supervisor.stop();
      return { outcome, jobInFlight: supervisor.jobInFlight() };
    },

    jobInFlight: () => supervisor.jobInFlight(),

    settled: () => supervisor.settled(),
  };
  return controller;
}

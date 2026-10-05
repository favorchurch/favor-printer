/**
 * Privacy: attendee names, ZPL and security codes must never reach the renderer's state, an IPC payload,
 * the tray menu, the recent-job counts or a log line. Each test seeds those values into a flow where the
 * relay or the updater could carry them (job events, relay output, test prints, errors) and then checks
 * everything the outside world can see. The seeds are put where they should not be, on purpose: in extra
 * fields, in fields that should hold a count or a code, and in free text.
 */

import { describe, expect, it, vi } from "vitest";

import { IPC_CHANNELS, type AppSnapshot } from "../../shared";
import { createUpdateController } from "../services";
import { createFakeTimers } from "../services/testing/fakes";
import {
  apiFromController,
  handlersFor,
  registerIpcHandlers,
  type IpcEventLike,
  type IpcMainLike,
} from "./ipc";
import { createLogger } from "./log";
import { createRelaySupervisor } from "./supervisor";
import {
  CREDENTIALS,
  createControllerHarness,
  DEVICE,
  foundPrinter,
  type ControllerHarness,
} from "./testing/controllerHarness";
import { createForkHarness, relayStatus } from "./testing/fakeChild";
import { buildMenuTemplate, type TrayActions } from "./tray";
import { createUpdaterAdapter, type AutoUpdaterLike } from "./updaterAdapter";

const NAME = "Jane Q. Attendee";
const NAME_2 = "Zoë O'Brien-Nguyen";
const CODE = "483920";
const CODE_2 = "SEC-7F3A9C1D";
const ZPL = `^XA^CF0,60^FO50,50^FD${NAME}^FS^FO50,120^FD${NAME_2}^FS^FO50,200^BCN,100,Y,N,N^FD${CODE}^FS^XZ`;

/** Anything in here showing up in an output is a leak. */
const SEEDS = [NAME, "Jane", "Attendee", NAME_2, "Zoë", "O'Brien", CODE, CODE_2, "7F3A9C1D", ZPL, "^XA", "^XZ", "^FD", "^FO", "^BCN"];

type Surface = Record<string, unknown>;

function leaks(surface: Surface): string[] {
  const found: string[] = [];
  for (const [where, value] of Object.entries(surface)) {
    const text = JSON.stringify(value) ?? "";
    for (const seed of SEEDS) if (text.includes(seed)) found.push(`${where}: ${JSON.stringify(seed)}`);
  }
  return found;
}

const expectClean = (surface: Surface) => expect(leaks(surface)).toEqual([]);

const NO_ACTIONS: TrayActions = {
  pause: () => undefined,
  resume: () => undefined,
  testPrint: () => undefined,
  openSetup: () => undefined,
  reenroll: () => undefined,
  migrateLegacy: () => undefined,
  setOpenAtLogin: () => undefined,
  checkForUpdates: () => undefined,
  setChannel: () => undefined,
  quit: () => undefined,
};

/** The production handlers, behind a fake ipcMain: what the renderer can actually call and read back. */
function ipcFor(controller: ControllerHarness["controller"]) {
  const registered = new Map<string, (event: IpcEventLike, ...args: unknown[]) => unknown>();
  const ipcMain: IpcMainLike = {
    handle: (channel, listener) => void registered.set(channel, listener),
    removeHandler: () => undefined,
  };
  registerIpcHandlers({
    ipcMain,
    handlers: handlersFor(apiFromController(controller, async () => undefined)),
    isTrusted: () => true,
  });
  const event: IpcEventLike = { sender: { id: 1 }, senderFrame: { url: "file:///app/dist/renderer/index.html" } };
  return (channel: string, ...args: unknown[]) => {
    const handler = registered.get(channel);
    if (!handler) throw new Error(`no handler for ${channel}`);
    return Promise.resolve(handler(event, ...args));
  };
}

async function setup() {
  const h = createControllerHarness({
    credentials: CREDENTIALS,
    scan: foundPrinter(),
    prefs: { openAtLogin: true, setupComplete: true },
  });
  const pushed: AppSnapshot[] = [];
  h.controller.subscribe((snapshot) => pushed.push(snapshot));
  await h.controller.initialize();
  const invoke = ipcFor(h.controller);
  const child = () => h.forks.last();
  return { h, pushed, invoke, child };
}

type Context = Awaited<ReturnType<typeof setup>>;

/** Calls every channel that answers at once, then gathers everything an outsider could see. */
async function surface(ctx: Context, extraIpc: unknown[] = []): Promise<Surface> {
  const ipc: unknown[] = [...extraIpc];
  const calls: [string, ...unknown[]][] = [
    [IPC_CHANNELS.getSnapshot],
    [IPC_CHANNELS.scanPrinters],
    [IPC_CHANNELS.selectPrinter, DEVICE.id],
    [IPC_CHANNELS.setUpPrinter],
    [IPC_CHANNELS.openPrinterSettings],
    [IPC_CHANNELS.enroll, "abc"],
    [IPC_CHANNELS.confirmTestPrint, true],
    [IPC_CHANNELS.setPaused, false],
    [IPC_CHANNELS.setOpenAtLogin, true],
    [IPC_CHANNELS.setChannel, "stable"],
    [IPC_CHANNELS.migrateLegacyRelay],
    [IPC_CHANNELS.advance],
  ];
  for (const [channel, ...args] of calls) ipc.push(await ctx.invoke(channel, ...args));

  const snapshots = [...ctx.pushed, ctx.h.controller.snapshot()];
  return {
    "renderer state (pushed snapshots)": snapshots,
    "ipc payloads": ipc,
    "tray menus": snapshots.map((snapshot) => buildMenuTemplate(snapshot, NO_ACTIONS)),
    "recent-job state": snapshots.map((snapshot) => snapshot.recentJobs),
    logs: ctx.h.logLines,
  };
}

const RELAY_LOG = (level: string, message: string) => `2026-10-04T00:00:00.000Z [relay] ${level} ${message}`;

/** A status event with the seeds in extra fields. */
const hostile = (patch: Record<string, unknown> = {}) => ({
  ...relayStatus({ counts: { claimed: 4, sent: 2, failed: 1, ambiguous: 1 }, lastJobAt: "2026-10-04T01:00:00.000Z" }),
  attendeeName: NAME,
  attendees: [NAME, NAME_2],
  zpl: ZPL,
  securityCode: CODE,
  label: { name: NAME, zpl: ZPL, securityCode: CODE_2 },
  ...patch,
});

describe("the checker", () => {
  it("fails when a seed is present, so a clean result means something", () => {
    expect(leaks({ "ipc payloads": [{ label: NAME }] }).length).toBeGreaterThan(0);
    expect(leaks({ logs: [`failed ${ZPL}`] }).length).toBeGreaterThan(0);
    expect(leaks({ x: { code: CODE } })).toEqual(['x: "483920"']);
    expect(leaks({ x: { fine: "Ready to print" } })).toEqual([]);
  });
});

describe("a print flow that carries names, ZPL and codes", () => {
  it("keeps them out of the renderer, IPC, the tray, recent jobs and the log", async () => {
    const ctx = await setup();
    const { child } = ctx;

    // Job events: claimed, sending, sent, ambiguous, failed. Every one carries the seeds in extra fields.
    child().emitMessage({ type: "event", event: hostile({ counts: { claimed: 1, sent: 0, failed: 0, ambiguous: 0 }, inFlight: true }) });
    child().emitMessage({ type: "event", event: hostile({ counts: { claimed: 2, sent: 1, failed: 0, ambiguous: 0 } }) });
    child().emitMessage({
      type: "event",
      event: hostile({ counts: { claimed: 3, sent: 1, failed: 0, ambiguous: 1 }, lastError: `lp failed after the write began: ${ZPL} for ${NAME}` }),
    });
    child().emitMessage({ type: "event", event: hostile({ counts: { claimed: 4, sent: 2, failed: 1, ambiguous: 1 }, lastError: "send_failed" }) });

    // The relay's own output, which is free text.
    child().emitStdout(RELAY_LOG("info", `claimed job {"jobId":"j-1","printerId":"p-1","name":"${NAME}"}\n`));
    child().emitStdout(RELAY_LOG("warn", `job 6f1c-9a will be retried: lp failed: ${ZPL}\n`));
    child().emitStdout(RELAY_LOG("error", `cycle failed: ${NAME} security code ${CODE}\n`));
    child().emitStdout(`${ZPL}\n${NAME_2} ${CODE_2}\n`);
    child().emitStderr(`Error: could not print ${NAME} (${CODE_2})\n${ZPL}\n`);

    const result = await surface(ctx);
    expectClean(result);

    // The flow really ran: counts arrived, and relay output was logged only as fixed phrases.
    expect(ctx.h.controller.snapshot().recentJobs).toEqual({ sent: 2, failed: 1, ambiguous: 1 });
    const logs = ctx.h.logLines.join("\n");
    expect(logs).toContain("claimed job");
    expect(logs).toContain("job will be retried");
    expect(logs).toContain("cycle failed");
    expect(logs).toContain("output withheld");
  });

  it("shows recent jobs as three numbers and nothing else", async () => {
    const ctx = await setup();
    ctx.child().emitMessage({ type: "event", event: hostile() });
    for (const snapshot of [...ctx.pushed, ctx.h.controller.snapshot()]) {
      expect(Object.keys(snapshot.recentJobs).sort()).toEqual(["ambiguous", "failed", "sent"]);
      for (const value of Object.values(snapshot.recentJobs)) expect(Number.isSafeInteger(value)).toBe(true);
    }
    expectClean(await surface(ctx));
  });

  it("turns text in a count, time, code or id field into a safe value", async () => {
    const ctx = await setup();
    ctx.child().emitMessage({
      type: "event",
      event: hostile({
        counts: { claimed: NAME, sent: ZPL, failed: { name: NAME }, ambiguous: [CODE] },
        lastJobAt: `${NAME} at 2026-10-04T01:00:00.000Z`,
        lastHeartbeatAt: ZPL,
        lastError: `failed for ${NAME}`,
        printerIds: ["printer-1", NAME, ZPL],
      }),
    });
    expect(ctx.h.controller.snapshot().recentJobs).toEqual({ sent: 0, failed: 0, ambiguous: 0 });
    expectClean(await surface(ctx));
  });

  it.each(["state", "cloud", "printerIds", "inFlight", "counts", "lastJobAt", "lastHeartbeatAt", "lastError"])(
    "keeps seeds out when %s is replaced by each kind of hostile value",
    async (field) => {
      const ctx = await setup();
      const values: unknown[] = [
        NAME,
        ZPL,
        CODE,
        { name: NAME, zpl: ZPL },
        [NAME, ZPL, CODE_2],
        { claimed: NAME, sent: ZPL, failed: { n: NAME }, ambiguous: [CODE] },
      ];
      for (const value of values) {
        ctx.child().emitMessage({ type: "event", event: { ...relayStatus(), [field]: value } });
      }
      expectClean(await surface(ctx));
    },
  );
});

describe("a test print flow that carries names, ZPL and codes", () => {
  async function withPrinter() {
    const ctx = await setup();
    ctx.child().emitMessage({ type: "event", event: hostile() });
    return ctx;
  }

  const waitForTestPrint = (ctx: Context) =>
    vi.waitFor(() => expect(ctx.child().messages.at(-1)).toMatchObject({ type: "testPrint", printerId: "printer-1" }));

  it("answers a failed test print with a fixed reason, whatever text the relay sent", async () => {
    const ctx = await withPrinter();
    const pending = ctx.invoke(IPC_CHANNELS.requestTestPrint);
    await waitForTestPrint(ctx);
    ctx.child().emitMessage({
      type: "testPrintResult",
      printerId: "printer-1",
      ok: false,
      error: `lp failed for ${NAME}: ${ZPL} (${CODE})`,
      transportOutcome: NAME,
      name: NAME,
      zpl: ZPL,
      securityCode: CODE_2,
    });
    const reply = await pending;

    expect(reply).toEqual({ ok: false, reason: "failed" });
    expectClean(await surface(ctx, [reply]));
  });

  it("answers a successful test print with ok and nothing else", async () => {
    const ctx = await withPrinter();
    const pending = ctx.invoke(IPC_CHANNELS.requestTestPrint);
    await waitForTestPrint(ctx);
    ctx.child().emitMessage({
      type: "testPrintResult",
      printerId: "printer-1",
      ok: true,
      transportOutcome: "sent",
      zpl: ZPL,
      name: NAME,
      securityCode: CODE,
    });
    const reply = await pending;

    expect(reply).toEqual({ ok: true });
    expectClean(await surface(ctx, [reply]));
  });

  it("passes the relay's own fixed refusals through as fixed reasons", async () => {
    const ctx = await withPrinter();
    const pending = ctx.invoke(IPC_CHANNELS.requestTestPrint);
    await waitForTestPrint(ctx);
    ctx.child().emitMessage({ type: "testPrintResult", printerId: "printer-1", ok: false, error: "busy", name: NAME });
    await expect(pending).resolves.toEqual({ ok: false, reason: "busy" });
  });

  it("is clean when the test print times out or the relay dies mid-print", async () => {
    const ctx = await withPrinter();
    const pending = ctx.invoke(IPC_CHANNELS.requestTestPrint);
    await waitForTestPrint(ctx);
    ctx.child().emitStdout(RELAY_LOG("error", `unexpected failure: ${ZPL}\n`));
    ctx.child().emitExit(1);
    const reply = await pending;
    expectClean(await surface(ctx, [reply]));
  });
});

describe("errors from the relay and the supervisor", () => {
  it("logs and shows only the fixed error codes", async () => {
    const ctx = await setup();
    const { child } = ctx;
    for (const code of [NAME, ZPL, CODE, `${NAME} ${ZPL}`, { name: NAME }, [ZPL], undefined]) {
      child().emitMessage({ type: "error", code });
    }
    child().emitMessage({ type: "error", code: "spool_locked" });
    child().emitMessage({ type: "bogus", name: NAME, zpl: ZPL });
    child().emitMessage({ type: "event", event: hostile({ lastError: "spool_locked" }) });

    const result = await surface(ctx);
    expectClean(result);
    const logs = ctx.h.logLines.join("\n");
    expect(logs).toContain("relay reported unexpected");
    expect(logs).toContain("relay reported spool_locked");
  });

  it("is clean when the relay crashes and restarts after printing", async () => {
    const ctx = await setup();
    ctx.child().emitMessage({ type: "event", event: hostile() });
    ctx.child().emitStdout(RELAY_LOG("error", `cycle failed: ${ZPL} ${NAME}\n`));
    ctx.child().emitExit(1);
    expectClean(await surface(ctx));
    expect(ctx.h.logLines.join("\n")).toContain("relay exited");
  });

  it("keeps the supervisor's own state and log clean, through the real logger too", async () => {
    const lines: string[] = [];
    const log = createLogger((line) => void lines.push(line));
    const forks = createForkHarness();
    const supervisor = createRelaySupervisor({
      fork: forks.fork,
      log,
      timers: createFakeTimers().timers,
      resolveStart: async () => ({
        ok: true,
        options: {
          apiUrl: "https://rsvp.favor.church",
          relayId: "relay-1",
          token: "tok-secret-value",
          spoolDir: "/tmp/spool",
          transport: { kind: "cups", queue: "Favor_S1" },
          appVersion: "0.1.0",
          osVersion: "macOS 15",
        },
      }),
    });
    await supervisor.start();
    const child = forks.last();

    child.emitMessage({ type: "event", event: hostile() });
    child.emitMessage({ type: "error", code: `${NAME} ${ZPL}` });
    child.emitStdout(RELAY_LOG("error", `cycle failed: ${NAME} ${ZPL} ${CODE}\n`));
    child.emitStderr(`${ZPL}\nsecurity code ${CODE_2}\n`);
    const pending = supervisor.testPrint("printer-1");
    child.emitMessage({ type: "testPrintResult", printerId: "printer-1", ok: false, error: `${NAME} ${ZPL}`, name: NAME });
    const reply = await pending;
    child.emitExit(1);

    expectClean({ "supervisor state": supervisor.state(), "supervisor log": lines, "test print reply": reply });
    expect(supervisor.state().lastErrorCode).toBe("unexpected");
    expect(reply).toEqual({ ok: false, error: "unexpected" });
  });
});

describe("errors from the updater", () => {
  function updaterFlow(ctx: Context) {
    const listeners = new Map<string, (...args: never[]) => void>();
    const updater: AutoUpdaterLike = {
      allowPrerelease: false,
      allowDowngrade: false,
      autoDownload: false,
      autoInstallOnAppQuit: true,
      logger: null,
      on: (event, listener) => void listeners.set(event, listener),
      checkForUpdates: vi.fn(async () => {
        throw Object.assign(new Error(`could not read ${NAME}: ${ZPL} (${CODE})`), { code: "ERR_UPDATER_LATEST_VERSION_NOT_FOUND" });
      }),
      quitAndInstall: vi.fn(),
    };
    const adapter = createUpdaterAdapter(updater, (level, scope, message) => void ctx.h.logLines.push(`${level} ${scope} ${message}`));
    const controller = createUpdateController({
      adapter,
      channel: "stable",
      timers: ctx.h.timers.timers,
      onState: (state) => ctx.h.controller.setUpdateState(state),
    });
    const emit = (event: string, ...args: unknown[]) => (listeners.get(event) as (...a: unknown[]) => void)(...args);
    return { updater, controller, emit };
  }

  it("keeps updater error text out of the log, the renderer and the tray", async () => {
    const ctx = await setup();
    const { updater, controller, emit } = updaterFlow(ctx);

    await controller.checkNow();
    emit("error", new Error(`${NAME} ${ZPL} ${CODE}`));
    emit("error", Object.assign(new Error(`${NAME_2} ${CODE_2}`), { code: "ENOTFOUND" }));
    updater.logger?.error(new Error(`${NAME} ${ZPL}`));
    updater.logger?.error(`${NAME} ${CODE}`);
    updater.logger?.warn(`${ZPL}`);
    updater.logger?.warn(new Error(`${NAME_2}`));

    expect(ctx.h.controller.snapshot().update).toEqual({ kind: "error" });
    const result = await surface(ctx);
    expectClean(result);
    // The updater's errors were logged, as class and code only.
    const logs = ctx.h.logLines.join("\n");
    expect(logs).toContain("update failed: Error");
    expect(logs).toContain("(ENOTFOUND)");
  });

  it("shows a downloaded update's version only when it is a version", async () => {
    const ctx = await setup();
    const { emit } = updaterFlow(ctx);

    emit("update-downloaded", { version: NAME });
    expect(ctx.h.controller.snapshot().update).toEqual({ kind: "ready", version: "" });
    expectClean(await surface(ctx));
  });

  it("shows a real version unchanged", async () => {
    const ctx = await setup();
    const { emit } = updaterFlow(ctx);
    emit("update-downloaded", { version: "0.2.0" });
    expect(ctx.h.controller.snapshot().update).toEqual({ kind: "ready", version: "0.2.0" });
  });
});

describe("the log line itself", () => {
  it("never writes a seed, even if a message that carries one reaches it", () => {
    const lines: string[] = [];
    const log = createLogger((line) => void lines.push(line));
    log("error", "relay", `failed ${ZPL}`);
    log("error", "relay", `{"name":"${NAME}","securityCode":"${CODE_2}"}`);
    log("warn", "relay", `attendee=${NAME}, code ${CODE}`);
    expectClean({ lines });
  });
});

/**
 * Favor Printer main process: wires Electron to the shell modules. Decisions
 * live in `shell/` and `services/`, where tests reach them; this file only
 * constructs things and connects them.
 */

import { appendFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  powerMonitor,
  powerSaveBlocker,
  safeStorage,
  shell,
  Tray,
  utilityProcess,
} from "electron";
import { autoUpdater } from "electron-updater";

import { PRODUCT_NAME, type StatusColor } from "../shared";
import {
  appSupportDir,
  createCommandRunner,
  createLegacyRelay,
  createPowerController,
  createPrinterService,
  createSecretStore,
  createUpdateController,
  enroll,
  systemTimers,
} from "./services";
import { createAppController } from "./shell/controller";
import { handlersFor, isTrustedSender, registerIpcHandlers, type IpcMainLike } from "./shell/ipc";
import { acquireSingleInstance } from "./shell/lifecycle";
import { createLogger, createRotatingFileSink, describeError, silentLogger } from "./shell/log";
import { wirePowerMonitor, type PowerMonitorLike } from "./shell/powerWiring";
import { createPrefsStore } from "./shell/prefs";
import { createUtilityRelayForker, relayEntryPath, type UtilityProcessModule } from "./shell/relayEnv";
import { parseSelfTestArg, runSelfTest } from "./shell/selfTest";
import { createRelaySupervisor } from "./shell/supervisor";
import { createTrayView } from "./shell/tray";
import { trayIconPng } from "./shell/trayIcons";
import { createUpdaterAdapter, type AutoUpdaterLike } from "./shell/updaterAdapter";
import { createSetupWindowManager, type WindowLike, type WindowOptions } from "./shell/windows";

const PRINTER_SETTINGS_URL = "x-apple.systempreferences:com.apple.Print-Scan-Settings.extension";

const osVersion = () => `macOS ${process.getSystemVersion()}`;

const relayForker = () =>
  createUtilityRelayForker({
    utilityProcess: utilityProcess as unknown as UtilityProcessModule,
    entry: relayEntryPath(__dirname),
    processEnv: process.env,
  });

async function runSelfTestMode(apiUrl: string): Promise<void> {
  // A temporary userData keeps this run away from real preferences and secrets.
  const workDir = mkdtempSync(path.join(os.tmpdir(), "favor-printer-self-test-"));
  app.setPath("userData", workDir);
  app.dock?.hide();
  await app.whenReady();
  let exitCode = 1;
  try {
    const result = await runSelfTest({
      apiUrl,
      fork: relayForker(),
      workDir,
      appVersion: app.getVersion(),
      osVersion: osVersion(),
      timers: systemTimers,
      log: silentLogger,
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    exitCode = result.ok ? 0 : 1;
  } catch {
    process.stdout.write(`${JSON.stringify({ type: "self-test", ok: false, error: "unexpected" })}\n`);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
  app.exit(exitCode);
}

async function runApp(): Promise<void> {
  const supportDir = appSupportDir(os.homedir());
  app.setPath("userData", supportDir);

  const setupWindowRef: { current: ReturnType<typeof createSetupWindowManager> | null } = { current: null };
  const showSetup = () => {
    // Without a Dock icon the window would open behind other apps.
    setupWindowRef.current?.show();
  };

  if (!acquireSingleInstance(app, showSetup)) {
    app.quit();
    return;
  }
  app.dock?.hide();

  const log = createLogger(
    createRotatingFileSink(path.join(app.getPath("logs"), "main.log"), {
      append: (file, text) => appendFileSync(file, text),
      size: (file) => {
        try {
          return statSync(file).size;
        } catch {
          return 0;
        }
      },
      rename: renameSync,
      mkdir: (dir) => void mkdirSync(dir, { recursive: true }),
    }),
  );
  process.on("uncaughtException", (error) => log("error", "main", `uncaught: ${describeError(error)}`));
  process.on("unhandledRejection", (reason) => log("error", "main", `unhandled rejection: ${describeError(reason)}`));

  // Closing the setup window must not quit a menu-bar app.
  app.on("window-all-closed", () => undefined);

  await app.whenReady();

  const prefs = createPrefsStore({ file: path.join(supportDir, "prefs.json") });
  await prefs.load();

  const rendererDir = path.join(__dirname, "renderer");
  const pagePath = path.join(rendererDir, "index.html");
  const windows = createSetupWindowManager({
    create: (options: WindowOptions) => new BrowserWindow(options as unknown as Electron.BrowserWindowConstructorOptions) as unknown as WindowLike,
    preloadPath: path.join(__dirname, "preload.js"),
    pagePath,
    activate: () => app.focus({ steal: true }),
  });
  setupWindowRef.current = windows;

  const updateAdapter = createUpdaterAdapter(autoUpdater as unknown as AutoUpdaterLike, log);
  const updates = createUpdateController({
    adapter: updateAdapter,
    channel: prefs.get().channel,
    onState: (state) => controller.setUpdateState(state),
  });

  const run = createCommandRunner();
  const controller = createAppController({
    version: app.getVersion(),
    osVersion: osVersion(),
    appSupportDir: supportDir,
    prefs,
    secrets: createSecretStore({ file: path.join(supportDir, "relay-token.bin"), safeStorage }),
    printers: createPrinterService({ run }),
    legacy: createLegacyRelay({
      run,
      homeDir: os.homedir(),
      uid: process.getuid?.() ?? 0,
      fileExists: async (file) => {
        try {
          statSync(file);
          return true;
        } catch {
          return false;
        }
      },
    }),
    enroll,
    createSupervisor: (hooks) => createRelaySupervisor({ fork: relayForker(), log, ...hooks }),
    power: createPowerController({ blocker: powerSaveBlocker }),
    updates,
    ui: {
      showSetupWindow: showSetup,
      closeSetupWindow: () => windows.close(),
      askLabelCameOut: async () => {
        const { response } = await dialog.showMessageBox({
          type: "question",
          message: "Did a label come out?",
          detail: "Favor Printer sent the test label to the printer. That does not prove a label printed.",
          buttons: ["Yes, a label came out", "No label came out"],
          defaultId: 0,
          cancelId: 1,
        });
        return response === 0;
      },
      openPrinterSettings: () => shell.openExternal(PRINTER_SETTINGS_URL),
    },
    applyOpenAtLogin: (enabled) => app.setLoginItemSettings({ openAtLogin: enabled }),
    log,
  });

  // Quit: stop the relay (waiting for a send that is writing), then let an
  // update install if the policy allows it, then exit.
  let quitting = false;
  const requestQuit = async () => {
    if (quitting) return;
    quitting = true;
    updates.stop();
    const { jobInFlight } = await controller.shutdown();
    if (updates.beforeQuit(jobInFlight) !== "install") app.quit();
  };
  app.on("before-quit", (event) => {
    if (quitting) return;
    event.preventDefault();
    void requestQuit();
  });

  const icons = Object.fromEntries(
    (["green", "amber", "red"] as const).map((color: StatusColor) => {
      const image = nativeImage.createFromBuffer(trayIconPng(color, 1), { scaleFactor: 1 });
      image.addRepresentation({ scaleFactor: 2, buffer: trayIconPng(color, 2) });
      image.setTemplateImage(true);
      return [color, image];
    }),
  ) as Record<StatusColor, Electron.NativeImage>;

  const tray = new Tray(icons.amber);
  const trayView = createTrayView({
    tray,
    icons,
    buildMenu: (template) => Menu.buildFromTemplate(template as Electron.MenuItemConstructorOptions[]),
    actions: {
      pause: () => void controller.setPaused(true),
      resume: () => void controller.setPaused(false),
      testPrint: () => void controller.testPrintFromMenu(),
      openSetup: () => controller.openSetup(),
      reenroll: () => controller.beginReenroll(),
      migrateLegacy: () => void controller.migrateLegacyRelay(),
      setOpenAtLogin: (enabled) => void controller.setOpenAtLogin(enabled),
      checkForUpdates: () => void updates.checkNow(),
      setChannel: (channel) => void controller.setChannel(channel),
      quit: () => void requestQuit(),
    },
  });
  controller.subscribe((snapshot) => {
    trayView.render(snapshot);
    windows.send(snapshot);
  });

  registerIpcHandlers({
    ipcMain: ipcMain as unknown as IpcMainLike,
    handlers: handlersFor({
      getSnapshot: async () => controller.snapshot(),
      scanPrinters: () => controller.scanPrinters(),
      selectPrinter: (id) => controller.selectPrinter(id),
      setUpPrinter: () => controller.setUpPrinter(),
      openPrinterSettings: () => controller.openPrinterSettings(),
      enroll: (code) => controller.enroll(code),
      requestTestPrint: () => controller.requestTestPrint(),
      confirmTestPrint: (came) => controller.confirmTestPrint(came),
      setPaused: (paused) => controller.setPaused(paused),
      setOpenAtLogin: (enabled) => controller.setOpenAtLogin(enabled),
      setChannel: (channel) => controller.setChannel(channel),
      migrateLegacyRelay: () => controller.migrateLegacyRelay(),
      advance: () => controller.advance(),
      quit: async () => void requestQuit(),
    }),
    isTrusted: (event) =>
      isTrustedSender(event, { webContentsId: windows.webContentsId, pageUrl: pathToFileURL(pagePath).href }),
    onRejected: (channel, reason) => log("warn", "ipc", `rejected ${channel}: ${reason}`),
  });

  wirePowerMonitor(powerMonitor as unknown as PowerMonitorLike, controller);

  await controller.initialize();
  updates.start();
  if (controller.snapshot().setupStep !== null) showSetup();
  log("info", "main", `${PRODUCT_NAME} ${app.getVersion()} started`);
}

const selfTest = parseSelfTestArg(process.argv);
if (selfTest.kind === "invalid") {
  process.stdout.write(`${JSON.stringify({ type: "self-test", ok: false, error: "invalid_argument", reason: selfTest.reason })}\n`);
  app.exit(2);
} else if (selfTest.kind === "run") {
  void runSelfTestMode(selfTest.apiUrl);
} else {
  void runApp().catch((error) => {
    console.error(describeError(error));
    app.exit(1);
  });
}

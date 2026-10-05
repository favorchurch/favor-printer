import { describe, expect, it, vi } from "vitest";

import { IPC_CHANNELS } from "../../shared";
import { createSetupWindowManager, setupWindowOptions, type WindowLike, type WindowOptions } from "./windows";
import { snapshotFor } from "./testing/snapshot";

function fakeWindow(id = 11) {
  const handlers: Record<string, () => void> = {};
  let destroyed = false;
  let visible = false;
  const web = {
    id,
    send: vi.fn(),
    setWindowOpenHandler: vi.fn(),
    navigate: undefined as undefined | ((event: { preventDefault(): void }) => void),
    on: vi.fn((event: string, listener: (event: { preventDefault(): void }) => void) => {
      if (event === "will-navigate") web.navigate = listener;
    }),
    session: { permission: undefined as undefined | ((...args: unknown[]) => void), setPermissionRequestHandler: vi.fn((handler: (...args: unknown[]) => void) => (web.session.permission = handler)) },
  };
  const window = {
    loadFile: vi.fn(async () => undefined),
    show: vi.fn(() => {
      visible = true;
    }),
    focus: vi.fn(),
    close: vi.fn(() => {
      destroyed = true;
      handlers.closed?.();
    }),
    isDestroyed: () => destroyed,
    isVisible: () => visible,
    on: vi.fn((event: string, listener: () => void) => void (handlers[event] = listener)),
    once: vi.fn((event: string, listener: () => void) => void (handlers[event] = listener)),
    webContents: web,
  };
  return { window, web, handlers, destroy: () => (destroyed = true) };
}

function setup() {
  const created: ReturnType<typeof fakeWindow>[] = [];
  const optionsSeen: WindowOptions[] = [];
  const activate = vi.fn();
  const manager = createSetupWindowManager({
    create: (options) => {
      optionsSeen.push(options);
      const fake = fakeWindow(11 + created.length);
      created.push(fake);
      return fake.window as unknown as WindowLike;
    },
    preloadPath: "/app/dist/preload.js",
    pagePath: "/app/dist/renderer/index.html",
    activate,
  });
  return { manager, created, optionsSeen, activate };
}

describe("setupWindowOptions", () => {
  it("isolates the renderer: context isolation and sandbox on, node integration off", () => {
    const { webPreferences } = setupWindowOptions("/app/dist/preload.js");
    expect(webPreferences).toMatchObject({
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      preload: "/app/dist/preload.js",
    });
  });

  it("never enables remote content or node in workers or subframes", () => {
    const prefs = setupWindowOptions("/p.js").webPreferences as Record<string, unknown>;
    for (const key of ["nodeIntegrationInWorker", "nodeIntegrationInSubFrames", "enableRemoteModule", "webviewTag"]) {
      expect(prefs[key] ?? false).toBe(false);
    }
  });

  it("is a fixed-size window that does not show before it is ready", () => {
    const options = setupWindowOptions("/p.js");
    expect(options).toMatchObject({ resizable: false, show: false, title: "Favor Printer" });
  });
});

describe("createSetupWindowManager", () => {
  it("creates the window with the locked-down options and loads the page", () => {
    const { manager, optionsSeen, created } = setup();
    manager.show();
    expect(optionsSeen).toHaveLength(1);
    expect(optionsSeen[0].webPreferences).toMatchObject({ contextIsolation: true, nodeIntegration: false, sandbox: true });
    expect(created[0].window.loadFile).toHaveBeenCalledWith("/app/dist/renderer/index.html");
  });

  it("shows the window when it is ready, and brings the app forward", () => {
    const { manager, created, activate } = setup();
    manager.show();
    expect(activate).toHaveBeenCalled();
    created[0].handlers["ready-to-show"]();
    expect(created[0].window.show).toHaveBeenCalled();
  });

  it("reuses an open window instead of opening a second one", () => {
    const { manager, created } = setup();
    manager.show();
    created[0].handlers["ready-to-show"]();
    manager.show();
    expect(created).toHaveLength(1);
    expect(created[0].window.focus).toHaveBeenCalled();
  });

  it("opens a new window after the old one was closed", () => {
    const { manager, created } = setup();
    manager.show();
    created[0].handlers.closed();
    created[0].destroy();
    manager.show();
    expect(created).toHaveLength(2);
  });

  it("denies new windows, blocks navigation and refuses every permission", () => {
    const { manager, created } = setup();
    manager.show();
    const { web } = created[0];

    expect(web.setWindowOpenHandler).toHaveBeenCalledTimes(1);
    const handler = web.setWindowOpenHandler.mock.calls[0][0] as () => { action: string };
    expect(handler()).toEqual({ action: "deny" });

    const preventDefault = vi.fn();
    web.navigate?.({ preventDefault });
    expect(preventDefault).toHaveBeenCalled();

    const callback = vi.fn();
    web.session.permission?.({}, "media", callback);
    expect(callback).toHaveBeenCalledWith(false);
  });

  it("pushes snapshots on the snapshot channel, and only while a window is open", () => {
    const { manager, created } = setup();
    manager.send(snapshotFor());
    expect(created).toHaveLength(0);

    manager.show();
    const snapshot = snapshotFor({ paused: true });
    manager.send(snapshot);
    expect(created[0].web.send).toHaveBeenCalledWith(IPC_CHANNELS.snapshot, snapshot);
  });

  it("reports the web contents id for the sender check, and null once closed", () => {
    const { manager, created } = setup();
    expect(manager.webContentsId()).toBeNull();
    manager.show();
    expect(manager.webContentsId()).toBe(11);
    manager.close();
    expect(created[0].window.close).toHaveBeenCalled();
    expect(manager.webContentsId()).toBeNull();
  });
});

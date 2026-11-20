import { describe, expect, it, vi } from "vitest";

import { IPC_CHANNELS } from "../../shared";
import { createSetupWindowManager, DOCK_HIDE_COOLDOWN_MS, setupWindowOptions, type WindowLike, type WindowOptions } from "./windows";
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
  const dock = { show: vi.fn(), hide: vi.fn() };
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
    dock,
  });
  return { manager, created, optionsSeen, activate, dock };
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

  it("shows the Dock icon when the window becomes visible and hides it when it closes", () => {
    const { manager, created, dock } = setup();
    manager.show();
    expect(dock.show).not.toHaveBeenCalled();
    expect(dock.hide).not.toHaveBeenCalled();

    created[0].handlers["ready-to-show"]();
    expect(dock.show).toHaveBeenCalledTimes(1);
    expect(dock.hide).not.toHaveBeenCalled();

    // Re-focusing an open window does not hide or re-spam dock.show.
    manager.show();
    expect(dock.show).toHaveBeenCalledTimes(1);

    manager.close();
    expect(dock.hide).toHaveBeenCalledTimes(1);

    // Reopening shows the Dock icon again.
    manager.show();
    created[1].handlers["ready-to-show"]();
    expect(dock.show).toHaveBeenCalledTimes(2);
  });

  it("does not hide the Dock icon if the window closes before ready-to-show", () => {
    const { manager, created, dock } = setup();
    manager.show();
    manager.close();
    created[0].handlers["ready-to-show"]();
    expect(dock.show).not.toHaveBeenCalled();
    expect(created[0].window.show).not.toHaveBeenCalled();
    expect(dock.hide).not.toHaveBeenCalled();
  });

  it("handles omitted dock and a rejected dock.show() promise", () => {
    const manager = createSetupWindowManager({
      create: () => fakeWindow(20).window as unknown as WindowLike,
      preloadPath: "/p.js",
      pagePath: "/p.html",
    });
    expect(() => {
      manager.show();
      manager.close();
    }).not.toThrow();

    const created: ReturnType<typeof fakeWindow>[] = [];
    const rejectingDock = { show: vi.fn(() => Promise.reject(new Error("dock unavailable"))), hide: vi.fn() };
    const withReject = createSetupWindowManager({
      create: () => {
        const fake = fakeWindow(21);
        created.push(fake);
        return fake.window as unknown as WindowLike;
      },
      preloadPath: "/p.js",
      pagePath: "/p.html",
      dock: rejectingDock,
    });
    withReject.show();
    created[0].handlers["ready-to-show"]();
    expect(created[0].window.show).toHaveBeenCalled();
    withReject.close();
    expect(rejectingDock.hide).toHaveBeenCalledTimes(1);
  });

  it("still shows the window when dock.show() throws synchronously", () => {
    const created: ReturnType<typeof fakeWindow>[] = [];
    const throwingDock = {
      show: vi.fn(() => {
        throw new Error("dock sync error");
      }),
      hide: vi.fn(),
    };
    const manager = createSetupWindowManager({
      create: () => {
        const fake = fakeWindow(22);
        created.push(fake);
        return fake.window as unknown as WindowLike;
      },
      preloadPath: "/p.js",
      pagePath: "/p.html",
      dock: throwingDock,
    });
    manager.show();
    expect(() => created[0].handlers["ready-to-show"]()).not.toThrow();
    expect(created[0].window.show).toHaveBeenCalledTimes(1);
  });

  it("defers dock.hide() when closing soon after a startup hide", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(0);
      const created: ReturnType<typeof fakeWindow>[] = [];
      const dock = { show: vi.fn(), hide: vi.fn() };
      const manager = createSetupWindowManager({
        create: () => {
          const fake = fakeWindow(30 + created.length);
          created.push(fake);
          return fake.window as unknown as WindowLike;
        },
        preloadPath: "/p.js",
        pagePath: "/p.html",
        dock,
        dockHiddenAt: 0,
      });

      vi.setSystemTime(200);
      manager.show();
      created[0].handlers["ready-to-show"]();
      expect(dock.show).toHaveBeenCalledTimes(1);

      vi.setSystemTime(400);
      manager.close();
      // Within Electron's 1s suppression window: must defer instead of calling hide() immediately.
      expect(dock.hide).not.toHaveBeenCalled();

      vi.advanceTimersByTime(DOCK_HIDE_COOLDOWN_MS - 400 - 1);
      expect(dock.hide).not.toHaveBeenCalled();

      vi.advanceTimersByTime(1);
      expect(dock.hide).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("defers dock.hide() across rapid close/reopen/close and cancels pending hide when reopened", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(5000);
      const { manager, created, dock } = setup();

      manager.show();
      created[0].handlers["ready-to-show"]();
      manager.close();
      expect(dock.hide).toHaveBeenCalledTimes(1);

      // Reopen and close within the cooldown window: second hide must be deferred.
      vi.setSystemTime(5100);
      manager.show();
      created[1].handlers["ready-to-show"]();
      vi.setSystemTime(5300);
      manager.close();
      expect(dock.hide).toHaveBeenCalledTimes(1);

      // Reopen before the deferred hide fires: pending hide must be cancelled.
      vi.setSystemTime(5500);
      manager.show();
      created[2].handlers["ready-to-show"]();
      vi.advanceTimersByTime(DOCK_HIDE_COOLDOWN_MS);
      expect(dock.hide).toHaveBeenCalledTimes(1);

      // Closing after the cooldown has elapsed hides immediately again.
      manager.close();
      expect(dock.hide).toHaveBeenCalledTimes(2);

      // Closing again within the new cooldown defers until the cooldown expires.
      vi.advanceTimersByTime(200);
      manager.show();
      created[3].handlers["ready-to-show"]();
      vi.advanceTimersByTime(100);
      manager.close();
      expect(dock.hide).toHaveBeenCalledTimes(2);

      vi.advanceTimersByTime(DOCK_HIDE_COOLDOWN_MS - 300);
      expect(dock.hide).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("calls onClosed once when the current window closes, and ignores stale windows", () => {
    const created: ReturnType<typeof fakeWindow>[] = [];
    const onClosed = vi.fn();
    const manager = createSetupWindowManager({
      create: () => {
        const fake = fakeWindow(40 + created.length);
        created.push(fake);
        return fake.window as unknown as WindowLike;
      },
      preloadPath: "/p.js",
      pagePath: "/p.html",
      onClosed,
    });

    manager.show();
    created[0].destroy();
    // Opening a replacement window makes created[0] stale.
    manager.show();
    created[0].handlers.closed();
    expect(onClosed).not.toHaveBeenCalled();

    manager.close();
    expect(onClosed).toHaveBeenCalledTimes(1);
    // Repeated closed event on the already-closed window is ignored.
    created[1].handlers.closed();
    expect(onClosed).toHaveBeenCalledTimes(1);
  });

  it("still hides the Dock icon if a shown window is destroyed without closed and its replacement closes early", () => {
    const { manager, created, dock } = setup();
    manager.show();
    created[0].handlers["ready-to-show"]();
    expect(dock.show).toHaveBeenCalledTimes(1);

    created[0].destroy();
    manager.show();
    manager.close();
    expect(dock.hide).toHaveBeenCalledTimes(1);
  });

  it("re-activates the app once an async dock.show() settles", async () => {
    let resolveDockShow!: () => void;
    const dock = {
      show: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            resolveDockShow = resolve;
          }),
      ),
      hide: vi.fn(),
    };
    const activate = vi.fn();
    const created: ReturnType<typeof fakeWindow>[] = [];
    const manager = createSetupWindowManager({
      create: () => {
        const fake = fakeWindow(50 + created.length);
        created.push(fake);
        return fake.window as unknown as WindowLike;
      },
      preloadPath: "/p.js",
      pagePath: "/p.html",
      activate,
      dock,
    });

    manager.show();
    expect(activate).toHaveBeenCalledTimes(1);
    created[0].handlers["ready-to-show"]();
    expect(activate).toHaveBeenCalledTimes(2);

    resolveDockShow();
    await Promise.resolve();
    await Promise.resolve();
    expect(activate).toHaveBeenCalledTimes(3);
  });
});

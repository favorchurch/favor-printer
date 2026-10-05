/**
 * The setup window: one fixed-size page, loaded from `dist/renderer`, with the
 * renderer locked down. It never navigates away, opens nothing, and gets no
 * permissions. Closing it hides the app's UI; the tray keeps running.
 */

import type { AppSnapshot } from "../../shared";
import { IPC_CHANNELS } from "../../shared";

export const SETUP_WINDOW = { width: 520, height: 640 } as const;

export function setupWindowOptions(preloadPath: string) {
  return {
    width: SETUP_WINDOW.width,
    height: SETUP_WINDOW.height,
    useContentSize: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    show: false,
    title: "Favor Printer",
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      devTools: false,
      spellcheck: false,
    },
  } as const;
}

export type WindowLike = {
  loadFile(file: string): Promise<void>;
  show(): void;
  focus(): void;
  close(): void;
  isDestroyed(): boolean;
  isVisible(): boolean;
  on(event: "closed", listener: () => void): unknown;
  once(event: "ready-to-show", listener: () => void): unknown;
  webContents: {
    id: number;
    send(channel: string, ...args: unknown[]): void;
    setWindowOpenHandler(handler: () => { action: "deny" }): void;
    on(event: "will-navigate", listener: (event: { preventDefault(): void }) => void): unknown;
    session: {
      setPermissionRequestHandler(handler: (...args: unknown[]) => void): void;
    };
  };
};

export type WindowOptions = ReturnType<typeof setupWindowOptions>;

export type SetupWindowManager = {
  show(): void;
  close(): void;
  /** Pushes a snapshot to the page, when it is open. */
  send(snapshot: AppSnapshot): void;
  webContentsId(): number | null;
};

export function createSetupWindowManager(deps: {
  create(options: WindowOptions): WindowLike;
  preloadPath: string;
  pagePath: string;
  /** Brings the app forward: a menu-bar app has no Dock icon to click. */
  activate?: () => void;
}): SetupWindowManager {
  let window: WindowLike | null = null;

  const open = (): WindowLike => {
    if (window && !window.isDestroyed()) return window;
    const created = deps.create(setupWindowOptions(deps.preloadPath));
    window = created;
    created.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    created.webContents.on("will-navigate", (event) => event.preventDefault());
    created.webContents.session.setPermissionRequestHandler((...args) => {
      // (webContents, permission, callback): refuse everything.
      const callback = args[2];
      if (typeof callback === "function") (callback as (granted: boolean) => void)(false);
    });
    created.once("ready-to-show", () => created.show());
    created.on("closed", () => {
      if (window === created) window = null;
    });
    void created.loadFile(deps.pagePath);
    return created;
  };

  return {
    show() {
      const current = open();
      deps.activate?.();
      if (current.isVisible()) current.focus();
    },
    close() {
      if (window && !window.isDestroyed()) window.close();
    },
    send(snapshot) {
      if (window && !window.isDestroyed()) window.webContents.send(IPC_CHANNELS.snapshot, snapshot);
    },
    webContentsId: () => (window && !window.isDestroyed() ? window.webContents.id : null),
  };
}

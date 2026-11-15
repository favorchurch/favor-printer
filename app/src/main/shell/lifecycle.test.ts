import { describe, expect, it, vi } from "vitest";

import { acquireSingleInstance, wireActivate } from "./lifecycle";
import { CREDENTIALS, createControllerHarness, foundPrinter } from "./testing/controllerHarness";

function fakeApp(lock: boolean) {
  const listeners: Record<string, () => void> = {};
  return {
    app: {
      requestSingleInstanceLock: vi.fn(() => lock),
      on: vi.fn((event: "second-instance", listener: () => void) => void (listeners[event] = listener)),
    },
    listeners,
  };
}

describe("acquireSingleInstance", () => {
  it("returns true and asks to be told about a second launch when it gets the lock", () => {
    const { app, listeners } = fakeApp(true);
    const onSecond = vi.fn();
    expect(acquireSingleInstance(app, onSecond)).toBe(true);
    expect(app.requestSingleInstanceLock).toHaveBeenCalledTimes(1);
    listeners["second-instance"]();
    expect(onSecond).toHaveBeenCalledTimes(1);
  });

  it("returns false without listening when another instance holds the lock", () => {
    const { app } = fakeApp(false);
    expect(acquireSingleInstance(app, vi.fn())).toBe(false);
    expect(app.on).not.toHaveBeenCalled();
  });
});

describe("wireActivate", () => {
  it("runs the activate handler when macOS reopens the running app", () => {
    const listeners: Record<string, () => void> = {};
    const app = {
      on: vi.fn((event: "activate", listener: () => void) => void (listeners[event] = listener)),
    };
    const onActivate = vi.fn();
    wireActivate(app, onActivate);
    expect(app.on).toHaveBeenCalledWith("activate", expect.any(Function));
    listeners.activate();
    expect(onActivate).toHaveBeenCalledTimes(1);
  });
});

describe("activate while a re-pair is in progress", () => {
  it("shows the window and keeps the code step", async () => {
    const h = createControllerHarness({
      credentials: CREDENTIALS,
      scan: foundPrinter(),
      prefs: { openAtLogin: true, setupComplete: true },
    });
    await h.controller.initialize();
    h.controller.beginReenroll();
    expect(h.controller.snapshot().setupStep).toBe("code");
    h.ui.showSetupWindow.mockClear();

    const listeners: Record<string, () => void> = {};
    wireActivate({ on: (event, listener) => void (listeners[event] = listener) }, () => h.controller.openSetup());
    listeners.activate();

    expect(h.ui.showSetupWindow).toHaveBeenCalledTimes(1);
    expect(h.controller.snapshot().setupStep).toBe("code");
  });
});

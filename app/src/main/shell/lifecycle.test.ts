import { describe, expect, it, vi } from "vitest";

import { acquireSingleInstance } from "./lifecycle";

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

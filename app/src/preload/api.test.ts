import { describe, expect, it, vi } from "vitest";

import { IPC_CHANNELS } from "../shared";
import { createApi, type IpcRendererLike } from "./api";

function fakeIpc() {
  const listeners = new Map<string, Set<(event: unknown, ...args: unknown[]) => void>>();
  const ipc: IpcRendererLike = {
    invoke: vi.fn(async (_channel: string, ..._args: unknown[]) => "reply"),
    on: vi.fn((channel: string, listener: (event: unknown, ...args: unknown[]) => void) => {
      if (!listeners.has(channel)) listeners.set(channel, new Set());
      listeners.get(channel)?.add(listener);
    }),
    removeListener: vi.fn((channel: string, listener: (event: unknown, ...args: unknown[]) => void) => {
      listeners.get(channel)?.delete(listener);
    }),
  };
  return { ipc, listeners };
}

describe("preload API", () => {
  it("exposes exactly the documented methods and nothing else", () => {
    const api = createApi(fakeIpc().ipc);
    expect(Object.keys(api).sort()).toEqual(
      [
        "advance",
        "confirmTestPrint",
        "enroll",
        "getSnapshot",
        "migrateLegacyRelay",
        "onSnapshot",
        "openPrinterSettings",
        "quit",
        "requestTestPrint",
        "scanPrinters",
        "selectPrinter",
        "setChannel",
        "setOpenAtLogin",
        "setPaused",
        "setUpPrinter",
      ].sort(),
    );
    for (const value of Object.values(api)) expect(typeof value).toBe("function");
  });

  it.each([
    ["getSnapshot", IPC_CHANNELS.getSnapshot, []],
    ["scanPrinters", IPC_CHANNELS.scanPrinters, []],
    ["selectPrinter", IPC_CHANNELS.selectPrinter, ["usb://z/1"]],
    ["setUpPrinter", IPC_CHANNELS.setUpPrinter, []],
    ["openPrinterSettings", IPC_CHANNELS.openPrinterSettings, []],
    ["enroll", IPC_CHANNELS.enroll, ["123456"]],
    ["requestTestPrint", IPC_CHANNELS.requestTestPrint, []],
    ["confirmTestPrint", IPC_CHANNELS.confirmTestPrint, [true]],
    ["setPaused", IPC_CHANNELS.setPaused, [true]],
    ["setOpenAtLogin", IPC_CHANNELS.setOpenAtLogin, [false]],
    ["setChannel", IPC_CHANNELS.setChannel, ["preview"]],
    ["migrateLegacyRelay", IPC_CHANNELS.migrateLegacyRelay, []],
    ["advance", IPC_CHANNELS.advance, []],
    ["quit", IPC_CHANNELS.quit, []],
  ] as const)("%s invokes its own channel with its own arguments", async (method, channel, args) => {
    const { ipc } = fakeIpc();
    const api = createApi(ipc) as unknown as Record<string, (...values: unknown[]) => Promise<unknown>>;
    await expect(api[method](...args)).resolves.toBe("reply");
    expect(ipc.invoke).toHaveBeenCalledExactlyOnceWith(channel, ...args);
  });

  it("passes the reply through untouched", async () => {
    const { ipc } = fakeIpc();
    vi.mocked(ipc.invoke).mockResolvedValueOnce({ ok: false, reason: "invalid_code" });
    await expect(createApi(ipc).enroll("123456")).resolves.toEqual({ ok: false, reason: "invalid_code" });
  });

  describe("onSnapshot", () => {
    it("hands the listener the snapshot and never the IPC event", () => {
      const { ipc, listeners } = fakeIpc();
      const received: unknown[][] = [];
      createApi(ipc).onSnapshot((...args) => received.push(args));

      const [raw] = [...(listeners.get(IPC_CHANNELS.snapshot) ?? [])];
      const sender = { send: () => undefined };
      raw({ sender }, { version: "0.1.0" });
      expect(received).toEqual([[{ version: "0.1.0" }]]);
    });

    it("listens on the snapshot channel only", () => {
      const { ipc } = fakeIpc();
      createApi(ipc).onSnapshot(() => undefined);
      expect(vi.mocked(ipc.on).mock.calls.map(([channel]) => channel)).toEqual([IPC_CHANNELS.snapshot]);
    });

    it("returns an unsubscribe that removes the same listener", () => {
      const { ipc, listeners } = fakeIpc();
      const off = createApi(ipc).onSnapshot(() => undefined);
      expect(listeners.get(IPC_CHANNELS.snapshot)?.size).toBe(1);
      off();
      expect(listeners.get(IPC_CHANNELS.snapshot)?.size).toBe(0);
    });

    it("keeps separate subscriptions separate", () => {
      const { ipc, listeners } = fakeIpc();
      const api = createApi(ipc);
      const first = vi.fn();
      const second = vi.fn();
      const offFirst = api.onSnapshot(first);
      api.onSnapshot(second);
      offFirst();
      for (const raw of listeners.get(IPC_CHANNELS.snapshot) ?? []) raw({}, { n: 1 });
      expect(first).not.toHaveBeenCalled();
      expect(second).toHaveBeenCalledWith({ n: 1 });
    });
  });
});

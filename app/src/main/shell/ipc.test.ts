import { describe, expect, it, vi } from "vitest";

import { IPC_CHANNELS, type FavorPrinterApi } from "../../shared";
import {
  handlersFor,
  InvalidPayloadError,
  isTrustedSender,
  registerIpcHandlers,
  VALIDATORS,
  type IpcEventLike,
  type IpcMainLike,
} from "./ipc";
import { snapshotFor } from "./testing/snapshot";

type Listener = (event: IpcEventLike, ...args: unknown[]) => unknown;

function setup(trusted = true) {
  const registered = new Map<string, Listener>();
  const removed: string[] = [];
  const ipcMain: IpcMainLike = {
    handle: (channel, listener) => void registered.set(channel, listener),
    removeHandler: (channel) => void removed.push(channel),
  };
  const api = {
    getSnapshot: vi.fn(async () => snapshotFor()),
    scanPrinters: vi.fn(async () => snapshotFor()),
    selectPrinter: vi.fn(async () => snapshotFor()),
    setUpPrinter: vi.fn(async () => ({ ok: true }) as const),
    openPrinterSettings: vi.fn(async () => undefined),
    enroll: vi.fn(async () => ({ ok: true }) as const),
    requestTestPrint: vi.fn(async () => ({ ok: true }) as const),
    confirmTestPrint: vi.fn(async () => undefined),
    setPaused: vi.fn(async () => undefined),
    setOpenAtLogin: vi.fn(async () => undefined),
    setChannel: vi.fn(async () => undefined),
    migrateLegacyRelay: vi.fn(async () => ({ ok: true }) as const),
    advance: vi.fn(async () => snapshotFor()),
    quit: vi.fn(async () => undefined),
  } satisfies Omit<FavorPrinterApi, "onSnapshot">;
  const onRejected = vi.fn();
  const dispose = registerIpcHandlers({ ipcMain, handlers: handlersFor(api), isTrusted: () => trusted, onRejected });
  const event: IpcEventLike = { sender: { id: 1 }, senderFrame: { url: "file:///app/dist/renderer/index.html" } };
  const invoke = (channel: string, ...args: unknown[]) => {
    const listener = registered.get(channel);
    if (!listener) throw new Error(`no handler for ${channel}`);
    return Promise.resolve(listener(event, ...args));
  };
  return { registered, removed, api, onRejected, dispose, invoke };
}

const INVOKE_CHANNELS = Object.values(IPC_CHANNELS).filter((channel) => channel !== IPC_CHANNELS.snapshot);

describe("registration", () => {
  it("handles every channel the renderer can invoke, and not the snapshot push channel", () => {
    const { registered } = setup();
    expect([...registered.keys()].sort()).toEqual([...INVOKE_CHANNELS].sort());
    expect(registered.has(IPC_CHANNELS.snapshot)).toBe(false);
    expect(Object.keys(VALIDATORS).sort()).toEqual([...INVOKE_CHANNELS].sort());
  });

  it("removes its handlers on dispose", () => {
    const { removed, dispose } = setup();
    dispose();
    expect([...removed].sort()).toEqual([...INVOKE_CHANNELS].sort());
  });
});

describe("payload validation", () => {
  const NO_ARGS = [
    [IPC_CHANNELS.getSnapshot, "getSnapshot"],
    [IPC_CHANNELS.scanPrinters, "scanPrinters"],
    [IPC_CHANNELS.setUpPrinter, "setUpPrinter"],
    [IPC_CHANNELS.openPrinterSettings, "openPrinterSettings"],
    [IPC_CHANNELS.requestTestPrint, "requestTestPrint"],
    [IPC_CHANNELS.migrateLegacyRelay, "migrateLegacyRelay"],
    [IPC_CHANNELS.advance, "advance"],
    [IPC_CHANNELS.quit, "quit"],
  ] as const;

  it.each(NO_ARGS)("%s runs with no arguments", async (channel, method) => {
    const { invoke, api } = setup();
    await invoke(channel);
    expect(api[method]).toHaveBeenCalledWith();
  });

  it.each(NO_ARGS)("%s refuses arguments", async (channel, method) => {
    const { invoke, api } = setup();
    await expect(invoke(channel, "extra")).rejects.toBeInstanceOf(InvalidPayloadError);
    expect(api[method]).not.toHaveBeenCalled();
  });

  it.each([
    [IPC_CHANNELS.setPaused, "setPaused"],
    [IPC_CHANNELS.setOpenAtLogin, "setOpenAtLogin"],
    [IPC_CHANNELS.confirmTestPrint, "confirmTestPrint"],
  ] as const)("%s needs exactly one boolean", async (channel, method) => {
    const { invoke, api } = setup();
    for (const bad of [[], ["true"], [1], [null], [undefined], [{}], [true, true]]) {
      await expect(invoke(channel, ...bad)).rejects.toBeInstanceOf(InvalidPayloadError);
    }
    expect(api[method]).not.toHaveBeenCalled();

    await invoke(channel, false);
    expect(api[method]).toHaveBeenCalledWith(false);
  });

  it("selectPrinter needs a non-empty string of sensible length", async () => {
    const { invoke, api } = setup();
    for (const bad of [[], [""], [5], [null], ["x".repeat(2049)], [["usb://a"]], ["a", "b"]]) {
      await expect(invoke(IPC_CHANNELS.selectPrinter, ...bad)).rejects.toBeInstanceOf(InvalidPayloadError);
    }
    expect(api.selectPrinter).not.toHaveBeenCalled();

    await invoke(IPC_CHANNELS.selectPrinter, "usb://Zebra/ZD421?serial=1");
    expect(api.selectPrinter).toHaveBeenCalledWith("usb://Zebra/ZD421?serial=1");
  });

  it("enroll needs one short string and passes it on for the controller to judge", async () => {
    const { invoke, api } = setup();
    for (const bad of [[], [123456], [null], [{ code: "123456" }], ["1".repeat(65)], ["123456", "extra"]]) {
      await expect(invoke(IPC_CHANNELS.enroll, ...bad)).rejects.toBeInstanceOf(InvalidPayloadError);
    }
    expect(api.enroll).not.toHaveBeenCalled();

    await invoke(IPC_CHANNELS.enroll, "12ab");
    expect(api.enroll).toHaveBeenCalledWith("12ab");
  });

  it("setChannel accepts only the known channels", async () => {
    const { invoke, api } = setup();
    for (const bad of [[], ["nightly"], [""], [1], ["stable", "preview"]]) {
      await expect(invoke(IPC_CHANNELS.setChannel, ...bad)).rejects.toBeInstanceOf(InvalidPayloadError);
    }
    expect(api.setChannel).not.toHaveBeenCalled();

    await invoke(IPC_CHANNELS.setChannel, "preview");
    expect(api.setChannel).toHaveBeenCalledWith("preview");
  });

  it("reports a rejected payload without its content", async () => {
    const { invoke, onRejected } = setup();
    await invoke(IPC_CHANNELS.enroll, 5).catch(() => undefined);
    expect(onRejected).toHaveBeenCalledWith(IPC_CHANNELS.enroll, "invalid_payload");
    expect(JSON.stringify(onRejected.mock.calls)).not.toContain("5,");
  });

  it("returns what the handler returns", async () => {
    const { invoke } = setup();
    await expect(invoke(IPC_CHANNELS.enroll, "123456")).resolves.toEqual({ ok: true });
  });
});

describe("sender check", () => {
  it("refuses every channel from an untrusted sender, before validating or running anything", async () => {
    const { invoke, api, onRejected } = setup(false);
    for (const channel of INVOKE_CHANNELS) {
      await expect(invoke(channel)).rejects.toBeInstanceOf(InvalidPayloadError);
    }
    for (const method of Object.values(api)) expect(method).not.toHaveBeenCalled();
    expect(onRejected).toHaveBeenCalledWith(IPC_CHANNELS.quit, "untrusted_sender");
  });
});

describe("isTrustedSender", () => {
  const trusted = { webContentsId: () => 7, pageUrl: "file:///Applications/Favor%20Printer.app/dist/renderer/index.html" };
  const event = (patch: Partial<IpcEventLike> = {}): IpcEventLike => ({
    sender: { id: 7 },
    senderFrame: { url: trusted.pageUrl },
    ...patch,
  });

  it("accepts the setup window's own page", () => {
    expect(isTrustedSender(event(), trusted)).toBe(true);
  });

  it("ignores a query or fragment on that page", () => {
    expect(isTrustedSender(event({ senderFrame: { url: `${trusted.pageUrl}?state=revoked#x` } }), trusted)).toBe(true);
  });

  it.each([
    ["another window", { sender: { id: 8 } }],
    ["another file", { senderFrame: { url: "file:///tmp/evil.html" } }],
    ["a remote page", { senderFrame: { url: "https://evil.example/index.html" } }],
    ["a page that only starts the same", { senderFrame: { url: `${trusted.pageUrl}.evil.html` } }],
    ["no frame", { senderFrame: null }],
    ["an empty url", { senderFrame: { url: "" } }],
  ])("refuses %s", (_name, patch) => {
    expect(isTrustedSender(event(patch as Partial<IpcEventLike>), trusted)).toBe(false);
  });

  it("refuses everything while no window is open", () => {
    expect(isTrustedSender(event(), { ...trusted, webContentsId: () => null })).toBe(false);
  });
});

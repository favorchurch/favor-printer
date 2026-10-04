/**
 * Main's side of the renderer API. Each channel has a validator for its
 * arguments, and a message from anything but the setup window's own page is
 * refused before the handler runs. An invalid payload rejects the renderer's
 * promise; nothing from it reaches the controller.
 */

import { IPC_CHANNELS, isUpdateChannel, type FavorPrinterApi, type IpcChannel } from "../../shared";
import type { AppController } from "./controller";

export class InvalidPayloadError extends Error {
  constructor(channel: string) {
    super(`Invalid payload for ${channel}`);
    this.name = "InvalidPayloadError";
  }
}

const MAX_DEVICE_ID_LENGTH = 2048;
const MAX_CODE_INPUT_LENGTH = 64;

type Validator<Args extends unknown[]> = (args: unknown[]) => Args | null;

const none: Validator<[]> = (args) => (args.length === 0 ? [] : null);

const one =
  <T>(check: (value: unknown) => value is T): Validator<[T]> =>
  (args) =>
    args.length === 1 && check(args[0]) ? [args[0]] : null;

const isBoolean = (value: unknown): value is boolean => typeof value === "boolean";
const isDeviceId = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= MAX_DEVICE_ID_LENGTH;
/** Any short string: the controller decides whether it is a valid code, and says so in its reply. */
const isCodeInput = (value: unknown): value is string => typeof value === "string" && value.length <= MAX_CODE_INPUT_LENGTH;

/** Channels the renderer invokes, each with the method it maps to on the API. */
type InvokeChannels = Exclude<IpcChannel, typeof IPC_CHANNELS.snapshot>;

export const VALIDATORS: Record<InvokeChannels, Validator<never[]> | Validator<[string]> | Validator<[boolean]>> = {
  [IPC_CHANNELS.getSnapshot]: none,
  [IPC_CHANNELS.scanPrinters]: none,
  [IPC_CHANNELS.selectPrinter]: one(isDeviceId),
  [IPC_CHANNELS.setUpPrinter]: none,
  [IPC_CHANNELS.openPrinterSettings]: none,
  [IPC_CHANNELS.enroll]: one(isCodeInput),
  [IPC_CHANNELS.requestTestPrint]: none,
  [IPC_CHANNELS.confirmTestPrint]: one(isBoolean),
  [IPC_CHANNELS.setPaused]: one(isBoolean),
  [IPC_CHANNELS.setOpenAtLogin]: one(isBoolean),
  [IPC_CHANNELS.setChannel]: one((value): value is string => isUpdateChannel(value)),
  [IPC_CHANNELS.migrateLegacyRelay]: none,
  [IPC_CHANNELS.advance]: none,
  [IPC_CHANNELS.quit]: none,
};

export type IpcHandlers = {
  [Channel in InvokeChannels]: (...args: never[]) => Promise<unknown>;
};

/** The controller's methods, wired to their channels. */
/** `onSnapshot` is the renderer's own subscription: main pushes snapshots instead of answering a call. */
export function handlersFor(api: Omit<FavorPrinterApi, "onSnapshot">): IpcHandlers {
  return {
    [IPC_CHANNELS.getSnapshot]: () => api.getSnapshot(),
    [IPC_CHANNELS.scanPrinters]: () => api.scanPrinters(),
    [IPC_CHANNELS.selectPrinter]: (id: string) => api.selectPrinter(id),
    [IPC_CHANNELS.setUpPrinter]: () => api.setUpPrinter(),
    [IPC_CHANNELS.openPrinterSettings]: () => api.openPrinterSettings(),
    [IPC_CHANNELS.enroll]: (code: string) => api.enroll(code),
    [IPC_CHANNELS.requestTestPrint]: () => api.requestTestPrint(),
    [IPC_CHANNELS.confirmTestPrint]: (came: boolean) => api.confirmTestPrint(came),
    [IPC_CHANNELS.setPaused]: (paused: boolean) => api.setPaused(paused),
    [IPC_CHANNELS.setOpenAtLogin]: (enabled: boolean) => api.setOpenAtLogin(enabled),
    [IPC_CHANNELS.setChannel]: (channel: string) => api.setChannel(channel as Parameters<FavorPrinterApi["setChannel"]>[0]),
    [IPC_CHANNELS.migrateLegacyRelay]: () => api.migrateLegacyRelay(),
    [IPC_CHANNELS.advance]: () => api.advance(),
    [IPC_CHANNELS.quit]: () => api.quit(),
  };
}

/** The renderer API as the controller answers it. `index.ts` and the privacy tests use this same mapping. */
export function apiFromController(controller: AppController, quit: () => Promise<void>): Omit<FavorPrinterApi, "onSnapshot"> {
  return {
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
    quit,
  };
}

export type IpcEventLike = { sender: { id: number }; senderFrame?: { url: string } | null };

export type IpcMainLike = {
  handle(channel: string, listener: (event: IpcEventLike, ...args: unknown[]) => unknown): void;
  removeHandler(channel: string): void;
};

/**
 * The page the window loads. Only a frame whose URL is exactly this file, in the
 * window main created, may call in: `file:` pages are otherwise all one origin.
 */
export function isTrustedSender(
  event: IpcEventLike,
  trusted: { webContentsId: () => number | null; pageUrl: string },
): boolean {
  if (trusted.webContentsId() !== event.sender.id) return false;
  const url = event.senderFrame?.url;
  if (!url) return false;
  // Ignore a query or hash: the preview fixtures use `?state=`.
  return url.split(/[?#]/)[0] === trusted.pageUrl;
}

export function registerIpcHandlers(deps: {
  ipcMain: IpcMainLike;
  handlers: IpcHandlers;
  isTrusted: (event: IpcEventLike) => boolean;
  onRejected?: (channel: string, reason: "untrusted_sender" | "invalid_payload") => void;
}): () => void {
  const channels = Object.keys(VALIDATORS) as InvokeChannels[];
  for (const channel of channels) {
    deps.ipcMain.handle(channel, async (event, ...args) => {
      if (!deps.isTrusted(event)) {
        deps.onRejected?.(channel, "untrusted_sender");
        throw new InvalidPayloadError(channel);
      }
      const parsed = (VALIDATORS[channel] as Validator<unknown[]>)(args);
      if (!parsed) {
        deps.onRejected?.(channel, "invalid_payload");
        throw new InvalidPayloadError(channel);
      }
      return (deps.handlers[channel] as (...values: unknown[]) => Promise<unknown>)(...parsed);
    });
  }
  return () => {
    for (const channel of channels) deps.ipcMain.removeHandler(channel);
  };
}

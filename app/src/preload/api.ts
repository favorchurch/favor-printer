/**
 * The renderer's whole view of the app. Each method is one `invoke` on a fixed
 * channel with plain arguments: no `ipcRenderer`, no event object and no
 * channel name ever reaches the page.
 */

import { IPC_CHANNELS, type AppSnapshot, type FavorPrinterApi } from "../shared";

export type IpcRendererLike = {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  on(channel: string, listener: (event: unknown, ...args: unknown[]) => void): unknown;
  removeListener(channel: string, listener: (event: unknown, ...args: unknown[]) => void): unknown;
};

export function createApi(ipc: IpcRendererLike): FavorPrinterApi {
  const call = <T>(channel: string, ...args: unknown[]) => ipc.invoke(channel, ...args) as Promise<T>;
  return {
    getSnapshot: () => call(IPC_CHANNELS.getSnapshot),
    onSnapshot(listener) {
      const wrapped = (_event: unknown, snapshot: unknown) => listener(snapshot as AppSnapshot);
      ipc.on(IPC_CHANNELS.snapshot, wrapped);
      return () => void ipc.removeListener(IPC_CHANNELS.snapshot, wrapped);
    },
    scanPrinters: () => call(IPC_CHANNELS.scanPrinters),
    selectPrinter: (deviceId) => call(IPC_CHANNELS.selectPrinter, deviceId),
    setUpPrinter: () => call(IPC_CHANNELS.setUpPrinter),
    openPrinterSettings: () => call(IPC_CHANNELS.openPrinterSettings),
    enroll: (code) => call(IPC_CHANNELS.enroll, code),
    requestTestPrint: () => call(IPC_CHANNELS.requestTestPrint),
    confirmTestPrint: (labelCameOut) => call(IPC_CHANNELS.confirmTestPrint, labelCameOut),
    setPaused: (paused) => call(IPC_CHANNELS.setPaused, paused),
    setOpenAtLogin: (enabled) => call(IPC_CHANNELS.setOpenAtLogin, enabled),
    setChannel: (channel) => call(IPC_CHANNELS.setChannel, channel),
    migrateLegacyRelay: () => call(IPC_CHANNELS.migrateLegacyRelay),
    advance: () => call(IPC_CHANNELS.advance),
    quit: () => call(IPC_CHANNELS.quit),
  };
}

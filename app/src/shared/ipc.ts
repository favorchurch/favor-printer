/**
 * The renderer's only way to reach the app: `window.favorPrinter`, exposed by the
 * preload script. Main validates every payload it receives (see IPC_CHANNELS).
 * The renderer runs standalone with a mock of this API when it is absent.
 */

import type { UpdateChannel } from "./constants";
import type { AppSnapshot } from "./status";

export const IPC_CHANNELS = {
  getSnapshot: "favor-printer:get-snapshot",
  snapshot: "favor-printer:snapshot",
  scanPrinters: "favor-printer:scan-printers",
  selectPrinter: "favor-printer:select-printer",
  setUpPrinter: "favor-printer:set-up-printer",
  openPrinterSettings: "favor-printer:open-printer-settings",
  enroll: "favor-printer:enroll",
  requestTestPrint: "favor-printer:request-test-print",
  confirmTestPrint: "favor-printer:confirm-test-print",
  setPaused: "favor-printer:set-paused",
  setOpenAtLogin: "favor-printer:set-open-at-login",
  setChannel: "favor-printer:set-channel",
  migrateLegacyRelay: "favor-printer:migrate-legacy-relay",
  advance: "favor-printer:advance",
  quit: "favor-printer:quit",
} as const;

export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS];

export type EnrollResult =
  | { ok: true }
  | { ok: false; reason: "invalid_code" | "throttled" | "disabled" | "unreachable" | "invalid_request" };

export type SetUpPrinterResult =
  | { ok: true }
  /** `permission`: macOS refused lpadmin, so the app guides the volunteer through System Settings. */
  | { ok: false; reason: "permission" | "failed" };

export type TestPrintResult =
  /** The relay handed the label to CUPS. This is not proof a label printed. */
  | { ok: true }
  | { ok: false; reason: "no_printer" | "paused" | "busy" | "failed" };

export type MigrateLegacyResult =
  | { ok: true }
  | { ok: false; reason: "bootout_failed" | "disable_failed" };

export type FavorPrinterApi = {
  getSnapshot(): Promise<AppSnapshot>;
  /** Returns an unsubscribe function. */
  onSnapshot(listener: (snapshot: AppSnapshot) => void): () => void;
  scanPrinters(): Promise<AppSnapshot>;
  selectPrinter(deviceId: string): Promise<AppSnapshot>;
  setUpPrinter(): Promise<SetUpPrinterResult>;
  openPrinterSettings(): Promise<void>;
  enroll(code: string): Promise<EnrollResult>;
  requestTestPrint(): Promise<TestPrintResult>;
  /** The volunteer's answer to "Did a label come out?". */
  confirmTestPrint(labelCameOut: boolean): Promise<void>;
  setPaused(paused: boolean): Promise<void>;
  setOpenAtLogin(enabled: boolean): Promise<void>;
  setChannel(channel: UpdateChannel): Promise<void>;
  migrateLegacyRelay(): Promise<MigrateLegacyResult>;
  /** Moves the setup window to its next step. Main decides whether the step is reachable. */
  advance(): Promise<AppSnapshot>;
  quit(): Promise<void>;
};

declare global {
  interface Window {
    favorPrinter?: FavorPrinterApi;
  }
}

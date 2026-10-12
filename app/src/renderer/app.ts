/** Connects the screens to the preload API: one render loop, and one local state object. */

import type { AppSnapshot, FavorPrinterApi, RenameResult } from "../shared";
import { INITIAL_LOCAL, pickScreen, type LocalState, type RenameTarget } from "./model";
import { renderScreen, type Actions } from "./screens";

export type AppOptions = { initialLocal?: Partial<LocalState>; closeWindow?: () => void };

export function startApp(root: HTMLElement, api: FavorPrinterApi, snapshot: AppSnapshot, options: AppOptions = {}) {
  let current = snapshot;
  let local: LocalState = { ...INITIAL_LOCAL, ...options.initialLocal };
  let shownScreen: string | null = null;
  let disposed = false;

  const render = () => {
    // A stopped app (the preview switched to another fixture) never draws again, even from a late reply.
    if (disposed) return;
    const screen = pickScreen(current, local);
    const view = renderScreen(screen, { snapshot: current, local, actions });
    root.replaceChildren(view);
    // A new screen starts at its title, so a screen reader announces it.
    if (screen !== shownScreen) {
      shownScreen = screen;
      const target = view.querySelector<HTMLElement>("input, h1");
      target?.focus({ preventScroll: true });
    }
  };

  const patch = (next: Partial<LocalState>) => {
    local = { ...local, ...next };
    render();
  };

  /** Runs an action with its buttons disabled. A rejected call (invalid payload) just re-enables them. */
  const busy = async <T>(work: () => Promise<T>): Promise<T | undefined> => {
    patch({ busy: true });
    try {
      return await work();
    } catch {
      return undefined;
    } finally {
      patch({ busy: false });
    }
  };

  const applySnapshot = (next: AppSnapshot) => {
    // A new step starts clean: an old error does not follow the volunteer forward.
    if (next.setupStep !== current.setupStep) {
      local = { ...local, codeError: null, codeConflict: null, setUpRefused: false, testPrint: { kind: "idle" }, confirmingMigration: false, migrateError: false, renameError: null };
    }
    current = next;
    render();
  };

  /** A failed rename keeps what was typed and says why. A success reads back the stored name from main. */
  const rename = async (target: RenameTarget, name: string, call: () => Promise<RenameResult>) => {
    const result = await call();
    local = { ...local, renameError: result.ok ? null : { target, reason: result.reason, name } };
    applySnapshot(await api.getSnapshot());
  };

  const actions: Actions = {
    advance: () => void busy(async () => applySnapshot(await api.advance())),
    scanAgain: () => void busy(async () => applySnapshot(await api.scanPrinters())),
    selectPrinter: (deviceId) => void busy(async () => applySnapshot(await api.selectPrinter(deviceId))),
    setUpPrinter: () =>
      void busy(async () => {
        const result = await api.setUpPrinter();
        if (!result.ok && result.reason === "permission") local = { ...local, setUpRefused: true };
        applySnapshot(await api.getSnapshot());
      }),
    openPrinterSettings: () => void api.openPrinterSettings().catch(() => undefined),
    submitCode: (code) =>
      void busy(async () => {
        local = { ...local, codeError: null, codeConflict: null };
        const result = await api.enroll(code);
        if (!result.ok) {
          patch(result.reason === "printer_conflict" ? { codeConflict: result.conflict } : { codeError: result.reason });
          return;
        }
        applySnapshot(await api.getSnapshot());
      }),
    requestTestPrint: () =>
      void (async () => {
        patch({ testPrint: { kind: "sending" } });
        try {
          const result = await api.requestTestPrint();
          patch({ testPrint: result.ok ? { kind: "sent" } : { kind: "failed", reason: result.reason } });
        } catch {
          patch({ testPrint: { kind: "failed", reason: "failed" } });
        }
      })(),
    answerLabel: (cameOut) =>
      void busy(async () => {
        await api.confirmTestPrint(cameOut);
        if (cameOut) applySnapshot(await api.advance());
        else patch({ testPrint: { kind: "no-label" } });
      }),
    askMigrateLegacy: () => patch({ confirmingMigration: true }),
    cancelMigrateLegacy: () => patch({ confirmingMigration: false }),
    migrateLegacy: () =>
      void busy(async () => {
        // Only reachable from the confirmation screen.
        const result = await api.migrateLegacyRelay().catch(() => ({ ok: false }) as const);
        local = { ...local, confirmingMigration: false, migrateError: !result.ok };
        applySnapshot(await api.getSnapshot());
      }),
    renameLaptop: (name) => void busy(() => rename("laptop", name, () => api.renameLaptop(name))),
    renamePrinter: (name) => void busy(() => rename("printer", name, () => api.renamePrinter(name))),
    closeWindow: options.closeWindow ?? (() => window.close()),
  };

  const unsubscribe = api.onSnapshot(applySnapshot);
  render();
  return () => {
    disposed = true;
    unsubscribe();
  };
}

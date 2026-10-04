/** Connects the screens to the preload API: one render loop, and one local state object. */

import type { AppSnapshot, FavorPrinterApi } from "../shared";
import { INITIAL_LOCAL, pickScreen, type LocalState } from "./model";
import { renderScreen, type Actions } from "./screens";

export type AppOptions = { initialLocal?: Partial<LocalState>; closeWindow?: () => void };

export function startApp(root: HTMLElement, api: FavorPrinterApi, snapshot: AppSnapshot, options: AppOptions = {}) {
  let current = snapshot;
  let local: LocalState = { ...INITIAL_LOCAL, ...options.initialLocal };
  let shownScreen: string | null = null;

  const render = () => {
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
      local = { ...local, codeError: null, setUpRefused: false, testPrint: { kind: "idle" }, migrateError: false };
    }
    current = next;
    render();
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
        local = { ...local, codeError: null };
        const result = await api.enroll(code);
        if (!result.ok) {
          patch({ codeError: result.reason });
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
    migrateLegacy: () =>
      void busy(async () => {
        const result = await api.migrateLegacyRelay();
        local = { ...local, migrateError: !result.ok };
        applySnapshot(await api.getSnapshot());
      }),
    closeWindow: options.closeWindow ?? (() => window.close()),
  };

  const unsubscribe = api.onSnapshot(applySnapshot);
  render();
  return () => unsubscribe();
}

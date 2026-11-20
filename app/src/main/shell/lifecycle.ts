/** App-level rules that are not about printing: one instance, and keeping the app alive with no window. */

export type SingleInstanceApp = {
  requestSingleInstanceLock(): boolean;
  on(event: "second-instance", listener: () => void): unknown;
};

export type ActivateApp = {
  on(event: "activate", listener: () => void): unknown;
};

/**
 * True when this process is the only instance. A second launch returns false
 * (the caller quits) and asks the first one to show itself.
 */
export function acquireSingleInstance(app: SingleInstanceApp, onSecondInstance: () => void): boolean {
  if (!app.requestSingleInstanceLock()) return false;
  app.on("second-instance", onSecondInstance);
  return true;
}

/** Shows the window when macOS reopens the running app (e.g. Finder/Spotlight/Dock). */
export function wireActivate(app: ActivateApp, onActivate: () => void): void {
  app.on("activate", onActivate);
}

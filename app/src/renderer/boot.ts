import type { AppSnapshot, FavorPrinterApi } from "../shared";
import type { AppOptions } from "./app";
import { createMockApi, fixtureFor, stateFromLocation } from "./fixtures";
import { shouldShowFixtureBar, startPreview } from "./preview";

export type BootDeps = {
  /** `window.favorPrinter`: present inside Electron, absent in the preview server. */
  api: FavorPrinterApi | undefined;
  root: HTMLElement;
  body: HTMLElement;
  /** Carry `data-fixture-active` in preview. */
  markers: HTMLElement[];
  search: string;
  hash: string;
  start(root: HTMLElement, api: FavorPrinterApi, snapshot: AppSnapshot, options?: AppOptions): () => void;
};

export function boot(deps: BootDeps): void {
  if (!shouldShowFixtureBar(deps.api)) {
    // Inside Electron: the real API and the real snapshot, and no preview controls of any kind.
    const api = deps.api as FavorPrinterApi;
    void api.getSnapshot().then((snapshot) => deps.start(deps.root, api, snapshot));
    return;
  }

  startPreview({
    body: deps.body,
    markers: deps.markers,
    requested: stateFromLocation(deps.search, deps.hash),
    fixtureFor,
    run: (fixture) =>
      deps.start(deps.root, createMockApi(fixture.snapshot, { failMigration: fixture.failMigration }), fixture.snapshot, {
        initialLocal: fixture.local,
      }),
  });
}

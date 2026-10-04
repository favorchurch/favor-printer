import { startApp } from "./app";
import { createMockApi, fixtureFor, stateFromLocation } from "./fixtures";

const root = document.getElementById("root");
if (!root) throw new Error("#root is missing");

const api = window.favorPrinter;
if (api) {
  void api.getSnapshot().then((snapshot) => startApp(root, api, snapshot));
} else {
  // Opened outside Electron (pnpm preview:renderer): run on fixtures.
  const fixture = fixtureFor(stateFromLocation(window.location.search, window.location.hash));
  startApp(root, createMockApi(fixture.snapshot, { failMigration: fixture.failMigration }), fixture.snapshot, {
    initialLocal: fixture.local,
  });
}

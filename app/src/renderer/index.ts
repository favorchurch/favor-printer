import { startApp } from "./app";
import { createMockApi, fixtureFor } from "./fixtures";

const root = document.getElementById("root");
if (!root) throw new Error("#root is missing");

const api = window.favorPrinter;
if (api) {
  void api.getSnapshot().then((snapshot) => startApp(root, api, snapshot));
} else {
  // Opened outside Electron (pnpm preview:renderer): run on fixtures.
  const fixture = fixtureFor(new URLSearchParams(window.location.search).get("state"));
  startApp(root, createMockApi(fixture.snapshot), fixture.snapshot, { initialLocal: fixture.local });
}

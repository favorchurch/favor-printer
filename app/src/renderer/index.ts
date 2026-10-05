import { startApp } from "./app";
import { boot } from "./boot";

const root = document.getElementById("root");
if (!root) throw new Error("#root is missing");

boot({
  api: window.favorPrinter,
  root,
  body: document.body,
  markers: [root, document.documentElement],
  search: window.location.search,
  hash: window.location.hash,
  start: startApp,
});

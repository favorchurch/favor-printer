/**
 * The preview-only fixture switcher. It exists for `pnpm preview:renderer`, where there is no Electron
 * and no preload API, so a visual check can open every screen by clicking a button. Inside Electron
 * `window.favorPrinter` exists and none of this is rendered.
 */

import { h } from "./dom";
import { FIXTURE_NAMES, normalizeFixtureName, type Fixture, type FixtureName } from "./fixtures";

/** True only when there is no preload API, which is the preview server and nothing else. */
export function shouldShowFixtureBar(api: unknown): boolean {
  return api === undefined || api === null;
}

/** One button per fixture, `data-fixture=<name>`. The active one is marked with `aria-pressed`. */
export function fixtureButtons(active: FixtureName, onSelect: (name: FixtureName) => void): HTMLElement[] {
  return FIXTURE_NAMES.map((name) =>
    h(
      "button",
      {
        type: "button",
        "data-fixture": name,
        "aria-pressed": name === active ? "true" : "false",
        onclick: () => onSelect(name),
      },
      name,
    ),
  );
}

export type PreviewDeps = {
  /** Where the bar goes. */
  body: HTMLElement;
  /** Elements that carry `data-fixture-active=<name>`: the app root, and the page root. */
  markers: HTMLElement[];
  /** `?state=` or `#state=` as the page was opened with, or null. */
  requested: string | null;
  /** Renders a fixture into the app root and returns a function that stops it. */
  run(fixture: Fixture): () => void;
  fixtureFor(name: FixtureName): Fixture;
};

export type Preview = { select(name: FixtureName): void; active(): FixtureName; bar: HTMLElement };

export function startPreview(deps: PreviewDeps): Preview {
  let active = normalizeFixtureName(deps.requested);
  let stop: (() => void) | null = null;

  const bar = h("nav", { class: "fixture-bar", "aria-label": "Preview states", "data-preview-only": "" });

  const select = (name: FixtureName) => {
    stop?.();
    active = name;
    for (const marker of deps.markers) marker.setAttribute("data-fixture-active", name);
    bar.replaceChildren(...fixtureButtons(name, select));
    stop = deps.run(deps.fixtureFor(name));
  };

  deps.body.setAttribute("data-preview", "");
  deps.body.append(bar);
  select(active);
  return { select, active: () => active, bar };
}

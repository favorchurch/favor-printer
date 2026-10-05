/** A small element builder. Text is always set as text, never as HTML. */

type Child = Node | string | null | false | undefined;

export type Props = {
  class?: string;
  id?: string;
  type?: string;
  disabled?: boolean;
  hidden?: boolean;
  tabIndex?: number;
  onclick?: (event: MouseEvent) => void;
  onsubmit?: (event: SubmitEvent) => void;
  oninput?: (event: Event) => void;
  [attribute: string]: unknown;
};

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Props | null = null,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") element.className = String(value);
    else if (key.startsWith("on") && typeof value === "function") {
      element.addEventListener(key.slice(2), value as EventListener);
    } else if (key === "disabled" || key === "hidden") (element as unknown as Record<string, unknown>)[key] = value;
    else if (key === "tabIndex") element.tabIndex = value as number;
    else element.setAttribute(key, value === true ? "" : String(value));
  }
  for (const child of children) {
    if (child === null || child === false || child === undefined) continue;
    element.append(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return element;
}

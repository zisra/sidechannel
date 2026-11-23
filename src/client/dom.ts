import {
  ArrowDown, Bell, BellOff, Check, Copy, Ellipsis, Lock, Minus, Pencil, Plus, Reply, SendHorizontal, Trash2, WifiOff, X,
  createElement, type IconNode,
} from "lucide";

type Child = Node | string | null | undefined | false;
type Attrs = Record<string, string | number | boolean | EventListener | null | undefined>;

// Small element builder: h("button", { class: "btn", onclick }, "Label").
// Strings become text nodes, so user content is never parsed as HTML.
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) {
    if (value == null || value === false) continue;
    if (typeof value === "function") el.addEventListener(name.slice(2), value);
    // Through CSSOM, which the Content-Security-Policy allows (style attributes it doesn't).
    else if (name === "style") el.style.cssText = String(value);
    else el.setAttribute(name, value === true ? "" : String(value));
  }
  el.append(...children.filter((c): c is Node | string => c != null && c !== false));
  return el;
}

export function mount(view: Node) {
  document.getElementById("app")!.replaceChildren(view);
}

const ICONS = {
  copy: Copy,
  check: Check,
  send: SendHorizontal,
  lock: Lock,
  minus: Minus,
  plus: Plus,
  down: ArrowDown,
  dots: Ellipsis,
  edit: Pencil,
  trash: Trash2,
  reply: Reply,
  close: X,
  bell: Bell,
  bellOff: BellOff,
  offline: WifiOff,
} satisfies Record<string, IconNode>;

export type IconName = keyof typeof ICONS;

export function icon(name: IconName): HTMLElement {
  const span = h("span", { class: "icon", "aria-hidden": "true" });
  span.append(createElement(ICONS[name]));
  return span;
}

export function logo(): HTMLElement {
  const span = h("span", { class: "logo", "aria-hidden": "true" });
  span.innerHTML =
    '<svg viewBox="0 0 32 32">' +
    '<rect x="7" y="5" width="6" height="22" rx="3" fill="currentColor"/>' +
    '<rect class="branch" x="19" y="13" width="6" height="14" rx="3"/></svg>';
  return span;
}

// A short confirmation at the bottom of the screen. Lives outside #app so it
// survives switching views.
let toastTimer = 0;
export function toast(text: string) {
  let el = document.querySelector<HTMLElement>(".toast");
  if (!el) {
    el = h("div", { class: "toast", role: "status" });
    document.body.append(el);
  }
  el.replaceChildren(icon("check"), text);
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el!.classList.remove("show"), 2200);
}

export async function copyText(text: string | Promise<string>): Promise<boolean> {
  try {
    // A promise-backed ClipboardItem keeps the click's permission alive in
    // Safari while the text is still being fetched.
    if (typeof ClipboardItem !== "undefined" && text instanceof Promise) {
      const blob = text.then((t) => new Blob([t], { type: "text/plain" }));
      await navigator.clipboard.write([new ClipboardItem({ "text/plain": blob })]);
    } else {
      await navigator.clipboard.writeText(await text);
    }
    return true;
  } catch {
    return false;
  }
}

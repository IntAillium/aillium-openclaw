import type { BrowserContext, Page } from "playwright-core";
import { getPlaywrightBrowser } from "./pw-session.js";

/**
 * Aillium's on-page overlay. It tells anyone looking at the browser who is in
 * charge: Aillium is in control, Aillium needs a decision, or Aillium has let go.
 *
 * It is drawn in a closed shadow root, hidden from accessibility snapshots, and
 * never takes clicks, so it does not change what the agent reads or does.
 */

export type AilliumOverlayState = "control" | "decision" | "released" | "off";

export type AilliumOverlayStatus = {
  state: AilliumOverlayState;
  message: string | null;
  updatedAt: string;
};

const MESSAGE_MAX = 140;

const statusByCdpUrl = new Map<string, AilliumOverlayStatus>();
const hookedContexts = new WeakSet<BrowserContext>();
const hookedPages = new WeakSet<Page>();

export function normalizeOverlayState(raw: unknown): AilliumOverlayState | null {
  return raw === "control" || raw === "decision" || raw === "released" || raw === "off"
    ? raw
    : null;
}

export function getAilliumOverlayStatus(cdpUrl: string): AilliumOverlayStatus {
  return (
    statusByCdpUrl.get(cdpUrl) ?? {
      state: "off",
      message: null,
      updatedAt: new Date(0).toISOString(),
    }
  );
}

/** Runs inside the page. Must not reference anything outside itself. */
function renderOverlay(input: { state: string; message: string | null }) {
  const TAG = "aillium-overlay";
  const w = window as unknown as { __ailliumOverlay?: { host: HTMLElement; root: ShadowRoot } };
  if (input.state === "off") {
    w.__ailliumOverlay?.host.remove();
    w.__ailliumOverlay = undefined;
    return;
  }
  let entry = w.__ailliumOverlay;
  if (!entry || !entry.host.isConnected) {
    const host = document.createElement(TAG);
    host.setAttribute("aria-hidden", "true");
    host.setAttribute("inert", "");
    host.style.cssText =
      "all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none;display:block;";
    const root = host.attachShadow({ mode: "closed" });
    (document.documentElement ?? document).appendChild(host);
    entry = { host, root };
    w.__ailliumOverlay = entry;
  }
  const palette: Record<string, { color: string; title: string; hint: string }> = {
    control: {
      color: "#7c5cff",
      title: "Aillium is in control",
      hint: "Watch or take over from the Live work panel.",
    },
    decision: {
      color: "#f5a524",
      title: "Decision needed",
      hint: "Approve or reject in Aillium. Nothing more happens until you do.",
    },
    released: {
      color: "#17c964",
      title: "Aillium has let go",
      hint: "You are in control of this browser.",
    },
  };
  const look = palette[input.state] ?? palette.control;
  // Built with DOM calls, not innerHTML, so pages with Trusted Types still show it.
  const css = [
    `.frame{position:fixed;inset:0;border:3px solid ${look.color};box-sizing:border-box;}`,
    `.pill{position:fixed;top:8px;left:50%;transform:translateX(-50%);max-width:min(560px,90vw);`,
    `background:rgba(17,17,23,.88);color:#fff;border:1px solid ${look.color};border-radius:12px;`,
    `padding:6px 12px;font:500 12px/1.35 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;`,
    `box-shadow:0 4px 18px rgba(0,0,0,.25);}`,
    `.t{display:flex;align-items:center;gap:6px;font-weight:650}`,
    `.dot{width:8px;height:8px;border-radius:50%;background:${look.color};flex:none}`,
    `.m{margin-top:2px;font-weight:600;color:${look.color}}`,
    `.h{margin-top:2px;opacity:.75}`,
    `.decision .frame{animation:pulse 1.6s ease-in-out infinite}`,
    `.released .frame,.released .pill{animation:fade 8s forwards}`,
    `@keyframes pulse{0%,100%{opacity:1}50%{opacity:.35}}`,
    `@keyframes fade{0%,70%{opacity:1}100%{opacity:0}}`,
    `@media (prefers-reduced-motion: reduce){.frame,.pill{animation:none!important}}`,
  ].join("");
  const el = (tag: string, className: string, textValue?: string) => {
    const node = document.createElement(tag);
    if (className) {
      node.className = className;
    }
    if (textValue) {
      node.textContent = textValue;
    }
    return node;
  };
  const style = el("style", "");
  style.textContent = css;
  const wrap = el("div", input.state);
  const pill = el("div", "pill");
  const title = el("div", "t");
  title.append(el("span", "dot"), document.createTextNode(look.title));
  pill.append(title);
  if (input.message) {
    pill.append(el("div", "m", input.message));
  }
  pill.append(el("div", "h", look.hint));
  wrap.append(el("div", "frame"), pill);
  entry.root.replaceChildren(style, wrap);
}

// Sent as source text. Bundlers may wrap named functions in a `__name(...)` helper
// that does not exist in the page, so the page gets a no-op one.
const RENDER_SOURCE = renderOverlay.toString();

export function overlayScript(status: Pick<AilliumOverlayStatus, "state" | "message">): string {
  const input = JSON.stringify({ state: status.state, message: status.message });
  return `(() => { const __name = (f) => f; (${RENDER_SOURCE})(${input}); })()`;
}

async function paint(page: Page, status: AilliumOverlayStatus) {
  if (page.isClosed()) {
    return;
  }
  await page.evaluate(overlayScript(status)).catch(() => undefined);
}

function hookPage(page: Page, cdpUrl: string) {
  if (hookedPages.has(page)) {
    return;
  }
  hookedPages.add(page);
  // A new document starts without the overlay; draw it again on every load.
  page.on("domcontentloaded", () => {
    void paint(page, getAilliumOverlayStatus(cdpUrl));
  });
}

function hookContext(context: BrowserContext, cdpUrl: string) {
  if (hookedContexts.has(context)) {
    return;
  }
  hookedContexts.add(context);
  context.on("page", (page) => {
    hookPage(page, cdpUrl);
    void paint(page, getAilliumOverlayStatus(cdpUrl));
  });
}

/** Shows the overlay state on every open page of the browser and on pages opened later. */
export async function setAilliumOverlayViaPlaywright(opts: {
  cdpUrl: string;
  state: AilliumOverlayState;
  message?: string | null;
}): Promise<AilliumOverlayStatus & { pages: number; previous: AilliumOverlayState }> {
  const message = opts.message?.replace(/\s+/g, " ").trim().slice(0, MESSAGE_MAX) || null;
  const status: AilliumOverlayStatus = {
    state: opts.state,
    message,
    updatedAt: new Date().toISOString(),
  };
  const previous = getAilliumOverlayStatus(opts.cdpUrl).state;
  statusByCdpUrl.set(opts.cdpUrl, status);
  const browser = await getPlaywrightBrowser(opts.cdpUrl);
  let pages = 0;
  for (const context of browser.contexts()) {
    hookContext(context, opts.cdpUrl);
    for (const page of context.pages()) {
      hookPage(page, opts.cdpUrl);
      pages += 1;
      await paint(page, status);
    }
  }
  return { ...status, pages, previous };
}

export function resetAilliumOverlayForTest(): void {
  statusByCdpUrl.clear();
}

export const __test = { renderOverlay };

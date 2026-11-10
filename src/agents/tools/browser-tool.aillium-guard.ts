import { isAilliumCoreConfigured } from "../../aillium/boundary-runtime.js";
import { toAgentRequestSessionKey } from "../../routing/session-key.js";

/**
 * Aillium safety gate for the agent's browser tool.
 *
 * When OpenClaw runs inside Aillium, a click that would finish something
 * (pay, place an order, submit, send, delete, book) needs the owner's approval
 * first. The tool refuses the step and tells the agent to raise an approval;
 * Aillium Core grants it through the gateway once the owner approves, and the
 * agent then repeats the same step.
 */

export type FinalActionCategory = "payment" | "delete" | "send" | "submit";

type RefInfo = { role: string; name?: string };

// Labels are judged by how they start ("Pay £84.20", "Place your order"), so links
// such as "Purchase history" or "Share feedback" in a footer stay ordinary clicks.
const PAYMENT_ANYWHERE =
  /\b(pay\s+now|place\s+(my\s+|your\s+|the\s+)?order|confirm\s+and\s+pay|complete\s+(purchase|payment)|submit\s+(payment|order)|buy\s+now)\b/i;
// Labels that only show records ("Purchase history", "Payment details") are not final steps.
const RECORDS_AFTER = String.raw`(?!\s+(history|details|summary|records?|methods?|options|settings|list|status)\b)`;
const PAYMENT = new RegExp(
  String.raw`^(pay|buy|purchase|order\s+now|checkout\s+and\s+pay|confirm\s+(purchase|payment|order|booking)|complete\s+(order|checkout)|subscribe|upgrade|donate|transfer|top\s+up|send\s+(money|payment))\b` +
    RECORDS_AFTER,
  "i",
);
const DELETE =
  /^(delete|remove\s+(account|all)|close\s+(my\s+)?account|cancel\s+(my\s+)?(subscription|account|membership|order|booking|plan)|deactivate|unsubscribe|erase)\b/i;
const SEND = /^(send|post|publish|reply|share\s+now|tweet)\b/i;
const SUBMIT =
  /^(submit|confirm|book|reserve|apply|register|sign\s+up|create\s+(an\s+)?account|accept\s+(terms|and\s+continue|offer)|agree\s+and|i\s+agree|finish|complete)\b/i;
// Cookie and consent banners use the same words but change nothing that matters.
const HARMLESS = /\b(cookies?|consent|privacy\s+(choices|settings)|preferences|choices)\b/i;
// Scripts that press buttons or send forms (the agent can run page scripts).
const SCRIPT_ACTS =
  /\.(click|submit|requestSubmit)\s*\(|dispatchEvent\s*\(|\bfetch\s*\(|XMLHttpRequest|sendBeacon/;
const CLICKABLE_ROLES = new Set([
  "button",
  "link",
  "menuitem",
  "option",
  "tab",
  "checkbox",
  "radio",
]);

/** The kind of final step a button label describes, or null for an ordinary click. */
export function classifyFinalAction(label: string | undefined | null): FinalActionCategory | null {
  const text = (label ?? "").replace(/\s+/g, " ").trim();
  if (!text || text.length > 120 || HARMLESS.test(text)) {
    return null;
  }
  if (PAYMENT.test(text) || PAYMENT_ANYWHERE.test(text)) {
    return "payment";
  }
  if (DELETE.test(text)) {
    return "delete";
  }
  if (SEND.test(text)) {
    return "send";
  }
  if (SUBMIT.test(text)) {
    return "submit";
  }
  return null;
}

export function isAilliumBrowserGuardEnabled(): boolean {
  const flag = process.env.AILLIUM_BROWSER_APPROVALS?.trim().toLowerCase();
  if (flag === "off" || flag === "false" || flag === "0") {
    return false;
  }
  if (flag === "on" || flag === "true" || flag === "1") {
    return true;
  }
  return isAilliumCoreConfigured();
}

// ---- approval grants (one-time, per agent session) ------------------------

const GRANT_TTL_MS = 30 * 60_000;
const grants = new Map<
  string,
  Array<{ category: FinalActionCategory | "any"; expiresAt: number }>
>();

/** Core's session key and the agent's store key name the same session in different forms. */
export function normalizeGrantSessionKey(sessionKey: string): string {
  return (toAgentRequestSessionKey(sessionKey) ?? sessionKey).trim().toLowerCase();
}

export function grantBrowserApproval(params: {
  sessionKey: string;
  category?: FinalActionCategory | "any";
  ttlMs?: number;
  now?: number;
}): void {
  const key = normalizeGrantSessionKey(params.sessionKey);
  if (!key) {
    return;
  }
  const now = params.now ?? Date.now();
  const list = (grants.get(key) ?? []).filter((g) => g.expiresAt > now);
  list.push({
    category: params.category ?? "any",
    expiresAt: now + (params.ttlMs ?? GRANT_TTL_MS),
  });
  grants.set(key, list);
}

/** Uses up one matching grant. Returns false when there is none. */
export function consumeBrowserApproval(
  sessionKey: string | undefined,
  category: FinalActionCategory,
  now = Date.now(),
): boolean {
  if (!sessionKey) {
    return false;
  }
  const key = normalizeGrantSessionKey(sessionKey);
  const list = (grants.get(key) ?? []).filter((g) => g.expiresAt > now);
  const index = list.findIndex((g) => g.category === category || g.category === "any");
  if (index < 0) {
    grants.set(key, list);
    return false;
  }
  list.splice(index, 1);
  grants.set(key, list);
  return true;
}

export function resetBrowserApprovalGrantsForTest(): void {
  grants.clear();
}

// ---- per-tool guard -------------------------------------------------------

export type GuardedAction = { category: FinalActionCategory; label: string };

export class BrowserFinalActionGuard {
  private readonly refsByTarget = new Map<string, Record<string, RefInfo>>();
  private lastTargetId = "";

  /** Remembers the labels behind each ref from the latest snapshot of a tab. */
  rememberSnapshot(targetId: string | undefined, refs: Record<string, RefInfo> | undefined): void {
    if (!refs) {
      return;
    }
    const key = targetId?.trim() || "";
    this.refsByTarget.set(key, refs);
    this.lastTargetId = key;
  }

  /**
   * True when judging this request needs a fresh look at the page: a click on a ref
   * we have no label for, or a submit on a tab we have never snapshotted.
   */
  needsSnapshot(request: Record<string, unknown>): boolean {
    const kind = typeof request.kind === "string" ? request.kind : "";
    const targetId = typeof request.targetId === "string" ? request.targetId : undefined;
    const refs = this.refsFor(targetId);
    if (kind === "click") {
      const ref = typeof request.ref === "string" ? normalizeRef(request.ref) : "";
      return Boolean(ref) && !refs?.[ref];
    }
    return !refs && this.inspectKind(request) !== "none";
  }

  private inspectKind(request: Record<string, unknown>): "click" | "submit" | "script" | "none" {
    const kind = typeof request.kind === "string" ? request.kind : "";
    if (kind === "click") {
      return "click";
    }
    if (
      (kind === "press" &&
        typeof request.key === "string" &&
        /^(enter|numpadenter)$/i.test(request.key)) ||
      ((kind === "type" || kind === "fill") && request.submit === true)
    ) {
      return "submit";
    }
    if (kind === "evaluate" || kind === "wait") {
      const fn = typeof request.fn === "string" ? request.fn : "";
      if (SCRIPT_ACTS.test(fn)) {
        return "script";
      }
    }
    return "none";
  }

  private refsFor(targetId: string | undefined): Record<string, RefInfo> | undefined {
    const key = targetId?.trim() || this.lastTargetId;
    return this.refsByTarget.get(key) ?? this.refsByTarget.get("");
  }

  /**
   * The final step this act request would take, or null when it needs no approval.
   * `scopedRefs` are the refs inside a click's `selector`, when it has no ref.
   */
  inspect(
    request: Record<string, unknown>,
    element?: string,
    scopedRefs?: Record<string, RefInfo>,
  ): GuardedAction | null {
    const targetId = typeof request.targetId === "string" ? request.targetId : undefined;
    const refs = this.refsFor(targetId);
    switch (this.inspectKind(request)) {
      case "click": {
        const ref = typeof request.ref === "string" ? normalizeRef(request.ref) : "";
        if (!ref && scopedRefs) {
          return finalControlIn(scopedRefs, CLICKABLE_ROLES);
        }
        const info = ref ? refs?.[ref] : undefined;
        if (info && !CLICKABLE_ROLES.has(info.role)) {
          return null;
        }
        const label = info?.name ?? (typeof element === "string" ? element : "");
        const category = classifyFinalAction(label);
        return category ? { category, label: label.trim() } : null;
      }
      // Enter in a field (or type/fill with submit) sends the form. Judge it by the
      // page's own final button, if it has one.
      case "submit":
        return this.finalButtonOnPage(refs);
      // A script that clicks or submits gets the same check as a click.
      case "script":
        return this.finalButtonOnPage(refs) ?? { category: "submit", label: "a page script" };
      default:
        return null;
    }
  }

  private finalButtonOnPage(refs: Record<string, RefInfo> | undefined): GuardedAction | null {
    return finalControlIn(refs, BUTTON_ROLES);
  }
}

const BUTTON_ROLES = new Set(["button"]);

function normalizeRef(ref: string): string {
  return ref.trim().replace(/^@|^ref=/, "");
}

function finalControlIn(
  refs: Record<string, RefInfo> | undefined,
  roles: Set<string>,
): GuardedAction | null {
  for (const info of Object.values(refs ?? {})) {
    if (!roles.has(info.role)) {
      continue;
    }
    const category = classifyFinalAction(info.name);
    if (category) {
      return { category, label: (info.name ?? "").trim() };
    }
  }
  return null;
}

export function approvalNeededMessage(action: GuardedAction): string {
  const request = {
    kind: `browser_${action.category}`,
    title: `Approve: ${action.label}`.slice(0, 120),
    category: action.category,
    summary: `Aillium is about to click "${action.label}" in the browser.`,
    reason: "Final browser steps need the owner's approval.",
    requestedSurface: "remote_browser",
    details: { action: action.label, category: action.category },
  };
  return [
    `Approval needed: "${action.label}" is a final ${action.category} step, so it was NOT done.`,
    "Check the page is filled in correctly, then put this line in your reply and stop:",
    `RUNTIME_APPROVAL_REQUEST: ${JSON.stringify(request)}`,
    "When the owner approves, repeat this exact step. If they reject it, do not try another way.",
  ].join("\n");
}

/** A batch request runs several steps; each one is judged on its own. */
export function flattenActRequests(request: Record<string, unknown>): Record<string, unknown>[] {
  if (request.kind !== "batch" || !Array.isArray(request.actions)) {
    return [request];
  }
  const out: Record<string, unknown>[] = [];
  for (const action of request.actions) {
    if (action && typeof action === "object") {
      const step = action as Record<string, unknown>;
      const withTarget =
        step.targetId === undefined && typeof request.targetId === "string"
          ? { ...step, targetId: request.targetId }
          : step;
      out.push(...flattenActRequests(withTarget));
    }
  }
  return out;
}

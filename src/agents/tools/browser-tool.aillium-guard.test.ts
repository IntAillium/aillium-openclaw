import { afterEach, describe, expect, it } from "vitest";
import {
  approvalNeededMessage,
  BrowserFinalActionGuard,
  classifyFinalAction,
  consumeBrowserApproval,
  flattenActRequests,
  grantBrowserApproval,
  resetBrowserApprovalGrantsForTest,
} from "./browser-tool.aillium-guard.js";

describe("classifyFinalAction", () => {
  it.each([
    ["Pay £84.20", "payment"],
    ["Place your order", "payment"],
    ["Buy now", "payment"],
    ["Confirm and pay", "payment"],
    ["Delete account", "delete"],
    ["Cancel my subscription", "delete"],
    ["Send", "send"],
    ["Post reply", "send"],
    ["Submit application", "submit"],
    ["Book table", "submit"],
    ["Sign up", "submit"],
  ])("%s is a final %s step", (label, category) => {
    expect(classifyFinalAction(label)).toBe(category);
  });

  it.each([
    "Purchase history",
    "Payment details",
    "Subscribe options",
    "Share feedback",
    "Accept all cookies",
    "Confirm cookie choices",
    "Next",
    "Continue",
    "Log in",
    "Add to basket",
    "",
  ])("%s is an ordinary click", (label) => {
    expect(classifyFinalAction(label)).toBeNull();
  });
});

describe("BrowserFinalActionGuard", () => {
  const refs = {
    e1: { role: "textbox", name: "Email" },
    e2: { role: "button", name: "Submit application" },
    e3: { role: "heading", name: "Pay now" },
  };

  it("judges a click by the snapshot's label, not the agent's description", () => {
    const guard = new BrowserFinalActionGuard();
    guard.rememberSnapshot("t1", refs);
    expect(guard.inspect({ kind: "click", ref: "e2", targetId: "t1" }, "Next")).toEqual({
      category: "submit",
      label: "Submit application",
    });
    expect(guard.inspect({ kind: "click", ref: "e3", targetId: "t1" })).toBeNull();
  });

  it("treats Enter and submit=true as pressing the form's final button", () => {
    const guard = new BrowserFinalActionGuard();
    guard.rememberSnapshot("t1", refs);
    expect(guard.inspect({ kind: "press", key: "Enter" })?.category).toBe("submit");
    expect(guard.inspect({ kind: "type", ref: "e1", text: "x", submit: true })?.category).toBe(
      "submit",
    );
    expect(guard.inspect({ kind: "type", ref: "e1", text: "x" })).toBeNull();
  });

  it("holds back page scripts that click or send", () => {
    const guard = new BrowserFinalActionGuard();
    expect(guard.inspect({ kind: "evaluate", fn: "() => document.forms[0].submit()" })).toEqual({
      category: "submit",
      label: "a page script",
    });
    expect(
      guard.inspect({ kind: "wait", fn: "() => fetch('/api/pay', {method:'POST'})" }),
    ).not.toBeNull();
    expect(guard.inspect({ kind: "evaluate", fn: "() => document.title" })).toBeNull();
  });

  it("asks for a fresh look only when it is missing the label", () => {
    const guard = new BrowserFinalActionGuard();
    expect(guard.needsSnapshot({ kind: "click", ref: "e2" })).toBe(true);
    expect(guard.needsSnapshot({ kind: "press", key: "Enter" })).toBe(true);
    expect(guard.needsSnapshot({ kind: "type", ref: "e1", text: "x" })).toBe(false);
    guard.rememberSnapshot("t1", refs);
    expect(guard.needsSnapshot({ kind: "click", ref: "e2", targetId: "t1" })).toBe(false);
  });

  it("judges a selector click by the controls inside it", () => {
    const guard = new BrowserFinalActionGuard();
    expect(
      guard.inspect({ kind: "click", selector: "#pay" }, undefined, {
        e9: { role: "button", name: "Pay now" },
      }),
    ).toEqual({ category: "payment", label: "Pay now" });
  });
});

describe("approval grants", () => {
  afterEach(() => resetBrowserApprovalGrantsForTest());

  it("are one-time, per session, and match Core's form of the session key", () => {
    grantBrowserApproval({ sessionKey: "agent:main:Task-1", category: "payment" });
    expect(consumeBrowserApproval("agent:main:other", "payment")).toBe(false);
    expect(consumeBrowserApproval("agent:main:task-1", "submit")).toBe(false);
    expect(consumeBrowserApproval("agent:main:task-1", "payment")).toBe(true);
    expect(consumeBrowserApproval("agent:main:task-1", "payment")).toBe(false);
  });

  it("expire", () => {
    grantBrowserApproval({ sessionKey: "s1", ttlMs: 1_000, now: 0 });
    expect(consumeBrowserApproval("s1", "send", 2_000)).toBe(false);
  });

  it("need a session", () => {
    expect(consumeBrowserApproval(undefined, "send")).toBe(false);
  });
});

describe("approvalNeededMessage", () => {
  it("tells the agent to raise an approval and stop", () => {
    const text = approvalNeededMessage({ category: "payment", label: "Pay now" });
    expect(text).toContain("was NOT done");
    const line = text.split("\n").find((l) => l.startsWith("RUNTIME_APPROVAL_REQUEST: "));
    const request = JSON.parse(line!.slice("RUNTIME_APPROVAL_REQUEST: ".length));
    expect(request).toMatchObject({ kind: "browser_payment", category: "payment" });
  });
});

describe("flattenActRequests", () => {
  it("unpacks nested batches and carries the tab along", () => {
    expect(
      flattenActRequests({
        kind: "batch",
        targetId: "t1",
        actions: [
          { kind: "click", ref: "e1" },
          { kind: "batch", actions: [{ kind: "press" }] },
        ],
      }),
    ).toEqual([
      { kind: "click", ref: "e1", targetId: "t1" },
      { kind: "press", targetId: "t1" },
    ]);
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";

const sessionMocks = vi.hoisted(() => ({ getPlaywrightBrowser: vi.fn() }));
vi.mock("./pw-session.js", () => sessionMocks);

import {
  getAilliumOverlayStatus,
  normalizeOverlayState,
  overlayScript,
  resetAilliumOverlayForTest,
  setAilliumOverlayViaPlaywright,
} from "./pw-aillium-overlay.js";

type Handler = () => void;

function fakePage() {
  const handlers: Record<string, Handler[]> = {};
  return {
    evaluate: vi.fn(async () => undefined),
    isClosed: () => false,
    on: vi.fn((event: string, handler: Handler) => {
      (handlers[event] ??= []).push(handler);
    }),
    fire: (event: string) => handlers[event]?.forEach((h) => h()),
  };
}

function fakeBrowser(pages: ReturnType<typeof fakePage>[]) {
  const contextHandlers: Array<(page: unknown) => void> = [];
  const context = {
    pages: () => pages,
    on: vi.fn((_event: string, handler: (page: unknown) => void) => contextHandlers.push(handler)),
  };
  return {
    browser: { contexts: () => [context] },
    openPage: (page: ReturnType<typeof fakePage>) => contextHandlers.forEach((h) => h(page)),
  };
}

describe("Aillium browser overlay", () => {
  afterEach(() => {
    resetAilliumOverlayForTest();
    vi.clearAllMocks();
  });

  it("accepts only the known states", () => {
    expect(normalizeOverlayState("decision")).toBe("decision");
    expect(normalizeOverlayState("hidden")).toBeNull();
  });

  it("paints every open page, new pages, and pages after they reload", async () => {
    const page = fakePage();
    const { browser, openPage } = fakeBrowser([page]);
    sessionMocks.getPlaywrightBrowser.mockResolvedValue(browser);

    const status = await setAilliumOverlayViaPlaywright({
      cdpUrl: "http://127.0.0.1:18800",
      state: "decision",
      message: "  Approve:   Pay now ",
    });
    expect(status).toMatchObject({
      state: "decision",
      message: "Approve: Pay now",
      pages: 1,
      previous: "off",
    });
    expect(page.evaluate).toHaveBeenCalledWith(
      overlayScript({ state: "decision", message: "Approve: Pay now" }),
    );

    page.fire("domcontentloaded");
    expect(page.evaluate).toHaveBeenCalledTimes(2);

    const later = fakePage();
    openPage(later);
    expect(later.evaluate).toHaveBeenCalledWith(
      overlayScript({ state: "decision", message: "Approve: Pay now" }),
    );
    expect(getAilliumOverlayStatus("http://127.0.0.1:18800").state).toBe("decision");
  });

  it("does not hook the same page twice", async () => {
    const page = fakePage();
    const { browser } = fakeBrowser([page]);
    sessionMocks.getPlaywrightBrowser.mockResolvedValue(browser);
    await setAilliumOverlayViaPlaywright({ cdpUrl: "x", state: "control" });
    await setAilliumOverlayViaPlaywright({ cdpUrl: "x", state: "released" });
    expect(page.on).toHaveBeenCalledTimes(1);
    expect(page.evaluate).toHaveBeenLastCalledWith(
      overlayScript({ state: "released", message: null }),
    );
  });
});

import { describe, expect, it } from "vitest";
import { skipsInactiveOverlay } from "./aillium.js";

describe("aillium overlay route", () => {
  it("leaves a browser alone when asked to only hand back an active one", () => {
    expect(skipsInactiveOverlay(true, "off")).toBe(true);
    expect(skipsInactiveOverlay(true, "released")).toBe(true);
  });

  it("changes a browser that shows Aillium in charge, or when not restricted", () => {
    expect(skipsInactiveOverlay(true, "control")).toBe(false);
    expect(skipsInactiveOverlay(true, "decision")).toBe(false);
    expect(skipsInactiveOverlay(undefined, "off")).toBe(false);
  });
});

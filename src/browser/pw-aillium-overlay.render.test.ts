// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { __test } from "./pw-aillium-overlay.js";

describe("renderOverlay (runs in the page)", () => {
  it("draws a hidden-from-snapshots overlay that never takes clicks, then removes it", () => {
    __test.renderOverlay({ state: "control", message: null });
    const host = document.querySelector("aillium-overlay") as HTMLElement;
    expect(host).not.toBeNull();
    expect(host.getAttribute("aria-hidden")).toBe("true");
    expect(host.style.pointerEvents).toBe("none");

    __test.renderOverlay({ state: "decision", message: "<b>Pay</b>" });
    expect(document.querySelectorAll("aillium-overlay")).toHaveLength(1);

    __test.renderOverlay({ state: "off", message: null });
    expect(document.querySelector("aillium-overlay")).toBeNull();
  });
});

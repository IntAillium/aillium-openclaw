import { describe, expect, it } from "vitest";
import { attachBrowserRequestSignal } from "./server-middleware.js";

describe("attachBrowserRequestSignal", () => {
  it("adds a compatibility signal when the runtime does not provide one", () => {
    const request = {};
    const signal = new AbortController().signal;

    attachBrowserRequestSignal(request, signal);

    expect((request as { signal?: AbortSignal }).signal).toBe(signal);
  });

  it("preserves an inherited getter-only runtime signal", () => {
    const runtimeSignal = new AbortController().signal;
    const request = Object.create({
      get signal() {
        return runtimeSignal;
      },
    }) as object;

    expect(() => attachBrowserRequestSignal(request, new AbortController().signal)).not.toThrow();
    expect((request as { signal?: AbortSignal }).signal).toBe(runtimeSignal);
    expect(Object.hasOwn(request, "signal")).toBe(false);
  });
});

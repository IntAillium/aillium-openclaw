import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetAilliumBoundaryForTest, resolveAilliumBoundary } from "./init.js";

describe("resolveAilliumBoundary", () => {
  beforeEach(() => {
    __resetAilliumBoundaryForTest();
  });

  afterEach(() => {
    __resetAilliumBoundaryForTest();
    vi.restoreAllMocks();
  });

  it("returns the no-op default boundary when env vars are not set", async () => {
    const boundary = resolveAilliumBoundary({});
    const result = await boundary.runtimeRegistration.register({
      runtimeId: "test-runtime",
      runtimeVersion: "0.0.0",
      capabilities: [],
    });
    expect(result.registered).toBe(false);
    expect(result.message).toMatch(/No Aillium runtime registration adapter/);
  });

  it("returns the no-op default boundary when only one of the two required vars is set", async () => {
    const boundary = resolveAilliumBoundary({ AILLIUM_CORE_URL: "https://api.example/api" });
    const result = await boundary.runtimeRegistration.register({
      runtimeId: "test-runtime",
      runtimeVersion: "0.0.0",
      capabilities: [],
    });
    expect(result.registered).toBe(false);
    expect(result.message).toMatch(/No Aillium runtime registration adapter/);
  });

  it("returns a live boundary that hits the configured URL when both env vars are set", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(JSON.stringify({ sessionId: "remote-session-1" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );

    const boundary = resolveAilliumBoundary({
      AILLIUM_CORE_URL: "https://api.example/api",
      AILLIUM_RUNTIME_SYNC_TOKEN: "secret-token",
    });

    const result = await boundary.runtimeRegistration.register({
      runtimeId: "test-runtime",
      runtimeVersion: "1.2.3",
      capabilities: ["chat"],
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [calledUrl, calledInit] = fetchSpy.mock.calls[0]!;
    expect(String(calledUrl)).toBe("https://api.example/api/master-agent/runtime/operator-sync");
    expect((calledInit as RequestInit).method).toBe("POST");
    const headers = (calledInit as RequestInit).headers as Record<string, string>;
    expect(headers["x-aillium-runtime-token"]).toBe("secret-token");

    expect(result.registered).toBe(true);
    expect(result.externalRuntimeRef).toBe("remote-session-1");
  });

  it("caches the boundary across calls within the same process", () => {
    const a = resolveAilliumBoundary({});
    const b = resolveAilliumBoundary({
      // Even with live env vars on the second call, the cached default should win.
      AILLIUM_CORE_URL: "https://api.example/api",
      AILLIUM_RUNTIME_SYNC_TOKEN: "secret-token",
    });
    expect(a).toBe(b);
  });

  it("__resetAilliumBoundaryForTest clears the cache so subsequent calls re-resolve", () => {
    const first = resolveAilliumBoundary({});
    __resetAilliumBoundaryForTest();
    const second = resolveAilliumBoundary({
      AILLIUM_CORE_URL: "https://api.example/api",
      AILLIUM_RUNTIME_SYNC_TOKEN: "secret-token",
    });
    expect(second).not.toBe(first);
  });
});

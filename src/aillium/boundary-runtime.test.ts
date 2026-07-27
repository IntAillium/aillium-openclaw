import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  isAilliumCoreConfigured,
  registerOperatorRuntimeBestEffort,
  resetAilliumBoundary,
  resolveAilliumCoreConfig,
} from "./boundary-runtime.js";

const AILLIUM_ENV_KEYS = [
  "AILLIUM_CORE_URL",
  "AILLIUM_RUNTIME_TOKEN",
  "OPERATOR_RUNTIME_TOKEN",
  "AILLIUM_RUNTIME_TIMEOUT_MS",
  "AILLIUM_TENANT_ID",
  "AILLIUM_RUNTIME_SESSION_KEY",
  "AILLIUM_RUNTIME_ID",
] as const;

describe("Aillium boundary runtime", () => {
  beforeEach(() => {
    for (const key of AILLIUM_ENV_KEYS) {
      vi.stubEnv(key, "");
    }
    resetAilliumBoundary();
  });

  afterEach(() => {
    resetAilliumBoundary();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("uses no-op behavior unless both the Core URL and runtime token are configured", () => {
    expect(isAilliumCoreConfigured()).toBe(false);

    vi.stubEnv("AILLIUM_CORE_URL", "https://core.example.test");
    expect(isAilliumCoreConfigured()).toBe(false);

    vi.stubEnv("AILLIUM_RUNTIME_TOKEN", "runtime-token");
    expect(isAilliumCoreConfigured()).toBe(true);
  });

  it("normalizes the Core URL and validates the request timeout", () => {
    vi.stubEnv("AILLIUM_CORE_URL", "https://core.example.test///");
    vi.stubEnv("OPERATOR_RUNTIME_TOKEN", "operator-token");
    vi.stubEnv("AILLIUM_RUNTIME_TIMEOUT_MS", "-1");

    expect(resolveAilliumCoreConfig()).toEqual({
      baseUrl: "https://core.example.test",
      syncToken: "operator-token",
      timeoutMs: undefined,
    });

    vi.stubEnv("AILLIUM_RUNTIME_TIMEOUT_MS", "2500");
    expect(resolveAilliumCoreConfig()?.timeoutMs).toBe(2500);
  });

  it("registers once through Core's canonical runtime endpoint with tenant metadata", async () => {
    vi.stubEnv("AILLIUM_CORE_URL", "https://core.example.test/");
    vi.stubEnv("AILLIUM_RUNTIME_TOKEN", "runtime-token");
    vi.stubEnv("AILLIUM_TENANT_ID", "018f5f90-7b9a-7d03-9f96-c0f8a42e4131");

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          registered: true,
          runtime_session_key: "runtime-session-1",
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
    );
    const log = { info: vi.fn(), warn: vi.fn() };

    await expect(
      registerOperatorRuntimeBestEffort({
        runtimeVersion: "1.2.3",
        capabilities: ["gateway", "context-engine"],
        metadata: { port: 18789 },
        log,
      }),
    ).resolves.toBe(true);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe("https://core.example.test/master-agent/runtime/register");
    expect(init?.method).toBe("POST");
    expect(init?.headers).toMatchObject({
      "Content-Type": "application/json",
      "x-aillium-runtime-token": "runtime-token",
    });
    if (typeof init?.body !== "string") {
      throw new Error("Expected runtime registration to send a JSON string body");
    }
    expect(JSON.parse(init.body)).toMatchObject({
      tenant_id: "018f5f90-7b9a-7d03-9f96-c0f8a42e4131",
      runtime_version: "1.2.3",
      capabilities: ["gateway", "context-engine"],
      metadata: {
        tenantId: "018f5f90-7b9a-7d03-9f96-c0f8a42e4131",
        port: 18789,
      },
    });
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("does not call Core until a tenant or existing runtime session is available", async () => {
    vi.stubEnv("AILLIUM_CORE_URL", "https://core.example.test");
    vi.stubEnv("AILLIUM_RUNTIME_TOKEN", "runtime-token");
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const log = { info: vi.fn(), warn: vi.fn() };

    await expect(registerOperatorRuntimeBestEffort({ log })).resolves.toBe(false);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining("skipping runtime registration"));
  });
});

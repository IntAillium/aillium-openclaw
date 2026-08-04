import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleAilliumMcpHttpRequest } from "./aillium-mcp-http.js";

const executionContext = {
  tenantId: "tenant-1",
  authorityType: "agent" as const,
  authorityId: "master-agent-1",
  workOrderId: "work-order-1",
  runId: "run-1",
  runStepId: "step-1",
  desktopSessionId: "desktop-1",
  attempt: 2,
  executorId: "openclaw-1",
  fenceToken: "42",
  cancellationGeneration: 3,
};

function createRequest(body: Record<string, unknown>): IncomingMessage {
  const request = Readable.from([JSON.stringify(body)]) as IncomingMessage;
  request.method = "POST";
  request.headers = { "x-aillium-runtime-token": "runtime-secret" };
  return request;
}

function createResponse(): ServerResponse & { body: string } {
  const response = {
    body: "",
    statusCode: 200,
    destroyed: false,
    writableEnded: false,
    setHeader: vi.fn(() => response),
    once: vi.fn(() => response),
    removeListener: vi.fn(() => response),
    end: vi.fn((body?: string) => {
      response.body = body ?? "";
      response.writableEnded = true;
      return response;
    }),
  };
  return response as unknown as ServerResponse & { body: string };
}

function desktopAction(overrides: Record<string, unknown> = {}) {
  return {
    tenantId: "tenant-1",
    sessionId: "desktop-1",
    sessionKey: "session:main",
    action: "browser.navigate",
    requestedSurface: "local_browser",
    arguments: { url: "https://example.test" },
    desktopControlToken: "scoped.desktop.jwt",
    executionContext,
    ...overrides,
  };
}

describe("Aillium governed desktop bridge", () => {
  beforeEach(() => {
    vi.stubEnv("AILLIUM_MCP_RUNTIME_TOKEN", "runtime-secret");
    vi.stubEnv("AILLIUM_DESKTOP_BRIDGE_URL", "http://127.0.0.1:19444");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("forwards scoped authority and the complete execution context", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const response = createResponse();

    await handleAilliumMcpHttpRequest(
      createRequest(desktopAction()),
      response,
      "/api/aillium/desktop/invoke-action",
    );

    expect(response.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("http://127.0.0.1:19444/invoke");
    expect(init?.headers).toMatchObject({
      Authorization: "Bearer scoped.desktop.jwt",
      "X-Aillium-Desktop-Token": "scoped.desktop.jwt",
    });
    if (typeof init?.body !== "string") {
      throw new Error("expected a JSON request body");
    }
    const forwarded = JSON.parse(init.body) as Record<string, unknown>;
    expect(forwarded.desktopControlToken).toBeUndefined();
    expect(forwarded.executionContext).toEqual(executionContext);
  });

  it("rejects incomplete authority instead of falling back to a static token", async () => {
    vi.stubEnv("AILLIUM_DESKTOP_BRIDGE_TOKEN", "legacy-static-token");
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const { desktopControlToken: _token, ...withoutScopedToken } = desktopAction();
    const response = createResponse();

    await handleAilliumMcpHttpRequest(
      createRequest(withoutScopedToken),
      response,
      "/api/aillium/desktop/invoke-action",
    );

    expect(response.statusCode).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a target that diverges from the scoped execution context", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const response = createResponse();

    await handleAilliumMcpHttpRequest(
      createRequest(desktopAction({ tenantId: "tenant-other" })),
      response,
      "/api/aillium/desktop/invoke-action",
    );

    expect(response.statusCode).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects desktop authority without a bound work order", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const { workOrderId: _workOrderId, ...unboundContext } = executionContext;
    const response = createResponse();

    await handleAilliumMcpHttpRequest(
      createRequest(desktopAction({ executionContext: unboundContext })),
      response,
      "/api/aillium/desktop/invoke-action",
    );

    expect(response.statusCode).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("propagates parent request cancellation to the desktop bridge", async () => {
    let observedSignal: AbortSignal | undefined;
    vi.spyOn(globalThis, "fetch").mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          observedSignal = init?.signal ?? undefined;
          observedSignal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );
    const request = createRequest(desktopAction());
    const response = createResponse();
    const handled = handleAilliumMcpHttpRequest(
      request,
      response,
      "/api/aillium/desktop/invoke-action",
    );
    await vi.waitFor(() => expect(observedSignal).toBeDefined());

    request.emit("aborted");
    await handled;

    expect(observedSignal?.aborted).toBe(true);
    expect(response.statusCode).toBe(400);
  });
});

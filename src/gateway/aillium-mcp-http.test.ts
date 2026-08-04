import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import {
  RuntimeContractVersion,
  RuntimeWireEnvelopeV1Schema,
  type RuntimeWireEnvelopeV1,
} from "@aillium/schemas";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  close: vi.fn(),
  callTool: vi.fn(),
  readResource: vi.fn(),
  getPrompt: vi.fn(),
  listTools: vi.fn(),
  listResources: vi.fn(),
  listPrompts: vi.fn(),
}));

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class {
    connect = mocks.connect;
    close = mocks.close;
    callTool = mocks.callTool;
    readResource = mocks.readResource;
    getPrompt = mocks.getPrompt;
    listTools = mocks.listTools;
    listResources = mocks.listResources;
    listPrompts = mocks.listPrompts;
  },
}));
vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: class {},
}));
vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: class {
    constructor(
      readonly url: URL,
      readonly options: Record<string, unknown>,
    ) {}
  },
}));

import { signMcpRuntimeEnvelope, verifyMcpRuntimeEnvelope } from "./aillium-mcp-authority.js";
import { handleAilliumMcpHttpRequest } from "./aillium-mcp-http.js";

const secret = "runtime-secret";

function createExecution(): Extract<
  RuntimeWireEnvelopeV1,
  { message_type: "TOOL_EXECUTE_REQUEST" }
> {
  const deadline = new Date(Date.now() + 30_000).toISOString();
  const zero = {
    duration_ms: 0,
    model_calls: 0,
    tool_calls: 0,
    retries: 0,
    revisions: 0,
    input_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,
    cost_minor_units: 0,
  };
  return RuntimeWireEnvelopeV1Schema.parse({
    contract_version: RuntimeContractVersion,
    envelope_id: "envelope-1",
    emitted_at: new Date().toISOString(),
    message_type: "TOOL_EXECUTE_REQUEST",
    context: {
      contract_version: RuntimeContractVersion,
      tenant_id: "tenant-1",
      work_order_id: "work-1",
      run_id: "run-1",
      run_step_id: "step-1",
      attempt: 1,
      idempotency_key: "request-1",
      fence_token: "7",
      checkpoint_cursor: null,
      executor_id: "core:mcp",
      lease_id: "lease-1",
      lease_epoch: 7,
      lease_expires_at: deadline,
      budget: {
        deadline_at: deadline,
        max_duration_ms: 30_000,
        max_model_calls: 1,
        max_tool_calls: 1,
        max_retries: 0,
        max_revision_count: 0,
        max_input_tokens: 1,
        max_output_tokens: 1,
        max_total_tokens: 2,
        max_cost: { currency: "GBP", minor_units: 0 },
        model_ceilings: [
          {
            provider: "aillium",
            model: "mcp-control-plane",
            max_calls: 1,
            max_input_tokens: 1,
            max_output_tokens: 1,
            max_total_tokens: 2,
            max_cost_minor_units: 0,
          },
        ],
      },
      budget_ledger: {
        currency: "GBP",
        consumed: zero,
        remaining: {
          ...zero,
          duration_ms: 30_000,
          model_calls: 1,
          tool_calls: 1,
          input_tokens: 1,
          output_tokens: 1,
          total_tokens: 2,
        },
        model_consumption: [],
        updated_at: new Date().toISOString(),
      },
    },
    payload: {
      tenant_id: "tenant-1",
      work_order_id: "work-1",
      run_id: "run-1",
      run_step_id: "step-1",
      attempt: 1,
      operation_id: "mcp:operation-1",
      idempotency_key: "request-1",
      fence_token: "7",
      tool_name: "write",
      input: { arguments: { value: 1 } },
      approval_id: null,
      deadline_at: deadline,
    },
  }) as Extract<RuntimeWireEnvelopeV1, { message_type: "TOOL_EXECUTE_REQUEST" }>;
}

function createCancellation(
  execution = createExecution(),
): Extract<RuntimeWireEnvelopeV1, { message_type: "TOOL_CANCEL_REQUEST" }> {
  const now = new Date();
  return RuntimeWireEnvelopeV1Schema.parse({
    contract_version: RuntimeContractVersion,
    envelope_id: "cancel-envelope-1",
    emitted_at: now.toISOString(),
    message_type: "TOOL_CANCEL_REQUEST",
    context: execution.context,
    payload: {
      tenant_id: execution.payload.tenant_id,
      work_order_id: execution.payload.work_order_id,
      run_id: execution.payload.run_id,
      run_step_id: execution.payload.run_step_id,
      attempt: execution.payload.attempt,
      operation_id: execution.payload.operation_id,
      idempotency_key: execution.payload.idempotency_key,
      fence_token: execution.payload.fence_token,
      cancellation_id: "cancel-1",
      reason: "user requested cancellation",
      requested_at: now.toISOString(),
      acknowledge_by: new Date(now.getTime() + 2_000).toISOString(),
      force_by: new Date(now.getTime() + 5_000).toISOString(),
    },
  }) as Extract<RuntimeWireEnvelopeV1, { message_type: "TOOL_CANCEL_REQUEST" }>;
}

function createRequest(
  body: Record<string, unknown>,
  runtime?: RuntimeWireEnvelopeV1,
  authority?: { audience?: "aillium-core" | "connector:mcp"; now?: Date },
): IncomingMessage {
  const req = Readable.from([JSON.stringify(body)]) as IncomingMessage;
  req.method = "POST";
  req.headers = {
    "x-aillium-runtime-token": secret,
    ...(runtime
      ? signMcpRuntimeEnvelope({
          envelope: runtime,
          secret,
          issuer: "aillium-core",
          audience: authority?.audience ?? "connector:mcp",
          now: authority?.now,
        })
      : {}),
  };
  return req;
}

function createResponse(): ServerResponse & {
  body: string;
  headers: Record<string, string>;
} {
  const response = {
    body: "",
    headers: {} as Record<string, string>,
    statusCode: 200,
    destroyed: false,
    writableEnded: false,
    setHeader: vi.fn((name: string, value: string) => {
      response.headers[name.toLowerCase()] = String(value);
      return response;
    }),
    once: vi.fn(() => response),
    removeListener: vi.fn(() => response),
    end: vi.fn((body?: string) => {
      response.body = body ?? "";
      response.writableEnded = true;
      return response;
    }),
  };
  return response as unknown as ServerResponse & {
    body: string;
    headers: Record<string, string>;
  };
}

describe("Aillium MCP canonical execution fencing", () => {
  beforeEach(() => {
    vi.stubEnv("AILLIUM_MCP_RUNTIME_TOKEN", secret);
    mocks.connect.mockResolvedValue(undefined);
    mocks.close.mockResolvedValue(undefined);
    mocks.callTool.mockResolvedValue({ content: [{ type: "text", text: "ok" }] });
    mocks.listTools.mockResolvedValue({ tools: [] });
    mocks.listResources.mockResolvedValue({ resources: [] });
    mocks.listPrompts.mockResolvedValue({ prompts: [] });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  it("forwards one canonical runtime-v1 identity and returns a signed result", async () => {
    const runtime = createExecution();
    const response = createResponse();
    await handleAilliumMcpHttpRequest(
      createRequest(
        {
          server: { name: "docs", transportType: "HTTP", url: "https://example.test/mcp" },
          runtime,
        },
        runtime,
      ),
      response,
      "/api/aillium/mcp/invoke-tool",
    );

    expect(response.statusCode, response.body).toBe(200);
    expect(mocks.callTool).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "write",
        arguments: { value: 1 },
        _meta: { ailliumExecution: runtime },
      }),
      undefined,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    const result = JSON.parse(response.body).runtime;
    expect(
      verifyMcpRuntimeEnvelope({
        envelope: result,
        headers: response.headers,
        secret,
        issuer: "aillium-openclaw",
        audience: "aillium-core",
      }),
    ).toMatchObject({ message_type: "TOOL_EXECUTE_RESULT" });
  });

  it.each([
    [
      "tenant",
      (runtime: ReturnType<typeof createExecution>) => (runtime.context.tenant_id = "evil"),
    ],
    ["fence", (runtime: ReturnType<typeof createExecution>) => (runtime.context.fence_token = "8")],
    [
      "idempotency",
      (runtime: ReturnType<typeof createExecution>) => (runtime.payload.idempotency_key = "evil"),
    ],
  ])("rejects %s tampering after Core signs the envelope", async (_field, tamper) => {
    const signed = createExecution();
    const request = createRequest(
      {
        server: { name: "docs", transportType: "HTTP", url: "https://example.test/mcp" },
        runtime: signed,
      },
      signed,
    );
    const tampered = structuredClone(signed);
    tamper(tampered);
    (request as Readable).destroy();
    const replacement = Readable.from([
      JSON.stringify({
        server: { name: "docs", transportType: "HTTP", url: "https://example.test/mcp" },
        runtime: tampered,
      }),
    ]) as IncomingMessage;
    replacement.method = "POST";
    replacement.headers = request.headers;
    const response = createResponse();
    await handleAilliumMcpHttpRequest(replacement, response, "/api/aillium/mcp/invoke-tool");
    expect(response.statusCode).toBe(400);
    expect(mocks.callTool).not.toHaveBeenCalled();
  });

  it("rejects a token-only request and an expired or wrong-audience authority", async () => {
    const runtime = createExecution();
    for (const request of [
      createRequest({
        server: { name: "docs", transportType: "HTTP", url: "https://example.test/mcp" },
        runtime,
      }),
      createRequest(
        {
          server: { name: "docs", transportType: "HTTP", url: "https://example.test/mcp" },
          runtime,
        },
        runtime,
        { now: new Date(Date.now() - 60_000) },
      ),
      createRequest(
        {
          server: { name: "docs", transportType: "HTTP", url: "https://example.test/mcp" },
          runtime,
        },
        runtime,
        { audience: "aillium-core" },
      ),
    ]) {
      const response = createResponse();
      await handleAilliumMcpHttpRequest(request, response, "/api/aillium/mcp/invoke-tool");
      expect(response.statusCode).toBe(400);
    }
    expect(mocks.callTool).not.toHaveBeenCalled();
  });

  it("rejects replay of a previously accepted signed authority", async () => {
    const runtime = createExecution();
    const body = {
      server: { name: "docs", transportType: "HTTP", url: "https://example.test/mcp" },
      runtime,
    };
    const first = createRequest(body, runtime);
    const firstResponse = createResponse();
    await handleAilliumMcpHttpRequest(first, firstResponse, "/api/aillium/mcp/invoke-tool");
    const replay = createRequest(body);
    replay.headers = first.headers;
    const replayResponse = createResponse();
    await handleAilliumMcpHttpRequest(replay, replayResponse, "/api/aillium/mcp/invoke-tool");
    expect(firstResponse.statusCode).toBe(200);
    expect(replayResponse.statusCode).toBe(400);
    expect(mocks.callTool).toHaveBeenCalledTimes(1);
  });

  it("rejects cancellation identity tampering after Core signs it", async () => {
    const signed = createCancellation();
    const tampered = structuredClone(signed);
    tampered.payload.cancellation_id = "cancel-evil";
    const response = createResponse();
    await handleAilliumMcpHttpRequest(
      createRequest({ runtime: tampered, force: false }, signed),
      response,
      "/api/aillium/mcp/cancel",
    );
    expect(response.statusCode).toBe(400);
  });

  it("does not manufacture terminal proof when operation state was lost after restart", async () => {
    const cancellation = createCancellation();
    const response = createResponse();
    await handleAilliumMcpHttpRequest(
      createRequest({ runtime: cancellation, force: true }, cancellation),
      response,
      "/api/aillium/mcp/cancel",
    );

    expect(response.statusCode, response.body).toBe(200);
    const runtime = verifyMcpRuntimeEnvelope({
      envelope: JSON.parse(response.body).runtime,
      headers: response.headers,
      secret,
      issuer: "aillium-openclaw",
      audience: "aillium-core",
    });
    expect(runtime.payload).toMatchObject({
      operation_id: cancellation.payload.operation_id,
      cancellation: {
        state: "FAILED",
        forced_stop: {
          required: true,
          outcome: "FAILED",
          mechanism: "operation-state-not-reconstructible",
        },
      },
    });
  });

  it("rejects a validly signed stale-fence cancellation without aborting the active operation", async () => {
    const runtime = createExecution();
    let observedSignal: AbortSignal | undefined;
    mocks.callTool.mockImplementation(
      (_params: unknown, _schema: unknown, options: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          observedSignal = options.signal;
          options.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );
    const activeRequest = createRequest(
      {
        server: { name: "docs", transportType: "HTTP", url: "https://example.test/mcp" },
        runtime,
      },
      runtime,
    );
    const activeResponse = createResponse();
    const activeCall = handleAilliumMcpHttpRequest(
      activeRequest,
      activeResponse,
      "/api/aillium/mcp/invoke-tool",
    );
    await vi.waitFor(() => expect(observedSignal).toBeDefined());

    const staleExecution = structuredClone(runtime);
    staleExecution.context.fence_token = "8";
    staleExecution.payload.fence_token = "8";
    const staleCancellation = createCancellation(staleExecution);
    const cancelResponse = createResponse();
    await handleAilliumMcpHttpRequest(
      createRequest({ runtime: staleCancellation, force: true }, staleCancellation),
      cancelResponse,
      "/api/aillium/mcp/cancel",
    );

    expect(cancelResponse.statusCode).toBe(400);
    expect(observedSignal?.aborted).toBe(false);
    activeRequest.emit("aborted");
    await activeCall;
  });

  it("rejects duplicate active operation IDs instead of overwriting ownership", async () => {
    const runtime = createExecution();
    let observedSignal: AbortSignal | undefined;
    mocks.callTool.mockImplementation(
      (_params: unknown, _schema: unknown, options: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          observedSignal = options.signal;
          options.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );
    const firstRequest = createRequest(
      {
        server: { name: "docs", transportType: "HTTP", url: "https://example.test/mcp" },
        runtime,
      },
      runtime,
    );
    const firstResponse = createResponse();
    const firstCall = handleAilliumMcpHttpRequest(
      firstRequest,
      firstResponse,
      "/api/aillium/mcp/invoke-tool",
    );
    await vi.waitFor(() => expect(observedSignal).toBeDefined());

    const duplicateResponse = createResponse();
    await handleAilliumMcpHttpRequest(
      createRequest(
        {
          server: { name: "docs", transportType: "HTTP", url: "https://example.test/mcp" },
          runtime,
        },
        runtime,
      ),
      duplicateResponse,
      "/api/aillium/mcp/invoke-tool",
    );

    expect(duplicateResponse.statusCode).toBe(400);
    expect(mocks.callTool).toHaveBeenCalledTimes(1);
    firstRequest.emit("aborted");
    await firstCall;
  });

  it("propagates request abort and returns a signed UNKNOWN result", async () => {
    const runtime = createExecution();
    let observedSignal: AbortSignal | undefined;
    mocks.callTool.mockImplementation(
      (_params: unknown, _schema: unknown, options: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          observedSignal = options.signal;
          options.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );
    const request = createRequest(
      { server: { name: "docs", transportType: "HTTP", url: "https://example.test/mcp" }, runtime },
      runtime,
    );
    const response = createResponse();
    const handled = handleAilliumMcpHttpRequest(request, response, "/api/aillium/mcp/invoke-tool");
    await vi.waitFor(() => expect(observedSignal).toBeDefined());
    request.emit("aborted");
    await handled;
    expect(observedSignal?.aborted).toBe(true);
    expect(response.statusCode).toBe(409);
    expect(JSON.parse(response.body).runtime.payload).toMatchObject({
      operation_id: runtime.payload.operation_id,
      status: "UNKNOWN",
      reconciliation_required: true,
    });
  });

  it("returns canonical CANCELLED for an interrupted read-only resource call", async () => {
    const base = createExecution();
    const runtime = RuntimeWireEnvelopeV1Schema.parse({
      ...base,
      payload: {
        ...base.payload,
        tool_name: "mcp.resource.read",
        input: { uri: "file:///report.txt" },
      },
    }) as Extract<RuntimeWireEnvelopeV1, { message_type: "TOOL_EXECUTE_REQUEST" }>;
    let observedSignal: AbortSignal | undefined;
    mocks.readResource.mockImplementation(
      (_params: unknown, options: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          observedSignal = options.signal;
          options.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );
    const request = createRequest(
      {
        server: { name: "docs", transportType: "HTTP", url: "https://example.test/mcp" },
        runtime,
      },
      runtime,
    );
    const response = createResponse();
    const handled = handleAilliumMcpHttpRequest(
      request,
      response,
      "/api/aillium/mcp/read-resource",
    );
    await vi.waitFor(() => expect(observedSignal).toBeDefined());
    request.emit("aborted");
    await handled;
    expect(JSON.parse(response.body).runtime.payload).toMatchObject({
      status: "CANCELLED",
      reconciliation_required: false,
      side_effect: { state: "NOT_APPLIED" },
    });
  });

  it("propagates request abort into discovery connect", async () => {
    let observedSignal: AbortSignal | undefined;
    mocks.connect.mockImplementation(
      (_transport: unknown, options: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          observedSignal = options.signal;
          options.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );
    const response = createResponse();
    const request = createRequest({
      server: { name: "docs", transportType: "HTTP", url: "https://example.test/mcp" },
    });
    const handled = handleAilliumMcpHttpRequest(request, response, "/api/aillium/mcp/discover");
    await vi.waitFor(() => expect(observedSignal).toBeDefined());
    request.emit("aborted");
    await handled;
    expect(observedSignal?.aborted).toBe(true);
    expect(response.statusCode).toBe(200);
  });

  it("bounds MCP client close", async () => {
    vi.useFakeTimers();
    mocks.close.mockReturnValue(new Promise(() => {}));
    const response = createResponse();
    const request = createRequest({
      server: { name: "docs", transportType: "HTTP", url: "https://example.test/mcp" },
    });
    const handled = handleAilliumMcpHttpRequest(request, response, "/api/aillium/mcp/discover");
    await vi.advanceTimersByTimeAsync(1_000);
    await handled;
    expect(response.statusCode).toBe(200);
    expect(mocks.close).toHaveBeenCalled();
  });
});

import type { IncomingMessage, ServerResponse } from "node:http";
import {
  RuntimeContractVersion,
  RuntimeWireEnvelopeV1Schema,
  type RuntimeWireEnvelopeV1,
} from "@aillium/schemas";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";
import { signMcpRuntimeEnvelope, verifyMcpRuntimeEnvelope } from "./aillium-mcp-authority.js";

const MCP_DISCOVER_PATH = "/api/aillium/mcp/discover";
const MCP_INVOKE_TOOL_PATH = "/api/aillium/mcp/invoke-tool";
const MCP_READ_RESOURCE_PATH = "/api/aillium/mcp/read-resource";
const MCP_GET_PROMPT_PATH = "/api/aillium/mcp/get-prompt";
const MCP_CANCEL_PATH = "/api/aillium/mcp/cancel";
const DESKTOP_CAPABILITIES_PATH = "/api/aillium/desktop/capabilities";
const DESKTOP_HANDOFF_PATH = "/api/aillium/desktop/request-handoff";
const DESKTOP_INVOKE_ACTION_PATH = "/api/aillium/desktop/invoke-action";

const serverSchema = z
  .object({
    name: z.string().min(1),
    label: z.string().optional().nullable(),
    transportType: z.enum(["STDIO", "HTTP"]),
    command: z.string().min(1).optional().nullable(),
    args: z.array(z.string().min(1)).optional(),
    url: z.string().url().optional().nullable(),
    config: z.record(z.string(), z.unknown()).optional().nullable(),
  })
  .superRefine((value, ctx) => {
    if (value.transportType === "STDIO" && !value.command?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "command is required for stdio MCP servers",
        path: ["command"],
      });
    }
    if (value.transportType === "HTTP" && !value.url?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "url is required for http MCP servers",
        path: ["url"],
      });
    }
  });

const discoverBodySchema = z.object({
  server: serverSchema,
});

const invokeToolBodySchema = z.object({
  server: serverSchema,
  runtime: z.unknown(),
});

const readResourceBodySchema = z.object({
  server: serverSchema,
  runtime: z.unknown(),
});

const getPromptBodySchema = z.object({
  server: serverSchema,
  runtime: z.unknown(),
});

const cancelBodySchema = z.object({
  runtime: z.unknown(),
  force: z.boolean(),
});

const desktopSurfaceSchema = z.enum(["remote_browser", "local_browser", "local_computer"]);

const desktopCapabilitiesBodySchema = z
  .object({
    includeRuntimeHints: z.boolean().optional(),
  })
  .optional();

const desktopExecutionContextSchema = z.object({
  tenantId: z.string().min(1),
  authorityType: z.enum(["user", "agent"]),
  authorityId: z.string().min(1),
  workOrderId: z.string().min(1),
  runId: z.string().min(1),
  runStepId: z.string().min(1),
  desktopSessionId: z.string().min(1),
  attempt: z.number().int().positive(),
  executorId: z.string().min(1),
  fenceToken: z.string().regex(/^\d+$/, "fenceToken must be an unsigned decimal string"),
  cancellationGeneration: z.number().int().nonnegative(),
});

const desktopScopedAuthoritySchema = z.object({
  desktopControlToken: z.string().min(1),
  executionContext: desktopExecutionContextSchema,
});

const desktopHandoffBodySchema = desktopScopedAuthoritySchema
  .extend({
    tenantId: z.string().min(1),
    sessionId: z.string().min(1),
    sessionKey: z.string().min(1),
    conversationKey: z.string().min(1).optional().nullable(),
    taskId: z.string().min(1).optional().nullable(),
    requestedSurface: desktopSurfaceSchema.optional(),
    reason: z.string().min(1).optional().nullable(),
    initiatedBy: z.enum(["USER", "AGENT", "SYSTEM"]),
    prompt: z.string().min(1).optional().nullable(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .refine((input) => input.tenantId === input.executionContext.tenantId, {
    message: "tenantId must match executionContext.tenantId",
    path: ["executionContext", "tenantId"],
  })
  .refine((input) => input.sessionId === input.executionContext.desktopSessionId, {
    message: "sessionId must match executionContext.desktopSessionId",
    path: ["executionContext", "desktopSessionId"],
  });

const desktopInvokeActionBodySchema = desktopScopedAuthoritySchema
  .extend({
    tenantId: z.string().min(1),
    sessionId: z.string().min(1),
    sessionKey: z.string().min(1),
    action: z.string().min(1),
    requestedSurface: desktopSurfaceSchema.optional(),
    arguments: z.record(z.string(), z.unknown()).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .refine((input) => input.tenantId === input.executionContext.tenantId, {
    message: "tenantId must match executionContext.tenantId",
    path: ["executionContext", "tenantId"],
  })
  .refine((input) => input.sessionId === input.executionContext.desktopSessionId, {
    message: "sessionId must match executionContext.desktopSessionId",
    path: ["executionContext", "desktopSessionId"],
  });

type AilliumMcpServer = z.infer<typeof serverSchema>;
type AilliumMcpExecution = Extract<RuntimeWireEnvelopeV1, { message_type: "TOOL_EXECUTE_REQUEST" }>;

class McpOutcomeUnknownError extends Error {
  readonly code = "OUTCOME_UNKNOWN";

  constructor(readonly operationId: string) {
    super(
      `MCP effect ${operationId} was interrupted; its external outcome requires reconciliation.`,
    );
    this.name = "McpOutcomeUnknownError";
  }
}

class McpCancelledError extends Error {
  constructor(readonly operationId: string) {
    super(`MCP operation ${operationId} was cancelled before a side effect could be applied.`);
    this.name = "McpCancelledError";
  }
}

const activeMcpOperations = new Map<
  string,
  {
    controller: AbortController;
    runtime: AilliumMcpExecution;
    done: Promise<void>;
    resolveDone: () => void;
  }
>();

type DesktopCapabilityDescriptor = {
  action: string;
  surface: "remote_browser" | "local_browser" | "local_computer";
  category: "screen" | "browser" | "input" | "computer" | "agent" | "remote_resource";
  description: string;
};

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.destroyed || res.writableEnded) {
    return;
  }
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

function createRequestAbortSignal(req: IncomingMessage, res: ServerResponse) {
  const controller = new AbortController();
  const onAborted = () => controller.abort(new Error("Core MCP request was aborted"));
  const onResponseClose = () => {
    if (!res.writableEnded) {
      onAborted();
    }
  };
  req.once("aborted", onAborted);
  if (typeof res.once === "function") {
    res.once("close", onResponseClose);
  }
  return {
    signal: controller.signal,
    cleanup: () => {
      req.removeListener("aborted", onAborted);
      if (typeof res.removeListener === "function") {
        res.removeListener("close", onResponseClose);
      }
    },
  };
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  return raw ? JSON.parse(raw) : {};
}

function authorizedRuntimeSecret(req: IncomingMessage): string | null {
  const configured = [
    process.env.AILLIUM_MCP_RUNTIME_TOKEN,
    process.env.OPENCLAW_GATEWAY_TOKEN,
    process.env.MASTER_AGENT_RUNTIME_SYNC_TOKEN,
  ]
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value));
  if (configured.length === 0) {
    return null;
  }

  const runtimeToken =
    (typeof req.headers["x-aillium-runtime-token"] === "string"
      ? req.headers["x-aillium-runtime-token"]
      : undefined) ?? "";
  const authorization =
    typeof req.headers.authorization === "string" ? req.headers.authorization : "";
  const bearerToken = authorization.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length).trim()
    : "";
  const presented = runtimeToken.trim() || bearerToken;

  return presented.length > 0 && configured.includes(presented) ? presented : null;
}

function getEnhancedPath(originalPath: string): string {
  const pathSeparator = process.platform === "win32" ? ";" : ":";
  const existing = new Set(originalPath.split(pathSeparator).filter(Boolean));
  const homeDir = process.env.HOME || process.env.USERPROFILE || "";
  const additions =
    process.platform === "darwin"
      ? [
          "/bin",
          "/usr/bin",
          "/usr/local/bin",
          "/opt/homebrew/bin",
          `${homeDir}/.nvm/current/bin`,
          `${homeDir}/.npm-global/bin`,
          `${homeDir}/.yarn/bin`,
          `${homeDir}/.cargo/bin`,
        ]
      : process.platform === "linux"
        ? [
            "/bin",
            "/usr/bin",
            "/usr/local/bin",
            `${homeDir}/.nvm/current/bin`,
            `${homeDir}/.npm-global/bin`,
            `${homeDir}/.yarn/bin`,
            `${homeDir}/.cargo/bin`,
            "/snap/bin",
          ]
        : [`${process.env.APPDATA}\\npm`, `${homeDir}\\.cargo\\bin`];

  for (const value of additions) {
    if (value && !existing.has(value)) {
      existing.add(value);
    }
  }

  return [...existing].join(pathSeparator);
}

function stringifyConfigValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  if (value == null) {
    return "";
  }
  return JSON.stringify(value);
}

function mcpRequestOptions(execution?: AilliumMcpExecution, signal?: AbortSignal) {
  const remainingMs = execution
    ? Math.max(1, Date.parse(execution.payload.deadline_at) - Date.now())
    : 15_000;
  return {
    ...(signal ? { signal } : {}),
    timeout: remainingMs,
    maxTotalTimeout: remainingMs,
  };
}

function isInterruptedMcpCall(
  error: unknown,
  execution: AilliumMcpExecution,
  signal?: AbortSignal,
): boolean {
  if (signal?.aborted || Date.now() >= Date.parse(execution.payload.deadline_at)) {
    return true;
  }
  const record = error && typeof error === "object" ? (error as Record<string, unknown>) : {};
  const message = error instanceof Error ? error.message : String(error);
  return (
    record.name === "AbortError" ||
    record.code === "RequestTimeout" ||
    /abort|cancel|deadline|timed? ?out|request timeout/i.test(message)
  );
}

async function closeMcpClient(client: Client): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      client.close().catch(() => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, 1_000);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

async function withMcpClient<T>(
  server: AilliumMcpServer,
  execution: AilliumMcpExecution | undefined,
  signal: AbortSignal | undefined,
  irreversible: boolean,
  fn: (client: Client) => Promise<T>,
): Promise<T> {
  const client = new Client(
    {
      name: `aillium-${server.name}`,
      version: "1.0.0",
    },
    {
      capabilities: {},
    },
  );

  try {
    if (server.transportType === "STDIO") {
      const config = server.config ?? {};
      const env =
        config.env && typeof config.env === "object"
          ? Object.fromEntries(
              Object.entries(config.env as Record<string, unknown>).map(([key, value]) => [
                key,
                stringifyConfigValue(value),
              ]),
            )
          : {};
      const cwd = typeof config.cwd === "string" && config.cwd.trim() ? config.cwd : undefined;
      const command =
        process.platform === "win32" && server.command === "npx"
          ? "npx.cmd"
          : process.platform === "win32" && server.command === "node"
            ? "node.exe"
            : (server.command as string);
      const transport = new StdioClientTransport({
        command,
        args: server.args ?? [],
        stderr: process.platform === "win32" ? "pipe" : "inherit",
        env: {
          ...process.env,
          PATH: getEnhancedPath(process.env.PATH || ""),
          ...env,
          ...(execution
            ? {
                AILLIUM_EFFECT_ID: execution.payload.operation_id,
                AILLIUM_IDEMPOTENCY_KEY: execution.context.idempotency_key,
                AILLIUM_LEASE_FENCE: execution.context.fence_token,
              }
            : {}),
        },
        ...(cwd ? { cwd } : {}),
      });
      await client.connect(transport, mcpRequestOptions(execution, signal));
    } else {
      const config = server.config ?? {};
      const headers =
        config.headers && typeof config.headers === "object"
          ? Object.fromEntries(
              Object.entries(config.headers as Record<string, unknown>).map(([key, value]) => [
                key,
                stringifyConfigValue(value),
              ]),
            )
          : undefined;
      const transport = new StreamableHTTPClientTransport(new URL(server.url as string), {
        requestInit: {
          headers: {
            ...headers,
            ...(execution
              ? {
                  "x-aillium-effect-id": execution.payload.operation_id,
                  "x-aillium-idempotency-key": execution.context.idempotency_key,
                  "x-aillium-lease-fence": execution.context.fence_token,
                }
              : {}),
          },
        },
      });
      await client.connect(transport, mcpRequestOptions(execution, signal));
    }
    return await fn(client);
  } catch (error) {
    if (execution && isInterruptedMcpCall(error, execution, signal)) {
      if (irreversible) {
        throw new McpOutcomeUnknownError(execution.payload.operation_id);
      }
      throw new McpCancelledError(execution.payload.operation_id);
    }
    throw error;
  } finally {
    await closeMcpClient(client);
  }
}

async function discoverServer(server: AilliumMcpServer, signal?: AbortSignal) {
  try {
    return await withMcpClient(server, undefined, signal, false, async (client) => {
      const [tools, resources, prompts] = await Promise.allSettled([
        client.listTools(),
        client.listResources(),
        client.listPrompts(),
      ]);

      const degraded = [tools, resources, prompts].some((entry) => entry.status === "rejected");
      const rejected = [tools, resources, prompts]
        .filter((entry): entry is PromiseRejectedResult => entry.status === "rejected")
        .map((entry) => String(entry.reason));

      return {
        healthStatus: degraded ? "DEGRADED" : "HEALTHY",
        lastError: rejected[0] ?? null,
        catalog: {
          tools: tools.status === "fulfilled" ? (tools.value.tools ?? []) : [],
          resources: resources.status === "fulfilled" ? (resources.value.resources ?? []) : [],
          prompts: prompts.status === "fulfilled" ? (prompts.value.prompts ?? []) : [],
        },
      };
    });
  } catch (error) {
    return {
      healthStatus: "UNREACHABLE",
      lastError: String(error),
      catalog: {
        tools: [],
        resources: [],
        prompts: [],
      },
    };
  }
}

function requireToolExecuteRuntime(runtime: RuntimeWireEnvelopeV1): AilliumMcpExecution {
  if (runtime.message_type !== "TOOL_EXECUTE_REQUEST") {
    throw new Error("Expected a TOOL_EXECUTE_REQUEST runtime envelope");
  }
  return runtime;
}

function sameMcpOperationIdentity(
  execution: AilliumMcpExecution,
  cancellation: Extract<RuntimeWireEnvelopeV1, { message_type: "TOOL_CANCEL_REQUEST" }>,
): boolean {
  const left = execution.context;
  const right = cancellation.context;
  return (
    left.tenant_id === right.tenant_id &&
    left.work_order_id === right.work_order_id &&
    left.run_id === right.run_id &&
    left.run_step_id === right.run_step_id &&
    left.attempt === right.attempt &&
    left.idempotency_key === right.idempotency_key &&
    left.fence_token === right.fence_token &&
    left.executor_id === right.executor_id &&
    left.lease_id === right.lease_id &&
    left.lease_epoch === right.lease_epoch &&
    left.lease_expires_at === right.lease_expires_at &&
    execution.payload.tenant_id === cancellation.payload.tenant_id &&
    execution.payload.work_order_id === cancellation.payload.work_order_id &&
    execution.payload.run_id === cancellation.payload.run_id &&
    execution.payload.run_step_id === cancellation.payload.run_step_id &&
    execution.payload.attempt === cancellation.payload.attempt &&
    execution.payload.operation_id === cancellation.payload.operation_id &&
    execution.payload.idempotency_key === cancellation.payload.idempotency_key &&
    execution.payload.fence_token === cancellation.payload.fence_token
  );
}

async function withActiveMcpOperation<T>(
  runtime: AilliumMcpExecution,
  requestSignal: AbortSignal | undefined,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let resolveDone: () => void = () => {};
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });
  const entry = { controller, runtime, done, resolveDone };
  if (activeMcpOperations.has(runtime.payload.operation_id)) {
    throw new Error(`MCP operation ${runtime.payload.operation_id} is already active`);
  }
  activeMcpOperations.set(runtime.payload.operation_id, entry);
  const signal = requestSignal
    ? AbortSignal.any([requestSignal, controller.signal])
    : controller.signal;
  try {
    return await run(signal);
  } finally {
    if (activeMcpOperations.get(runtime.payload.operation_id) === entry) {
      activeMcpOperations.delete(runtime.payload.operation_id);
    }
    resolveDone();
  }
}

async function invokeTool(
  input: { server: AilliumMcpServer; runtime: RuntimeWireEnvelopeV1 },
  signal?: AbortSignal,
) {
  const execution = requireToolExecuteRuntime(input.runtime);
  const toolInput = execution.payload.input as Record<string, unknown>;
  const argumentsValue = toolInput.arguments;
  const argumentsPayload =
    argumentsValue && typeof argumentsValue === "object" && !Array.isArray(argumentsValue)
      ? (argumentsValue as Record<string, unknown>)
      : {};
  return await withActiveMcpOperation(execution, signal, (operationSignal) =>
    withMcpClient(input.server, execution, operationSignal, true, async (client) => ({
      result: await client.callTool(
        {
          name: execution.payload.tool_name,
          arguments: argumentsPayload,
          _meta: { ailliumExecution: execution },
        },
        undefined,
        mcpRequestOptions(execution, operationSignal),
      ),
    })),
  );
}

async function readResource(
  input: { server: AilliumMcpServer; runtime: RuntimeWireEnvelopeV1 },
  signal?: AbortSignal,
) {
  const execution = requireToolExecuteRuntime(input.runtime);
  const uri = execution.payload.input.uri;
  if (typeof uri !== "string" || !uri) {
    throw new Error("MCP resource runtime input requires uri");
  }
  return await withActiveMcpOperation(execution, signal, (operationSignal) =>
    withMcpClient(input.server, execution, operationSignal, false, async (client) => ({
      result: await client.readResource(
        { uri, _meta: { ailliumExecution: execution } },
        mcpRequestOptions(execution, operationSignal),
      ),
    })),
  );
}

async function getPrompt(
  input: { server: AilliumMcpServer; runtime: RuntimeWireEnvelopeV1 },
  signal?: AbortSignal,
) {
  const execution = requireToolExecuteRuntime(input.runtime);
  const name = execution.payload.input.promptName;
  const argumentsValue = execution.payload.input.arguments;
  const argumentsPayload =
    argumentsValue && typeof argumentsValue === "object" && !Array.isArray(argumentsValue)
      ? Object.fromEntries(
          Object.entries(argumentsValue as Record<string, unknown>).map(([key, value]) => [
            key,
            String(value),
          ]),
        )
      : {};
  if (typeof name !== "string" || !name) {
    throw new Error("MCP prompt runtime input requires promptName");
  }
  return await withActiveMcpOperation(execution, signal, (operationSignal) =>
    withMcpClient(input.server, execution, operationSignal, false, async (client) => ({
      result: await client.getPrompt(
        { name, arguments: argumentsPayload, _meta: { ailliumExecution: execution } },
        mcpRequestOptions(execution, operationSignal),
      ),
    })),
  );
}

function createToolResultRuntime(
  request: AilliumMcpExecution,
  input: {
    status: "SUCCEEDED" | "FAILED" | "CANCELLED" | "UNKNOWN";
    output: unknown;
    message?: string;
  },
): RuntimeWireEnvelopeV1 {
  const now = new Date().toISOString();
  return RuntimeWireEnvelopeV1Schema.parse({
    contract_version: RuntimeContractVersion,
    envelope_id: `${request.envelope_id}:result`,
    emitted_at: now,
    message_type: "TOOL_EXECUTE_RESULT",
    context: request.context,
    payload: {
      tenant_id: request.payload.tenant_id,
      work_order_id: request.payload.work_order_id,
      run_id: request.payload.run_id,
      run_step_id: request.payload.run_step_id,
      attempt: request.payload.attempt,
      operation_id: request.payload.operation_id,
      idempotency_key: request.payload.idempotency_key,
      fence_token: request.payload.fence_token,
      status: input.status,
      output: input.output ?? null,
      error:
        input.status === "FAILED"
          ? {
              code: "MCP_ACTION_FAILED",
              message: input.message ?? "MCP action failed",
              retryable: false,
            }
          : null,
      side_effect: {
        state:
          input.status === "SUCCEEDED"
            ? request.payload.tool_name === "mcp.resource.read" ||
              request.payload.tool_name === "mcp.prompt.get"
              ? "NONE"
              : "APPLIED"
            : input.status === "UNKNOWN"
              ? "UNKNOWN"
              : "NOT_APPLIED",
        external_reference: null,
      },
      reconciliation_required: input.status === "UNKNOWN",
      evidence_ids: [],
      replayed: false,
      started_at: request.emitted_at,
      completed_at: now,
    },
  });
}

async function cancelMcpOperation(
  request: Extract<RuntimeWireEnvelopeV1, { message_type: "TOOL_CANCEL_REQUEST" }>,
  force: boolean,
): Promise<RuntimeWireEnvelopeV1> {
  const entry = activeMcpOperations.get(request.payload.operation_id);
  const acknowledgedAt = new Date();
  if (entry && !sameMcpOperationIdentity(entry.runtime, request)) {
    throw new Error("MCP cancellation identity does not match the active operation");
  }
  if (entry) {
    entry.controller.abort(new Error(request.payload.reason));
    const waitMs = Math.max(1, Date.parse(request.payload.force_by) - Date.now());
    await Promise.race([
      entry.done,
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, Math.min(waitMs, force ? 5_000 : 250));
        timer.unref?.();
      }),
    ]);
  }
  const stillActive = activeMcpOperations.has(request.payload.operation_id);
  const stateReconstructible = Boolean(entry);
  const forcedRequired = !stateReconstructible || stillActive || force;
  const forcedOutcome = !stateReconstructible
    ? "FAILED"
    : stillActive
      ? force
        ? "FAILED"
        : "PENDING"
      : force
        ? "SUCCEEDED"
        : "NOT_REQUIRED";
  return RuntimeWireEnvelopeV1Schema.parse({
    contract_version: RuntimeContractVersion,
    envelope_id: `${request.envelope_id}:result`,
    emitted_at: acknowledgedAt.toISOString(),
    message_type: "TOOL_CANCEL_RESULT",
    context: request.context,
    payload: {
      tenant_id: request.payload.tenant_id,
      work_order_id: request.payload.work_order_id,
      run_id: request.payload.run_id,
      run_step_id: request.payload.run_step_id,
      attempt: request.payload.attempt,
      operation_id: request.payload.operation_id,
      idempotency_key: request.payload.idempotency_key,
      fence_token: request.payload.fence_token,
      cancellation: {
        cancellation_id: request.payload.cancellation_id,
        state: entry ? "ACKNOWLEDGED" : "FAILED",
        requested_at: request.payload.requested_at,
        acknowledge_by: request.payload.acknowledge_by,
        force_by: request.payload.force_by,
        acknowledged_at: acknowledgedAt.toISOString(),
        acknowledgement_latency_ms: Math.max(
          0,
          acknowledgedAt.getTime() - Date.parse(request.payload.requested_at),
        ),
        forced_stop: {
          required: forcedRequired,
          deadline_at: request.payload.force_by,
          enforced_at: force || !stateReconstructible ? acknowledgedAt.toISOString() : null,
          mechanism: !stateReconstructible
            ? "operation-state-not-reconstructible"
            : force
              ? "mcp-client-abort-and-bounded-close"
              : null,
          outcome: forcedOutcome,
        },
      },
    },
  });
}

function sendSignedRuntime(
  res: ServerResponse,
  status: number,
  runtime: RuntimeWireEnvelopeV1,
  secret: string,
): void {
  const headers = signMcpRuntimeEnvelope({
    envelope: runtime,
    secret,
    issuer: "aillium-openclaw",
    audience: "aillium-core",
  });
  for (const [name, value] of Object.entries(headers)) {
    res.setHeader(name, value);
  }
  sendJson(res, status, { runtime });
}

function getDesktopBridgeBaseUrl() {
  return (
    process.env.AILLIUM_DESKTOP_BRIDGE_URL?.trim() ||
    process.env.AILLIUM_UI_TARS_DESKTOP_RPC_URL?.trim() ||
    ""
  );
}

function getDesktopLaunchUrl() {
  return (
    process.env.AILLIUM_OPERATOR_DESKTOP_URL?.trim() ||
    process.env.AILLIUM_DESKTOP_LAUNCH_URL?.trim() ||
    ""
  );
}

function buildDesktopCapabilityCatalog(): DesktopCapabilityDescriptor[] {
  return [
    {
      action: "screen.get_size",
      surface: "local_computer",
      category: "screen",
      description: "Read primary screen dimensions and scale factor.",
    },
    {
      action: "screen.capture",
      surface: "local_computer",
      category: "screen",
      description: "Capture the current desktop or browser viewport as an image.",
    },
    {
      action: "browser.check_availability",
      surface: "local_browser",
      category: "browser",
      description: "Verify a locally controlled browser is available.",
    },
    {
      action: "browser.navigate",
      surface: "local_browser",
      category: "browser",
      description: "Open or navigate the active browser to a target URL.",
    },
    {
      action: "browser.navigate_back",
      surface: "local_browser",
      category: "browser",
      description: "Navigate back in the local browser history.",
    },
    {
      action: "input.type_text",
      surface: "local_computer",
      category: "input",
      description: "Type text into the focused control.",
    },
    {
      action: "input.hotkey",
      surface: "local_computer",
      category: "input",
      description: "Send a keyboard shortcut or system hotkey.",
    },
    {
      action: "mouse.click",
      surface: "local_computer",
      category: "input",
      description: "Click a screen position or an inferred target.",
    },
    {
      action: "mouse.double_click",
      surface: "local_computer",
      category: "input",
      description: "Double-click a screen position or an inferred target.",
    },
    {
      action: "mouse.right_click",
      surface: "local_computer",
      category: "input",
      description: "Open a context menu on the desktop surface.",
    },
    {
      action: "mouse.drag",
      surface: "local_computer",
      category: "input",
      description: "Drag from one desktop coordinate to another.",
    },
    {
      action: "mouse.scroll",
      surface: "local_computer",
      category: "input",
      description: "Scroll on the desktop or within a browser surface.",
    },
    {
      action: "computer.execute_instruction",
      surface: "local_computer",
      category: "computer",
      description: "Execute a high-level desktop instruction through the UI-TARS agent loop.",
    },
    {
      action: "agent.run",
      surface: "local_computer",
      category: "agent",
      description: "Start a UI-TARS agent run with the provided instructions.",
    },
    {
      action: "agent.pause",
      surface: "local_computer",
      category: "agent",
      description: "Pause the active UI-TARS run.",
    },
    {
      action: "agent.resume",
      surface: "local_computer",
      category: "agent",
      description: "Resume the active UI-TARS run.",
    },
    {
      action: "agent.stop",
      surface: "local_computer",
      category: "agent",
      description: "Stop the active UI-TARS run.",
    },
    {
      action: "remote.allocate_browser",
      surface: "remote_browser",
      category: "remote_resource",
      description: "Allocate a remote browser resource when desktop-local control is unavailable.",
    },
    {
      action: "remote.allocate_computer",
      surface: "local_computer",
      category: "remote_resource",
      description: "Allocate a remote computer resource backed by the UI-TARS remote operator.",
    },
    {
      action: "remote.release_resource",
      surface: "remote_browser",
      category: "remote_resource",
      description: "Release a previously allocated remote browser or computer resource.",
    },
    {
      action: "remote.get_rdp_url",
      surface: "local_computer",
      category: "remote_resource",
      description: "Get the remote desktop/RDP endpoint for a provisioned computer resource.",
    },
  ];
}

async function requestDesktopBridge<T>(
  path: string,
  body: Record<string, unknown>,
  desktopControlToken: string,
  signal?: AbortSignal,
): Promise<T> {
  const baseUrl = getDesktopBridgeBaseUrl();
  if (!baseUrl) {
    throw new Error("Desktop RPC bridge URL is not configured");
  }

  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${desktopControlToken}`,
      "X-Aillium-Desktop-Token": desktopControlToken,
    },
    body: JSON.stringify(body),
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(15_000)])
      : AbortSignal.timeout(15_000),
  });
  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(
      typeof payload?.error === "string"
        ? payload.error
        : `Desktop RPC bridge returned ${response.status}`,
    );
  }

  return payload as T;
}

async function getDesktopCapabilities(_input?: z.infer<typeof desktopCapabilitiesBodySchema>) {
  const launchUrl = getDesktopLaunchUrl();
  const bridgeUrl = getDesktopBridgeBaseUrl();
  const catalog = buildDesktopCapabilityCatalog();

  if (!bridgeUrl) {
    return {
      available: Boolean(launchUrl),
      rpcReady: false,
      launchUrl: launchUrl || null,
      provider: "ui-tars-desktop",
      surfaces: ["remote_browser", "local_browser", "local_computer"],
      operators: ["Remote Browser Operator", "Local Browser Operator", "Local Computer Operator"],
      capabilities: catalog,
      note: launchUrl
        ? "Desktop launch URL is configured, but RPC is not yet wired."
        : "Desktop bridge is not configured.",
    };
  }

  return {
    available: true,
    rpcReady: true,
    launchUrl: launchUrl || null,
    provider: "ui-tars-desktop",
    surfaces: ["remote_browser", "local_browser", "local_computer"],
    operators: ["Remote Browser Operator", "Local Browser Operator", "Local Computer Operator"],
    capabilities: catalog,
    note: "Scoped desktop authority is required before capability execution is probed.",
  };
}

async function requestDesktopHandoff(
  input: z.infer<typeof desktopHandoffBodySchema>,
  signal?: AbortSignal,
) {
  const createdAt = new Date().toISOString();
  const basePayload = {
    handoffPrepared: true,
    requestId: `desktop-handoff:${input.sessionId}:${Date.now().toString(36)}`,
    createdAt,
    initiatedBy: input.initiatedBy,
    requestedSurface: input.requestedSurface ?? "local_computer",
    launchUrl: getDesktopLaunchUrl() || null,
    rpcReady: Boolean(getDesktopBridgeBaseUrl()),
    capabilities: buildDesktopCapabilityCatalog(),
    note:
      input.reason ??
      "Desktop handoff prepared. Continue in UI-TARS Desktop when browser-only control is insufficient.",
  };

  if (!getDesktopBridgeBaseUrl()) {
    return basePayload;
  }

  const { desktopControlToken, ...scopedInput } = input;
  const bridged = await requestDesktopBridge<Record<string, unknown>>(
    "/handoff",
    { ...scopedInput, createdAt },
    desktopControlToken,
    signal,
  ).catch((error) => ({ error: String(error) }));

  return {
    ...basePayload,
    bridge: bridged,
  };
}

async function invokeDesktopAction(
  input: z.infer<typeof desktopInvokeActionBodySchema>,
  signal?: AbortSignal,
) {
  const bridgeUrl = getDesktopBridgeBaseUrl();
  if (!bridgeUrl) {
    throw new Error("Desktop RPC bridge URL is not configured");
  }

  const { desktopControlToken, ...scopedInput } = input;
  return await requestDesktopBridge<Record<string, unknown>>(
    "/invoke",
    scopedInput,
    desktopControlToken,
    signal,
  );
}

export async function handleAilliumMcpHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  requestPath: string,
): Promise<boolean> {
  if (
    requestPath !== MCP_DISCOVER_PATH &&
    requestPath !== MCP_INVOKE_TOOL_PATH &&
    requestPath !== MCP_READ_RESOURCE_PATH &&
    requestPath !== MCP_GET_PROMPT_PATH &&
    requestPath !== MCP_CANCEL_PATH &&
    requestPath !== DESKTOP_CAPABILITIES_PATH &&
    requestPath !== DESKTOP_HANDOFF_PATH &&
    requestPath !== DESKTOP_INVOKE_ACTION_PATH
  ) {
    return false;
  }

  if ((req.method ?? "GET").toUpperCase() !== "POST") {
    res.statusCode = 405;
    res.setHeader("Allow", "POST");
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("Method Not Allowed");
    return true;
  }

  const runtimeSecret = authorizedRuntimeSecret(req);
  if (!runtimeSecret) {
    sendJson(res, 401, { error: "Unauthorized" });
    return true;
  }

  const requestAbort = createRequestAbortSignal(req, res);
  let activeRequestRuntime: AilliumMcpExecution | undefined;
  try {
    const body = await readJsonBody(req);
    if (requestPath === MCP_DISCOVER_PATH) {
      const parsed = discoverBodySchema.parse(body);
      sendJson(res, 200, await discoverServer(parsed.server, requestAbort.signal));
      return true;
    }

    if (requestPath === DESKTOP_CAPABILITIES_PATH) {
      const parsed = desktopCapabilitiesBodySchema.parse(body);
      sendJson(res, 200, await getDesktopCapabilities(parsed));
      return true;
    }

    if (requestPath === DESKTOP_HANDOFF_PATH) {
      const parsed = desktopHandoffBodySchema.parse(body);
      sendJson(res, 200, await requestDesktopHandoff(parsed, requestAbort.signal));
      return true;
    }

    if (requestPath === DESKTOP_INVOKE_ACTION_PATH) {
      const parsed = desktopInvokeActionBodySchema.parse(body);
      sendJson(res, 200, await invokeDesktopAction(parsed, requestAbort.signal));
      return true;
    }

    if (requestPath === MCP_CANCEL_PATH) {
      const parsed = cancelBodySchema.parse(body);
      const runtime = verifyMcpRuntimeEnvelope({
        envelope: parsed.runtime,
        headers: req.headers,
        secret: runtimeSecret,
        issuer: "aillium-core",
        audience: "connector:mcp",
      });
      if (runtime.message_type !== "TOOL_CANCEL_REQUEST") {
        throw new Error("Expected a TOOL_CANCEL_REQUEST runtime envelope");
      }
      sendSignedRuntime(res, 200, await cancelMcpOperation(runtime, parsed.force), runtimeSecret);
      return true;
    }

    if (requestPath === MCP_READ_RESOURCE_PATH) {
      const parsed = readResourceBodySchema.parse(body);
      const runtime = verifyMcpRuntimeEnvelope({
        envelope: parsed.runtime,
        headers: req.headers,
        secret: runtimeSecret,
        issuer: "aillium-core",
        audience: "connector:mcp",
      });
      activeRequestRuntime = requireToolExecuteRuntime(runtime);
      const result = await readResource({ ...parsed, runtime }, requestAbort.signal);
      sendSignedRuntime(
        res,
        200,
        createToolResultRuntime(activeRequestRuntime, {
          status: "SUCCEEDED",
          output: result.result,
        }),
        runtimeSecret,
      );
      return true;
    }

    if (requestPath === MCP_GET_PROMPT_PATH) {
      const parsed = getPromptBodySchema.parse(body);
      const runtime = verifyMcpRuntimeEnvelope({
        envelope: parsed.runtime,
        headers: req.headers,
        secret: runtimeSecret,
        issuer: "aillium-core",
        audience: "connector:mcp",
      });
      activeRequestRuntime = requireToolExecuteRuntime(runtime);
      const result = await getPrompt({ ...parsed, runtime }, requestAbort.signal);
      sendSignedRuntime(
        res,
        200,
        createToolResultRuntime(activeRequestRuntime, {
          status: "SUCCEEDED",
          output: result.result,
        }),
        runtimeSecret,
      );
      return true;
    }

    const parsed = invokeToolBodySchema.parse(body);
    const runtime = verifyMcpRuntimeEnvelope({
      envelope: parsed.runtime,
      headers: req.headers,
      secret: runtimeSecret,
      issuer: "aillium-core",
      audience: "connector:mcp",
    });
    activeRequestRuntime = requireToolExecuteRuntime(runtime);
    const result = await invokeTool({ ...parsed, runtime }, requestAbort.signal);
    sendSignedRuntime(
      res,
      200,
      createToolResultRuntime(activeRequestRuntime, {
        status: "SUCCEEDED",
        output: result.result,
      }),
      runtimeSecret,
    );
    return true;
  } catch (error) {
    if (error instanceof McpCancelledError && activeRequestRuntime) {
      sendSignedRuntime(
        res,
        409,
        createToolResultRuntime(activeRequestRuntime, {
          status: "CANCELLED",
          output: null,
          message: error.message,
        }),
        runtimeSecret,
      );
      return true;
    }
    if (error instanceof McpOutcomeUnknownError && activeRequestRuntime) {
      sendSignedRuntime(
        res,
        409,
        createToolResultRuntime(activeRequestRuntime, {
          status: "UNKNOWN",
          output: null,
          message: error.message,
        }),
        runtimeSecret,
      );
      return true;
    }
    if (activeRequestRuntime) {
      sendSignedRuntime(
        res,
        400,
        createToolResultRuntime(activeRequestRuntime, {
          status: "FAILED",
          output: null,
          message: error instanceof Error ? error.message : "MCP action failed",
        }),
        runtimeSecret,
      );
      return true;
    }
    sendJson(res, 400, {
      error: error instanceof Error ? error.message : "Invalid MCP request",
    });
    return true;
  } finally {
    requestAbort.cleanup();
  }
}

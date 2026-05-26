import type { IncomingMessage, ServerResponse } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";

const MCP_DISCOVER_PATH = "/api/aillium/mcp/discover";
const MCP_INVOKE_TOOL_PATH = "/api/aillium/mcp/invoke-tool";
const MCP_READ_RESOURCE_PATH = "/api/aillium/mcp/read-resource";
const MCP_GET_PROMPT_PATH = "/api/aillium/mcp/get-prompt";
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
  toolName: z.string().min(1),
  arguments: z.record(z.string(), z.unknown()).optional(),
});

const readResourceBodySchema = z.object({
  server: serverSchema,
  uri: z.string().min(1),
});

const getPromptBodySchema = z.object({
  server: serverSchema,
  name: z.string().min(1),
  arguments: z.record(z.string(), z.string()).optional(),
});

const desktopSurfaceSchema = z.enum(["remote_browser", "local_browser", "local_computer"]);

const desktopCapabilitiesBodySchema = z
  .object({
    includeRuntimeHints: z.boolean().optional(),
  })
  .optional();

const desktopHandoffBodySchema = z.object({
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
});

const desktopInvokeActionBodySchema = z.object({
  tenantId: z.string().min(1),
  sessionId: z.string().min(1),
  sessionKey: z.string().min(1),
  action: z.string().min(1),
  requestedSurface: desktopSurfaceSchema.optional(),
  arguments: z.record(z.string(), z.unknown()).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

type AilliumMcpServer = z.infer<typeof serverSchema>;

type DesktopCapabilityDescriptor = {
  action: string;
  surface: "remote_browser" | "local_browser" | "local_computer";
  category: "screen" | "browser" | "input" | "computer" | "agent" | "remote_resource";
  description: string;
};

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  return raw ? JSON.parse(raw) : {};
}

function isAuthorized(req: IncomingMessage): boolean {
  const configured = [
    process.env.AILLIUM_MCP_RUNTIME_TOKEN,
    process.env.OPENCLAW_GATEWAY_TOKEN,
    process.env.MASTER_AGENT_RUNTIME_SYNC_TOKEN,
  ]
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value));
  if (configured.length === 0) {
    return false;
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

  return presented.length > 0 && configured.includes(presented);
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

async function withMcpClient<T>(
  server: AilliumMcpServer,
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

  if (server.transportType === "STDIO") {
    const config = (server.config ?? {}) as Record<string, unknown>;
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
      },
      ...(cwd ? { cwd } : {}),
    });
    await client.connect(transport);
  } else {
    const config = (server.config ?? {}) as Record<string, unknown>;
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
      requestInit: headers ? { headers } : undefined,
    });
    await client.connect(transport);
  }

  try {
    return await fn(client);
  } finally {
    await client.close().catch(() => undefined);
  }
}

async function discoverServer(server: AilliumMcpServer) {
  try {
    return await withMcpClient(server, async (client) => {
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

async function invokeTool(input: z.infer<typeof invokeToolBodySchema>) {
  return await withMcpClient(input.server, async (client) => ({
    result: await client.callTool({
      name: input.toolName,
      arguments: input.arguments ?? {},
    }),
  }));
}

async function readResource(input: z.infer<typeof readResourceBodySchema>) {
  return await withMcpClient(input.server, async (client) => ({
    result: await client.readResource(
      {
        uri: input.uri,
      },
      {},
    ),
  }));
}

async function getPrompt(input: z.infer<typeof getPromptBodySchema>) {
  return await withMcpClient(input.server, async (client) => ({
    result: await client.getPrompt({
      name: input.name,
      arguments: input.arguments ?? {},
    }),
  }));
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

function getDesktopBridgeToken() {
  return (
    process.env.AILLIUM_DESKTOP_BRIDGE_TOKEN?.trim() ||
    process.env.AILLIUM_RUNTIME_TOKEN?.trim() ||
    process.env.OPENCLAW_GATEWAY_TOKEN?.trim() ||
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

async function requestDesktopBridge<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const baseUrl = getDesktopBridgeBaseUrl();
  if (!baseUrl) {
    throw new Error("Desktop RPC bridge URL is not configured");
  }

  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(getDesktopBridgeToken() ? { Authorization: `Bearer ${getDesktopBridgeToken()}` } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
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

  const bridged = await requestDesktopBridge<Record<string, unknown>>("/capabilities", {}).catch(
    (error) => ({
      available: true,
      rpcReady: false,
      error: String(error),
    }),
  );

  return {
    available: true,
    rpcReady: true,
    launchUrl: launchUrl || null,
    provider: "ui-tars-desktop",
    surfaces: ["remote_browser", "local_browser", "local_computer"],
    operators: ["Remote Browser Operator", "Local Browser Operator", "Local Computer Operator"],
    capabilities: catalog,
    bridge: bridged,
  };
}

async function requestDesktopHandoff(input: z.infer<typeof desktopHandoffBodySchema>) {
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

  const bridged = await requestDesktopBridge<Record<string, unknown>>("/handoff", {
    ...input,
    createdAt,
  }).catch((error) => ({
    error: String(error),
  }));

  return {
    ...basePayload,
    bridge: bridged,
  };
}

async function invokeDesktopAction(input: z.infer<typeof desktopInvokeActionBodySchema>) {
  const bridgeUrl = getDesktopBridgeBaseUrl();
  if (!bridgeUrl) {
    throw new Error("Desktop RPC bridge URL is not configured");
  }

  return await requestDesktopBridge<Record<string, unknown>>("/invoke", input);
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

  if (!isAuthorized(req)) {
    sendJson(res, 401, { error: "Unauthorized" });
    return true;
  }

  try {
    const body = await readJsonBody(req);
    if (requestPath === MCP_DISCOVER_PATH) {
      const parsed = discoverBodySchema.parse(body);
      sendJson(res, 200, await discoverServer(parsed.server));
      return true;
    }

    if (requestPath === DESKTOP_CAPABILITIES_PATH) {
      const parsed = desktopCapabilitiesBodySchema.parse(body);
      sendJson(res, 200, await getDesktopCapabilities(parsed));
      return true;
    }

    if (requestPath === DESKTOP_HANDOFF_PATH) {
      const parsed = desktopHandoffBodySchema.parse(body);
      sendJson(res, 200, await requestDesktopHandoff(parsed));
      return true;
    }

    if (requestPath === DESKTOP_INVOKE_ACTION_PATH) {
      const parsed = desktopInvokeActionBodySchema.parse(body);
      sendJson(res, 200, await invokeDesktopAction(parsed));
      return true;
    }

    if (requestPath === MCP_READ_RESOURCE_PATH) {
      const parsed = readResourceBodySchema.parse(body);
      sendJson(res, 200, await readResource(parsed));
      return true;
    }

    if (requestPath === MCP_GET_PROMPT_PATH) {
      const parsed = getPromptBodySchema.parse(body);
      sendJson(res, 200, await getPrompt(parsed));
      return true;
    }

    const parsed = invokeToolBodySchema.parse(body);
    sendJson(res, 200, await invokeTool(parsed));
    return true;
  } catch (error) {
    sendJson(res, 400, {
      error: error instanceof Error ? error.message : "Invalid MCP request",
    });
    return true;
  }
}

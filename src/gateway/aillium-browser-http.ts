import { readFile, unlink } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import {
  createBrowserControlContext,
  startBrowserControlServiceFromConfig,
} from "../browser/control-service.js";
import { createBrowserRouteDispatcher } from "../browser/routes/dispatcher.js";
import { readJsonBodyOrError, sendMethodNotAllowed } from "./http-common.js";
import { getBearerToken } from "./http-utils.js";

const AILLIUM_BROWSER_CAPTURE_PATH = "/api/aillium/browser/capture";
const BODY_LIMIT_BYTES = 16 * 1024;

const captureBodySchema = z.object({
  profile: z.string().min(1).max(128).optional(),
});

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

function isAuthorized(req: IncomingMessage): boolean {
  const configuredTokens = [
    process.env.AILLIUM_RUNTIME_TOKEN,
    process.env.AILLIUM_MCP_RUNTIME_TOKEN,
    process.env.OPENCLAW_GATEWAY_TOKEN,
    process.env.MASTER_AGENT_RUNTIME_SYNC_TOKEN,
  ]
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value));
  if (configuredTokens.length === 0) {
    return false;
  }

  const runtimeToken =
    typeof req.headers["x-aillium-runtime-token"] === "string"
      ? req.headers["x-aillium-runtime-token"].trim()
      : "";
  const presented = runtimeToken || getBearerToken(req) || "";
  return configuredTokens.includes(presented);
}

export async function handleAilliumBrowserRequest(
  req: IncomingMessage,
  res: ServerResponse,
  requestPath: string,
): Promise<boolean> {
  if (requestPath !== AILLIUM_BROWSER_CAPTURE_PATH) {
    return false;
  }
  if (req.method !== "POST") {
    sendMethodNotAllowed(res, "POST");
    return true;
  }
  if (!isAuthorized(req)) {
    sendJson(res, 401, { error: "Unauthorized" });
    return true;
  }

  try {
    const rawBody = await readJsonBodyOrError(req, res, BODY_LIMIT_BYTES);
    if (rawBody === undefined) {
      return true;
    }
    const body = captureBodySchema.parse(rawBody);
    const browser = await startBrowserControlServiceFromConfig();
    if (!browser) {
      sendJson(res, 503, {
        available: false,
        error: "Browser control is disabled",
      });
      return true;
    }

    const dispatcher = createBrowserRouteDispatcher(createBrowserControlContext());
    const capture = await dispatcher.dispatch({
      method: "POST",
      path: "/screenshot",
      query: body.profile ? { profile: body.profile } : undefined,
      body: {
        type: "jpeg",
        fullPage: false,
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (capture.status >= 400) {
      const error =
        capture.body &&
        typeof capture.body === "object" &&
        "error" in capture.body &&
        typeof capture.body.error === "string"
          ? capture.body.error
          : `Browser capture failed (${capture.status})`;
      sendJson(res, capture.status, { available: false, error });
      return true;
    }

    const result = capture.body as {
      path?: unknown;
      targetId?: unknown;
      url?: unknown;
    };
    if (typeof result.path !== "string" || !result.path) {
      sendJson(res, 502, {
        available: false,
        error: "Browser capture did not return an image",
      });
      return true;
    }
    let image: Buffer;
    try {
      image = await readFile(result.path);
    } finally {
      // The normal browser screenshot route persists media for later serving.
      // Observer frames are ephemeral and poll frequently, so remove each file
      // after reading it to prevent an unbounded media-directory backlog.
      await unlink(result.path).catch(() => undefined);
    }
    sendJson(res, 200, {
      available: true,
      dataUrl: `data:image/jpeg;base64,${image.toString("base64")}`,
      targetId: typeof result.targetId === "string" ? result.targetId : null,
      url: typeof result.url === "string" ? result.url : null,
      capturedAt: new Date().toISOString(),
    });
    return true;
  } catch (error) {
    sendJson(res, 503, {
      available: false,
      error: error instanceof Error ? error.message : "Browser capture failed",
    });
    return true;
  }
}

import type { IncomingMessage, ServerResponse } from "node:http";
import { readJsonBodyOrError, sendMethodNotAllowed } from "./http-common.js";
import { getBearerToken, getHeader } from "./http-utils.js";

const MOBILE_AVATAR_BODY_LIMIT_BYTES = 1024 * 1024;
const MOBILE_AVATAR_CORS_HEADERS = "Authorization, Content-Type, X-Tenant-Id";

function applyConfiguredCors(
  req: IncomingMessage,
  res: ServerResponse,
  method: "GET" | "POST",
): boolean {
  const allowedOrigin = process.env.AILLIUM_PORTAL_ORIGIN?.trim();
  const requestOrigin = getHeader(req, "origin")?.trim();
  const originMatches = Boolean(allowedOrigin && requestOrigin === allowedOrigin);

  if (originMatches) {
    res.setHeader("Access-Control-Allow-Origin", allowedOrigin!);
    res.setHeader("Vary", "Origin");
  }
  if (req.method !== "OPTIONS") {
    return false;
  }
  if (!originMatches) {
    res.statusCode = 403;
    res.end("Origin not allowed");
    return true;
  }
  res.statusCode = 204;
  res.setHeader("Access-Control-Allow-Methods", method);
  res.setHeader("Access-Control-Allow-Headers", MOBILE_AVATAR_CORS_HEADERS);
  res.end();
  return true;
}

function resolveCoreUrl(): string | undefined {
  return process.env.AILLIUM_CORE_URL?.trim().replace(/\/+$/, "") || undefined;
}

export async function handleMobileAvatarRequest(
  req: IncomingMessage,
  res: ServerResponse,
  requestPath: string,
): Promise<boolean> {
  if (requestPath !== "/mobile/avatar") {
    return false;
  }

  if (applyConfiguredCors(req, res, "GET")) {
    return true;
  }
  if (req.method !== "GET") {
    sendMethodNotAllowed(res, "GET, OPTIONS");
    return true;
  }

  const token = getBearerToken(req);
  if (!token) {
    res.statusCode = 401;
    res.end("Unauthorized");
    return true;
  }

  const coreUrl = resolveCoreUrl();
  if (!coreUrl) {
    res.statusCode = 503;
    res.end("Aillium Core URL not configured");
    return true;
  }

  try {
    const response = await fetch(`${coreUrl}/mobile/avatar`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        "X-Tenant-Id": getHeader(req, "x-tenant-id")?.trim() ?? "",
        Accept: "application/json",
      },
    });

    const data = await response.json();
    res.statusCode = response.status;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify(data));
  } catch {
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ error: "Failed to fetch avatar aggregate from core" }));
  }

  return true;
}

export async function handleMobileAvatarInteractRequest(
  req: IncomingMessage,
  res: ServerResponse,
  requestPath: string,
): Promise<boolean> {
  if (requestPath !== "/mobile/avatar/interact") {
    return false;
  }

  if (applyConfiguredCors(req, res, "POST")) {
    return true;
  }
  if (req.method !== "POST") {
    sendMethodNotAllowed(res, "POST, OPTIONS");
    return true;
  }

  const token = getBearerToken(req);
  if (!token) {
    res.statusCode = 401;
    res.end("Unauthorized");
    return true;
  }

  const coreUrl = resolveCoreUrl();
  if (!coreUrl) {
    res.statusCode = 503;
    res.end("Aillium Core URL not configured");
    return true;
  }

  try {
    const body = await readJsonBodyOrError(req, res, MOBILE_AVATAR_BODY_LIMIT_BYTES);
    if (body === undefined) {
      return true;
    }

    const response = await fetch(`${coreUrl}/mobile/avatar/interact`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "X-Tenant-Id": getHeader(req, "x-tenant-id")?.trim() ?? "",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    const data = await response.json();
    res.statusCode = response.status;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify(data));
  } catch {
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ error: "Failed to interact with avatar" }));
  }

  return true;
}

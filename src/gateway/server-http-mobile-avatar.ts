import type { IncomingMessage, ServerResponse } from "node:http";

export async function handleMobileAvatarRequest(
  req: IncomingMessage,
  res: ServerResponse,
  requestPath: string,
): Promise<boolean> {
  if (requestPath !== "/mobile/avatar") {
    return false;
  }

  const authHeader = req.headers["authorization"];
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : undefined;
  if (!token) {
    res.statusCode = 401;
    res.end("Unauthorized");
    return true;
  }

  const coreUrl = process.env.AILLIUM_CORE_URL?.trim();
  if (!coreUrl) {
    res.statusCode = 503;
    res.end("Aillium Core URL not configured");
    return true;
  }

  const allowedOrigin = process.env.AILLIUM_PORTAL_ORIGIN;
  const requestOrigin = req.headers.origin;

  try {
    const response = await fetch(`${coreUrl}/mobile/avatar`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        "X-Tenant-Id": (req.headers["x-tenant-id"] as string) || "",
        Accept: "application/json",
      },
    });

    const data = await response.json();
    res.statusCode = response.status;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    if (allowedOrigin && requestOrigin === allowedOrigin) {
      res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
      res.setHeader("Vary", "Origin");
    }
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

  const authHeader = req.headers["authorization"];
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : undefined;
  if (!token) {
    res.statusCode = 401;
    res.end("Unauthorized");
    return true;
  }

  const coreUrl = process.env.AILLIUM_CORE_URL?.trim();
  if (!coreUrl) {
    res.statusCode = 503;
    res.end("Aillium Core URL not configured");
    return true;
  }

  const allowedOrigin = process.env.AILLIUM_PORTAL_ORIGIN;
  const requestOrigin = req.headers.origin;

  try {
    const body = await new Promise<string>((resolve, reject) => {
      let data = "";
      req.on("data", (chunk: string) => {
        data += chunk;
      });
      req.on("end", () => resolve(data));
      req.on("error", reject);
    });

    const response = await fetch(`${coreUrl}/mobile/avatar/interact`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "X-Tenant-Id": (req.headers["x-tenant-id"] as string) || "",
        "Content-Type": "application/json",
      },
      body,
    });

    const data = await response.json();
    res.statusCode = response.status;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    if (allowedOrigin && requestOrigin === allowedOrigin) {
      res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
      res.setHeader("Vary", "Origin");
    }
    res.end(JSON.stringify(data));
  } catch {
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ error: "Failed to interact with avatar" }));
  }

  return true;
}

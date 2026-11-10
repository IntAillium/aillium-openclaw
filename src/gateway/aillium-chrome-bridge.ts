import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import WebSocket, { WebSocketServer, type RawData } from "ws";
import { resolveAilliumCoreConfig } from "../aillium/boundary-runtime.js";
import { resolveRelayAuthTokenForPort } from "../browser/extension-relay-auth.js";
import { ensureChromeExtensionRelayServer } from "../browser/extension-relay.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

/**
 * "Aillium for Chrome": the extension in the owner's own Chrome connects out
 * to this gateway over WSS with a pairing code from Aillium. Core checks the
 * code, then the connection is joined to the local extension relay, so the
 * agent drives the owner's Chrome exactly as it would a local one.
 *
 * One Chrome at a time. The relay stays on loopback; only this checked path
 * is reachable from outside.
 */

export const AILLIUM_CHROME_CONNECT_PATH = "/api/aillium/chrome/connect";
export const AILLIUM_CHROME_STATUS_PATH = "/api/aillium/chrome/status";
export const AILLIUM_CHROME_PROFILE = "aillium-chrome";
const DEFAULT_RELAY_URL = "http://127.0.0.1:18792";
const RELAY_ORIGIN = "chrome-extension://aillium-hosted";
// Screenshots travel over this socket.
const MAX_PAYLOAD_BYTES = 64 * 1024 * 1024;

const log = createSubsystemLogger("gateway").child("aillium-chrome");

export type AilliumChromeConnection = {
  connectionId: string;
  tenantId: string;
  userId: string;
  label: string;
  connectedAt: string;
};

type Live = { info: AilliumChromeConnection; extension: WebSocket; relay: WebSocket };

let live: Live | null = null;
const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD_BYTES });

export function getAilliumChromeStatus():
  | ({ connected: true } & AilliumChromeConnection)
  | { connected: false } {
  return live ? { connected: true, ...live.info } : { connected: false };
}

export function resetAilliumChromeBridgeForTest() {
  live?.extension.terminate();
  live?.relay.terminate();
  live = null;
}

function relayUrl(): URL {
  return new URL(process.env.AILLIUM_CHROME_RELAY_URL?.trim() || DEFAULT_RELAY_URL);
}

function reject(socket: Duplex, status: number, message: string) {
  socket.write(
    `HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(message)}\r\n\r\n${message}`,
  );
  socket.destroy();
}

type CoreResult =
  | { ok: true; info: Omit<AilliumChromeConnection, "connectedAt"> }
  | { ok: false; status: number; message: string };

/** Asks Core whether this pairing code is live, and whose Chrome it is. */
export async function verifyChromePairing(
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<CoreResult> {
  const config = resolveAilliumCoreConfig();
  if (!config) {
    return { ok: false, status: 503, message: "Aillium Core is not configured" };
  }
  try {
    const res = await fetchImpl(
      `${config.baseUrl}/master-agent/runtime/chrome-connections/verify`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-aillium-runtime-token": config.syncToken,
        },
        body: JSON.stringify({ token }),
        signal: AbortSignal.timeout(config.timeoutMs ?? 10_000),
      },
    );
    if (!res.ok) {
      return {
        ok: false,
        status: res.status === 404 || res.status === 403 ? 401 : 502,
        message: "Pairing code not accepted",
      };
    }
    const body = (await res.json()) as Record<string, unknown>;
    const str = (key: string) => (typeof body[key] === "string" ? body[key] : "");
    if (!str("connectionId") || !str("tenantId") || !str("userId")) {
      return { ok: false, status: 502, message: "Unexpected answer from Aillium" };
    }
    return {
      ok: true,
      info: {
        connectionId: str("connectionId"),
        tenantId: str("tenantId"),
        userId: str("userId"),
        label: str("label") || "Chrome",
      },
    };
  } catch {
    return { ok: false, status: 503, message: "Aillium is unreachable" };
  }
}

/** Tells Core the Chrome went away, so the log and Settings show it. Best-effort. */
async function reportDisconnected(info: AilliumChromeConnection, fetchImpl: typeof fetch = fetch) {
  const config = resolveAilliumCoreConfig();
  if (!config) {
    return;
  }
  await fetchImpl(`${config.baseUrl}/master-agent/runtime/chrome-connections/disconnected`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-aillium-runtime-token": config.syncToken },
    body: JSON.stringify({ connectionId: info.connectionId }),
    signal: AbortSignal.timeout(10_000),
  }).catch(() => undefined);
}

function openRelaySocket(url: string): Promise<WebSocket> {
  return new Promise((resolve, rejectOpen) => {
    const ws = new WebSocket(url, {
      headers: { origin: RELAY_ORIGIN },
      maxPayload: MAX_PAYLOAD_BYTES,
    });
    const timer = setTimeout(() => {
      ws.terminate();
      rejectOpen(new Error("relay connect timeout"));
    }, 5_000);
    ws.once("open", () => {
      clearTimeout(timer);
      resolve(ws);
    });
    ws.once("error", (err) => {
      clearTimeout(timer);
      rejectOpen(err);
    });
  });
}

function pipe(from: WebSocket, to: WebSocket) {
  from.on("message", (data: RawData, isBinary: boolean) => {
    if (to.readyState === WebSocket.OPEN) {
      to.send(data, { binary: isBinary });
    }
  });
}

/**
 * Handles the extension's WebSocket upgrade. Returns false for other paths.
 * The pairing code comes as `?token=`.
 */
export async function handleAilliumChromeUpgrade(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname !== AILLIUM_CHROME_CONNECT_PATH) {
    return false;
  }
  const token = url.searchParams.get("token")?.trim() ?? "";
  if (!token) {
    reject(socket, 401, "Pairing code required");
    return true;
  }
  const verified = await verifyChromePairing(token);
  if (!verified.ok) {
    log.warn(`[aillium-chrome] refused a Chrome connection: ${verified.message}`);
    reject(socket, verified.status, verified.message);
    return true;
  }
  if (live && live.info.connectionId !== verified.info.connectionId) {
    reject(socket, 409, "Another Chrome is connected to Aillium");
    return true;
  }
  if (live) {
    // The same Chrome reconnecting (its background worker restarted).
    const stale = live;
    live = null;
    stale.extension.terminate();
    stale.relay.terminate();
  }

  let relay: WebSocket;
  try {
    const target = relayUrl();
    await ensureChromeExtensionRelayServer({ cdpUrl: target.origin });
    const port = Number(target.port) || 80;
    const relayToken = await resolveRelayAuthTokenForPort(port);
    relay = await openRelaySocket(
      `ws://${target.host}/extension?token=${encodeURIComponent(relayToken)}`,
    );
  } catch (err) {
    log.warn(`[aillium-chrome] relay unavailable: ${String((err as Error)?.message ?? err)}`);
    reject(socket, 503, "Browser relay unavailable");
    return true;
  }

  wss.handleUpgrade(req, socket, head, (extension) => {
    const info: AilliumChromeConnection = {
      ...verified.info,
      connectedAt: new Date().toISOString(),
    };
    const entry: Live = { info, extension, relay };
    live = entry;
    log.info(`[aillium-chrome] connected: ${info.label} (${info.connectionId})`);
    pipe(extension, relay);
    pipe(relay, extension);
    const close = () => {
      if (extension.readyState === WebSocket.OPEN) {
        extension.close(1000, "closed");
      }
      if (relay.readyState === WebSocket.OPEN) {
        relay.close(1000, "closed");
      }
      if (live === entry) {
        live = null;
        log.info(`[aillium-chrome] disconnected: ${info.label} (${info.connectionId})`);
        void reportDisconnected(info);
      }
    };
    extension.on("close", close);
    relay.on("close", close);
    extension.on("error", close);
    relay.on("error", close);
  });
  return true;
}

/** GET /api/aillium/chrome/status for Core (runtime token checked by the caller). */
export function sendAilliumChromeStatus(res: ServerResponse) {
  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify({ ...getAilliumChromeStatus(), profile: AILLIUM_CHROME_PROFILE }));
}

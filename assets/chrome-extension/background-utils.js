export function reconnectDelayMs(
  attempt,
  opts = { baseMs: 1000, maxMs: 30000, jitterMs: 1000, random: Math.random },
) {
  const baseMs = Number.isFinite(opts.baseMs) ? opts.baseMs : 1000;
  const maxMs = Number.isFinite(opts.maxMs) ? opts.maxMs : 30000;
  const jitterMs = Number.isFinite(opts.jitterMs) ? opts.jitterMs : 1000;
  const random = typeof opts.random === "function" ? opts.random : Math.random;
  const safeAttempt = Math.max(0, Number.isFinite(attempt) ? attempt : 0);
  const backoff = Math.min(baseMs * 2 ** safeAttempt, maxMs);
  return backoff + Math.max(0, jitterMs) * random();
}

export async function deriveRelayToken(gatewayToken, port) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(gatewayToken),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    enc.encode(`openclaw-extension-relay-v1:${port}`),
  );
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function buildRelayWsUrl(port, gatewayToken) {
  const token = String(gatewayToken || "").trim();
  if (!token) {
    throw new Error(
      "Missing gatewayToken in extension settings (chrome.storage.local.gatewayToken)",
    );
  }
  const relayToken = await deriveRelayToken(token, port);
  return `ws://127.0.0.1:${port}/extension?token=${encodeURIComponent(relayToken)}`;
}

export function isRetryableReconnectError(err) {
  const message = err instanceof Error ? err.message : String(err || "");
  if (
    message.includes("Missing gatewayToken") ||
    message.includes("Missing pairing code") ||
    message.includes("Invalid Aillium address") ||
    message.includes("Aillium is stopped")
  ) {
    return false;
  }
  return true;
}

export function isMissingTabError(err) {
  const message = (err instanceof Error ? err.message : String(err || "")).toLowerCase();
  return (
    message.includes("no tab with id") ||
    message.includes("no tab with given id") ||
    message.includes("tab not found")
  );
}

export function isLastRemainingTab(allTabs, tabIdToClose) {
  if (!Array.isArray(allTabs)) {
    return true;
  }
  return allTabs.filter((tab) => tab && tab.id !== tabIdToClose).length === 0;
}

export const DEFAULT_AILLIUM_SERVER = "https://runtime.aillium.cloud";

/**
 * Aillium for Chrome: the WSS address the extension dials out to, carrying
 * the pairing code from Aillium Settings. https only, except for a local test.
 */
export function hostedConnectUrl(serverUrl, pairingCode) {
  const code = String(pairingCode || "").trim();
  if (!code) {
    throw new Error("Missing pairing code");
  }
  let url;
  try {
    url = new URL(String(serverUrl || DEFAULT_AILLIUM_SERVER).trim());
  } catch {
    throw new Error("Invalid Aillium address");
  }
  const local = url.hostname === "127.0.0.1" || url.hostname === "localhost";
  if (url.protocol === "https:" || url.protocol === "wss:") {
    url.protocol = "wss:";
  } else if (local && (url.protocol === "http:" || url.protocol === "ws:")) {
    url.protocol = "ws:";
  } else {
    throw new Error("Invalid Aillium address: it must start with https://");
  }
  url.pathname = "/api/aillium/chrome/connect";
  url.search = `?token=${encodeURIComponent(code)}`;
  url.hash = "";
  return url.toString();
}

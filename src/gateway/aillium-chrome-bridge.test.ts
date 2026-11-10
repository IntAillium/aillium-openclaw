import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket, { WebSocketServer } from "ws";

const mocks = vi.hoisted(() => ({
  ensureRelay: vi.fn(async () => ({})),
  relayToken: vi.fn(async () => "relay-token"),
}));

vi.mock("../browser/extension-relay.js", () => ({
  ensureChromeExtensionRelayServer: mocks.ensureRelay,
}));
vi.mock("../browser/extension-relay-auth.js", () => ({
  resolveRelayAuthTokenForPort: mocks.relayToken,
}));

import {
  getAilliumChromeStatus,
  handleAilliumChromeUpgrade,
  resetAilliumChromeBridgeForTest,
} from "./aillium-chrome-bridge.js";

function listen(server: Server): Promise<number> {
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)),
  );
}

function connect(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.once("open", () => resolve(ws));
    ws.once("unexpected-response", (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
    ws.once("error", reject);
  });
}

function nextMessage(ws: WebSocket): Promise<string> {
  return new Promise((resolve) =>
    ws.once("message", (data: Buffer) => resolve(data.toString("utf8"))),
  );
}

describe("Aillium for Chrome bridge", () => {
  let relayServer: Server;
  let relayWss: WebSocketServer;
  let relayRequests: Array<{ url: string; origin?: string }>;
  let relaySockets: WebSocket[];
  let gateway: Server;
  let gatewayPort: number;
  let coreFetch: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    relayRequests = [];
    relaySockets = [];
    relayServer = createServer();
    relayWss = new WebSocketServer({ server: relayServer });
    relayWss.on("connection", (ws, req) => {
      relayRequests.push({ url: req.url ?? "", origin: req.headers.origin });
      relaySockets.push(ws);
      ws.on("message", (data: Buffer) => ws.send(`relay:${data.toString("utf8")}`));
    });
    const relayPort = await listen(relayServer);
    vi.stubEnv("AILLIUM_CHROME_RELAY_URL", `http://127.0.0.1:${relayPort}`);
    vi.stubEnv("AILLIUM_CORE_URL", "http://core.test");
    vi.stubEnv("AILLIUM_RUNTIME_TOKEN", "runtime-secret");

    coreFetch = vi.fn(async (url: string, init: RequestInit) => {
      if (String(url).endsWith("/disconnected")) {
        return new Response("{}", { status: 200 });
      }
      const { token } = JSON.parse(init.body as string) as { token: string };
      if (token !== "good-code" && token !== "other-code") {
        return new Response(JSON.stringify({ message: "nope" }), { status: 403 });
      }
      return new Response(
        JSON.stringify({
          connectionId: token === "good-code" ? "conn-1" : "conn-2",
          tenantId: "tenant-1",
          userId: "user-1",
          label: "Antz's Mac",
        }),
        { status: 200 },
      );
    });
    vi.stubGlobal("fetch", coreFetch);

    gateway = createServer();
    gateway.on("upgrade", (req, socket, head) => {
      void handleAilliumChromeUpgrade(req, socket, head).then((handled) => {
        if (!handled) {
          socket.destroy();
        }
      });
    });
    gatewayPort = await listen(gateway);
  });

  afterEach(async () => {
    resetAilliumChromeBridgeForTest();
    relayWss.close();
    await new Promise((r) => relayServer.close(r));
    await new Promise((r) => gateway.close(r));
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  const url = (token?: string) =>
    `ws://127.0.0.1:${gatewayPort}/api/aillium/chrome/connect${token ? `?token=${token}` : ""}`;

  it("refuses a connection without a valid pairing code", async () => {
    await expect(connect(url())).rejects.toThrow("HTTP 401");
    await expect(connect(url("bad-code"))).rejects.toThrow("HTTP 401");
    expect(relayRequests).toHaveLength(0);
    expect(getAilliumChromeStatus()).toEqual({ connected: false });
  });

  it("joins a paired Chrome to the local relay and passes messages both ways", async () => {
    const ext = await connect(url("good-code"));
    expect(relayRequests[0]).toEqual({
      url: "/extension?token=relay-token",
      origin: "chrome-extension://aillium-hosted",
    });
    expect(getAilliumChromeStatus()).toMatchObject({
      connected: true,
      connectionId: "conn-1",
      userId: "user-1",
    });
    const reply = nextMessage(ext);
    ext.send("hello");
    expect(await reply).toBe("relay:hello");
    expect(coreFetch).toHaveBeenCalledWith(
      "http://core.test/master-agent/runtime/chrome-connections/verify",
      expect.objectContaining({
        headers: expect.objectContaining({ "x-aillium-runtime-token": "runtime-secret" }),
      }),
    );

    ext.close();
    await vi.waitFor(() => expect(getAilliumChromeStatus()).toEqual({ connected: false }));
    await vi.waitFor(() =>
      expect(coreFetch).toHaveBeenCalledWith(
        "http://core.test/master-agent/runtime/chrome-connections/disconnected",
        expect.anything(),
      ),
    );
  });

  it("allows one Chrome at a time, but lets the same Chrome reconnect", async () => {
    const first = await connect(url("good-code"));
    await expect(connect(url("other-code"))).rejects.toThrow("HTTP 409");
    const again = await connect(url("good-code"));
    await vi.waitFor(() => expect(first.readyState).toBe(WebSocket.CLOSED));
    expect(getAilliumChromeStatus()).toMatchObject({ connected: true, connectionId: "conn-1" });
    again.close();
  });
});

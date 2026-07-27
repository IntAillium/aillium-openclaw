import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  startBrowserControlServiceFromConfig: vi.fn(),
  createBrowserControlContext: vi.fn(() => ({})),
  dispatch: vi.fn(),
  readFile: vi.fn(),
  unlink: vi.fn(),
}));

vi.mock("../browser/control-service.js", () => ({
  startBrowserControlServiceFromConfig: mocks.startBrowserControlServiceFromConfig,
  createBrowserControlContext: mocks.createBrowserControlContext,
}));

vi.mock("../browser/routes/dispatcher.js", () => ({
  createBrowserRouteDispatcher: vi.fn(() => ({ dispatch: mocks.dispatch })),
}));

vi.mock("node:fs/promises", () => ({
  readFile: mocks.readFile,
  unlink: mocks.unlink,
}));

import { handleAilliumBrowserRequest } from "./aillium-browser-http.js";

function createRequest(params: {
  method: string;
  headers?: Record<string, string>;
  body?: string;
}): IncomingMessage {
  const req = Readable.from(params.body === undefined ? [] : [params.body]) as IncomingMessage;
  req.method = params.method;
  req.headers = params.headers ?? {};
  return req;
}

function createResponse(): ServerResponse & {
  body: string;
  headers: Map<string, string>;
} {
  const headers = new Map<string, string>();
  const response = {
    body: "",
    headers,
    statusCode: 200,
    setHeader: vi.fn((name: string, value: string | number | readonly string[]) => {
      headers.set(name.toLowerCase(), String(value));
      return response;
    }),
    end: vi.fn((body?: string) => {
      response.body = body ?? "";
      return response;
    }),
  };
  return response as unknown as ServerResponse & {
    body: string;
    headers: Map<string, string>;
  };
}

describe("Aillium browser observer HTTP route", () => {
  beforeEach(() => {
    vi.stubEnv("OPENCLAW_GATEWAY_TOKEN", "runtime-secret");
    mocks.startBrowserControlServiceFromConfig.mockResolvedValue({ port: 18791 });
    mocks.readFile.mockResolvedValue(Buffer.from("jpeg-bytes"));
    mocks.unlink.mockResolvedValue(undefined);
    mocks.dispatch.mockResolvedValue({
      status: 200,
      body: {
        path: "/tmp/browser-shot.jpg",
        targetId: "tab-1",
        url: "https://example.test",
      },
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  it("ignores unrelated gateway paths", async () => {
    await expect(
      handleAilliumBrowserRequest(createRequest({ method: "POST" }), createResponse(), "/healthz"),
    ).resolves.toBe(false);
  });

  it("rejects capture requests without a runtime token", async () => {
    const response = createResponse();

    await expect(
      handleAilliumBrowserRequest(
        createRequest({ method: "POST", body: "{}" }),
        response,
        "/api/aillium/browser/capture",
      ),
    ).resolves.toBe(true);

    expect(response.statusCode).toBe(401);
    expect(JSON.parse(response.body)).toEqual({ error: "Unauthorized" });
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });

  it("captures an in-process browser frame without exposing its file path", async () => {
    const response = createResponse();

    await handleAilliumBrowserRequest(
      createRequest({
        method: "POST",
        headers: {
          "x-aillium-runtime-token": "runtime-secret",
          "content-type": "application/json",
        },
        body: JSON.stringify({ profile: "aillium" }),
      }),
      response,
      "/api/aillium/browser/capture",
    );

    expect(mocks.dispatch).toHaveBeenCalledWith({
      method: "POST",
      path: "/screenshot",
      query: { profile: "aillium" },
      body: { type: "jpeg", fullPage: false },
      signal: expect.any(AbortSignal),
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(JSON.parse(response.body)).toMatchObject({
      available: true,
      dataUrl: `data:image/jpeg;base64,${Buffer.from("jpeg-bytes").toString("base64")}`,
      targetId: "tab-1",
      url: "https://example.test",
    });
    expect(response.body).not.toContain("/tmp/browser-shot.jpg");
    expect(mocks.unlink).toHaveBeenCalledWith("/tmp/browser-shot.jpg");
  });

  it("returns a stable unavailable state when browser control is disabled", async () => {
    mocks.startBrowserControlServiceFromConfig.mockResolvedValue(null);
    const response = createResponse();

    await handleAilliumBrowserRequest(
      createRequest({
        method: "POST",
        headers: { authorization: "Bearer runtime-secret" },
        body: "{}",
      }),
      response,
      "/api/aillium/browser/capture",
    );

    expect(response.statusCode).toBe(503);
    expect(JSON.parse(response.body)).toEqual({
      available: false,
      error: "Browser control is disabled",
    });
  });
});

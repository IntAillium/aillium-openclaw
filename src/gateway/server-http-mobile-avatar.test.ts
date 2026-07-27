import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  handleMobileAvatarInteractRequest,
  handleMobileAvatarRequest,
} from "./server-http-mobile-avatar.js";

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

describe("Aillium mobile avatar proxy", () => {
  beforeEach(() => {
    vi.stubEnv("AILLIUM_CORE_URL", "https://core.example.test///");
    vi.stubEnv("AILLIUM_PORTAL_ORIGIN", "https://portal.example.test");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("ignores unrelated paths", async () => {
    const handled = await handleMobileAvatarRequest(
      createRequest({ method: "GET" }),
      createResponse(),
      "/health",
    );
    expect(handled).toBe(false);
  });

  it("answers matching CORS preflight requests without requiring a bearer token", async () => {
    const response = createResponse();
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    await expect(
      handleMobileAvatarInteractRequest(
        createRequest({
          method: "OPTIONS",
          headers: { origin: "https://portal.example.test" },
        }),
        response,
        "/mobile/avatar/interact",
      ),
    ).resolves.toBe(true);

    expect(response.statusCode).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("https://portal.example.test");
    expect(response.headers.get("access-control-allow-methods")).toBe("POST");
    expect(response.headers.get("access-control-allow-headers")).toContain("Authorization");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects preflight requests from origins outside the configured portal", async () => {
    const response = createResponse();

    await handleMobileAvatarRequest(
      createRequest({
        method: "OPTIONS",
        headers: { origin: "https://unexpected.example.test" },
      }),
      response,
      "/mobile/avatar",
    );

    expect(response.statusCode).toBe(403);
    expect(response.headers.has("access-control-allow-origin")).toBe(false);
  });

  it("forwards authenticated avatar requests and preserves matching CORS metadata", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ avatar: "ready" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const response = createResponse();

    await handleMobileAvatarRequest(
      createRequest({
        method: "GET",
        headers: {
          authorization: "bearer portal-token",
          origin: "https://portal.example.test",
          "x-tenant-id": "tenant-1",
        },
      }),
      response,
      "/mobile/avatar",
    );

    expect(fetchSpy).toHaveBeenCalledWith("https://core.example.test/mobile/avatar", {
      method: "GET",
      headers: {
        Authorization: "Bearer portal-token",
        "X-Tenant-Id": "tenant-1",
        Accept: "application/json",
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe("https://portal.example.test");
    expect(JSON.parse(response.body)).toEqual({ avatar: "ready" });
  });

  it("validates and bounds interaction JSON before proxying it to Core", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ accepted: true }), {
        status: 202,
        headers: { "content-type": "application/json" },
      }),
    );
    const response = createResponse();

    await handleMobileAvatarInteractRequest(
      createRequest({
        method: "POST",
        headers: {
          authorization: "Bearer portal-token",
          "x-tenant-id": "tenant-1",
        },
        body: JSON.stringify({ action: "wave" }),
      }),
      response,
      "/mobile/avatar/interact",
    );

    expect(fetchSpy).toHaveBeenCalledWith("https://core.example.test/mobile/avatar/interact", {
      method: "POST",
      headers: {
        Authorization: "Bearer portal-token",
        "X-Tenant-Id": "tenant-1",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ action: "wave" }),
    });
    expect(response.statusCode).toBe(202);
  });
});

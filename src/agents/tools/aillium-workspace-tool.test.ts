import { afterEach, describe, expect, it, vi } from "vitest";
import { callAilliumWorkspace, createAilliumWorkspaceTool } from "./aillium-workspace-tool.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

function configure() {
  vi.stubEnv("AILLIUM_CORE_URL", "http://core.test/");
  vi.stubEnv("AILLIUM_RUNTIME_TOKEN", "runtime-token");
}

describe("aillium_workspace tool", () => {
  it("is only offered when Aillium Core is configured", () => {
    vi.stubEnv("AILLIUM_CORE_URL", "");
    vi.stubEnv("AILLIUM_RUNTIME_TOKEN", "");
    vi.stubEnv("OPERATOR_RUNTIME_TOKEN", "");
    expect(createAilliumWorkspaceTool({ agentSessionKey: "agent:main:s1" })).toBeNull();
    configure();
    expect(createAilliumWorkspaceTool({ agentSessionKey: "agent:main:s1" })?.name).toBe(
      "aillium_workspace",
    );
  });

  it("sends the action and its fields to Core with the run's session key", async () => {
    configure();
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ id: "doc1", url: "https://x/docx/doc1" }), { status: 200 }),
    );
    const result = await callAilliumWorkspace({
      sessionKey: "agent:main:s1",
      action: "doc_create",
      args: { action: "doc_create", title: "Plan", content: "# Plan" },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result).toEqual({ id: "doc1", url: "https://x/docx/doc1" });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://core.test/master-agent/runtime/tools");
    expect((init.headers as Record<string, string>)["x-aillium-runtime-token"]).toBe(
      "runtime-token",
    );
    expect(JSON.parse(init.body as string)).toEqual({
      sessionKey: "agent:main:s1",
      action: "doc_create",
      params: { title: "Plan", content: "# Plan" },
    });
  });

  it("passes on Core's own explanation when a call is refused", async () => {
    configure();
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ message: "Lark is not connected." }), { status: 400 }),
    );
    await expect(
      callAilliumWorkspace({
        sessionKey: "agent:main:s1",
        action: "tasks_list",
        args: {},
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toThrow("Lark is not connected.");
  });

  it("refuses outside an Aillium task", async () => {
    configure();
    await expect(callAilliumWorkspace({ action: "tasks_list", args: {} })).rejects.toThrow(
      /inside an Aillium task/,
    );
  });
});

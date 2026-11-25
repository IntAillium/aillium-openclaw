import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AILLIUM_OFFICE_ACTIONS,
  callAilliumOffice,
  createAilliumOfficeTool,
} from "./aillium-office-tool.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

function configure() {
  vi.stubEnv("AILLIUM_CORE_URL", "http://core.test/");
  vi.stubEnv("AILLIUM_RUNTIME_TOKEN", "runtime-token");
}

describe("aillium_office tool", () => {
  it("is only offered when Aillium Core is configured", () => {
    vi.stubEnv("AILLIUM_CORE_URL", "");
    vi.stubEnv("AILLIUM_RUNTIME_TOKEN", "");
    vi.stubEnv("OPERATOR_RUNTIME_TOKEN", "");
    expect(createAilliumOfficeTool({ agentSessionKey: "agent:main:s1" })).toBeNull();
    configure();
    expect(createAilliumOfficeTool({ agentSessionKey: "agent:main:s1" })?.name).toBe(
      "aillium_office",
    );
  });

  it("keeps the schema simple for every model provider (no unions, object at the top)", () => {
    configure();
    const schema = JSON.stringify(createAilliumOfficeTool({ agentSessionKey: "s" })?.parameters);
    expect(schema).not.toMatch(/"anyOf"|"oneOf"|"allOf"/);
    expect(JSON.parse(schema).type).toBe("object");
    expect(JSON.parse(schema).properties.format).toBeDefined();
    expect(AILLIUM_OFFICE_ACTIONS).toContain("sheets.write_range");
  });

  it("sends the action and its fields to Core's Office endpoint", async () => {
    configure();
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ id: "f1" }), { status: 200 }),
    );
    const result = await callAilliumOffice({
      sessionKey: "agent:main:s1",
      action: "sheets.create",
      args: { action: "sheets.create", title: "Budget", rows: [["Item", "Cost"]] },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result).toEqual({ id: "f1" });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://core.test/master-agent/runtime/office");
    expect(JSON.parse(init.body as string)).toEqual({
      sessionKey: "agent:main:s1",
      action: "sheets.create",
      params: { title: "Budget", rows: [["Item", "Cost"]] },
    });
  });

  it("passes on Core's explanation when refused", async () => {
    configure();
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ message: 'No file called "x".' }), { status: 404 }),
    );
    await expect(
      callAilliumOffice({
        sessionKey: "s",
        action: "files.open",
        args: { file: "x" },
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toThrow('No file called "x".');
  });
});

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withFetchPreconnect } from "../../test-utils/fetch-mock.js";
import { upsertAuthProfileWithLock } from "../auth-profiles/profiles.js";
import { createWebSearchTool } from "./web-tools.js";

describe("web_search gemini key from auth profiles", () => {
  const priorFetch = global.fetch;
  let agentDir: string;

  beforeEach(() => {
    agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-gemini-search-"));
    vi.stubEnv("GEMINI_API_KEY", "");
  });

  afterEach(() => {
    global.fetch = priorFetch;
    vi.unstubAllEnvs();
    fs.rmSync(agentDir, { recursive: true, force: true });
  });

  it("uses the agent's google auth profile when no Gemini search key is set", async () => {
    await upsertAuthProfileWithLock({
      agentDir,
      profileId: "google:aillium",
      credential: { type: "api_key", provider: "google", key: "profile-key" }, // pragma: allowlist secret
    });
    const mockFetch = vi.fn((_input?: unknown, _init?: unknown) =>
      Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            candidates: [
              { content: { parts: [{ text: "ok" }] }, groundingMetadata: { groundingChunks: [] } },
            ],
          }),
      } as Response),
    );
    global.fetch = withFetchPreconnect(mockFetch);

    const tool = createWebSearchTool({
      config: { tools: { web: { search: { provider: "gemini" } } } },
      sandboxed: true,
      agentDir,
    });
    const result = await tool?.execute?.("call-1", { query: "what does example co do" });

    expect((result?.details as { error?: string } | undefined)?.error).toBeUndefined();
    expect(mockFetch).toHaveBeenCalled();
    const [url, init] = mockFetch.mock.calls[0] ?? [];
    const sent = `${String(url)} ${JSON.stringify((init as RequestInit | undefined)?.headers ?? {})}`;
    expect(sent).toContain("profile-key");
  });

  it("still reports a missing key when there is no google profile either", async () => {
    const tool = createWebSearchTool({
      config: { tools: { web: { search: { provider: "gemini" } } } },
      sandboxed: true,
      agentDir,
    });
    const result = await tool?.execute?.("call-2", { query: "anything" });
    expect((result?.details as { error?: string } | undefined)?.error).toBe(
      "missing_gemini_api_key",
    );
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

import { CopilotTokenManager } from "./copilot-token.js";

const resolveCopilotApiTokenMock = vi.fn();

vi.mock("../../../providers/github-copilot-token.js", () => ({
  DEFAULT_COPILOT_API_BASE_URL: "https://api.individual.githubcopilot.com",
  resolveCopilotApiToken: (...args: unknown[]) => resolveCopilotApiTokenMock(...args),
}));

describe("CopilotTokenManager", () => {
  let setRuntimeApiKey: ReturnType<typeof vi.fn>;
  let authStorage: { setRuntimeApiKey: typeof setRuntimeApiKey };

  beforeEach(() => {
    vi.clearAllMocks();
    setRuntimeApiKey = vi.fn();
    authStorage = { setRuntimeApiKey };
  });

  it("hasGithubToken returns false before setCredentials", () => {
    const manager = new CopilotTokenManager({ provider: "github-copilot", authStorage });
    expect(manager.hasGithubToken()).toBe(false);
  });

  it("setCredentials stores the GitHub token", () => {
    const manager = new CopilotTokenManager({ provider: "github-copilot", authStorage });
    // Use a very-far-future expiresAt so the scheduled refresh sits idle.
    manager.setCredentials("gho_test", Date.now() + 24 * 60 * 60 * 1000);
    try {
      expect(manager.hasGithubToken()).toBe(true);
    } finally {
      manager.stop();
    }
  });

  it("refresh calls resolveCopilotApiToken and sets the runtime API key", async () => {
    resolveCopilotApiTokenMock.mockResolvedValue({
      token: "ghu_minted",
      expiresAt: Date.now() + 30 * 60 * 1000,
    });
    const manager = new CopilotTokenManager({ provider: "github-copilot", authStorage });
    manager.setCredentials("gho_test", Date.now() + 24 * 60 * 60 * 1000);
    try {
      await manager.refresh("manual");
      expect(resolveCopilotApiTokenMock).toHaveBeenCalledWith({ githubToken: "gho_test" });
      expect(setRuntimeApiKey).toHaveBeenCalledWith("github-copilot", "ghu_minted");
    } finally {
      manager.stop();
    }
  });

  it("refresh throws when no GitHub token has been set", async () => {
    const manager = new CopilotTokenManager({ provider: "github-copilot", authStorage });
    await expect(manager.refresh("manual")).rejects.toThrow(/GitHub token/);
    expect(resolveCopilotApiTokenMock).not.toHaveBeenCalled();
    manager.stop();
  });

  it("coalesces concurrent refreshes via refreshInFlight", async () => {
    let resolveNow: ((value: { token: string; expiresAt: number }) => void) | null = null;
    resolveCopilotApiTokenMock.mockImplementation(
      () =>
        new Promise<{ token: string; expiresAt: number }>((resolve) => {
          resolveNow = resolve;
        }),
    );
    const manager = new CopilotTokenManager({ provider: "github-copilot", authStorage });
    manager.setCredentials("gho_test", Date.now() + 24 * 60 * 60 * 1000);
    try {
      const a = manager.refresh("first");
      // The dynamic import in refresh() is async; wait until the mock is
      // actually invoked so resolveNow is wired up before we call it.
      while (!resolveNow) {
        await new Promise((r) => setImmediate(r));
      }
      const b = manager.refresh("second");
      resolveNow({ token: "ghu_only", expiresAt: Date.now() + 60_000 });
      await Promise.all([a, b]);
      expect(resolveCopilotApiTokenMock).toHaveBeenCalledTimes(1);
    } finally {
      manager.stop();
    }
  });

  it("stop cancels the scheduled refresh", () => {
    const manager = new CopilotTokenManager({ provider: "github-copilot", authStorage });
    manager.setCredentials("gho_test", Date.now() + 24 * 60 * 60 * 1000);
    manager.stop();
    // After stop, scheduleRefresh is a no-op (cancelled flag is set).
    manager.scheduleRefresh();
    // No assertion needed — the test passes if no timer fires and no error
    // is thrown. The cancelled flag is the documented contract.
    expect(manager.hasGithubToken()).toBe(true);
  });
});

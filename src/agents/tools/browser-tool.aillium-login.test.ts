import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchSavedLogin,
  hostAllowedForLogin,
  maskUsername,
  runAilliumLogin,
  type SavedLogin,
} from "./browser-tool.aillium-login.js";

const login: SavedLogin = {
  label: "Tesco",
  username: "owner@example.com",
  password: "s3cret-Pa55",
  domains: ["tesco.com"],
};

describe("hostAllowedForLogin", () => {
  it("allows the site and its subdomains over https only", () => {
    expect(hostAllowedForLogin("https://tesco.com/login", ["tesco.com"])).toBe(true);
    expect(hostAllowedForLogin("https://secure.tesco.com/x", ["https://tesco.com/"])).toBe(true);
    expect(hostAllowedForLogin("https://www.tesco.com", ["*.tesco.com"])).toBe(true);
    expect(hostAllowedForLogin("http://tesco.com/login", ["tesco.com"])).toBe(false);
    expect(hostAllowedForLogin("https://tesco.com.evil.io", ["tesco.com"])).toBe(false);
    expect(hostAllowedForLogin("https://nottesco.com", ["tesco.com"])).toBe(false);
    expect(hostAllowedForLogin("not a url", ["tesco.com"])).toBe(false);
  });
});

describe("maskUsername", () => {
  it("hides most of the username", () => {
    expect(maskUsername("owner@example.com")).toBe("ow…@example.com");
    expect(maskUsername("antz")).toBe("an…");
    expect(maskUsername("ab")).toBe("…");
  });
});

describe("runAilliumLogin", () => {
  function deps(overrides: { url?: string; fieldType?: string; actError?: Error } = {}) {
    const act = vi.fn(async (request: Record<string, unknown>) => {
      if (request.kind === "evaluate") {
        return { ok: true, result: overrides.fieldType ?? "password" };
      }
      if (overrides.actError) {
        throw overrides.actError;
      }
      return { ok: true };
    });
    return {
      act,
      readPage: vi.fn(async () => ({
        targetId: "t1",
        url: overrides.url ?? "https://www.tesco.com/account/login",
      })),
      fetchLogin: vi.fn(async () => login),
    };
  }

  it("fills the form and returns nothing secret", async () => {
    const d = deps();
    const result = await runAilliumLogin(
      {
        sessionKey: "agent:main:task-1",
        credential: "Tesco",
        usernameRef: "e1",
        passwordRef: "e2",
        submitRef: "e3",
      },
      d,
    );
    expect(result).toEqual({
      ok: true,
      login: "Tesco",
      username: "ow…@example.com",
      site: "www.tesco.com",
      submitted: true,
    });
    expect(JSON.stringify(result)).not.toContain(login.password);
    expect(d.act).toHaveBeenCalledWith({
      targetId: "t1",
      kind: "type",
      ref: "e2",
      text: login.password,
    });
    expect(d.act).toHaveBeenLastCalledWith({ targetId: "t1", kind: "click", ref: "e3" });
  });

  it("refuses a page that is not the login's site", async () => {
    const d = deps({ url: "https://phish.example/tesco" });
    await expect(
      runAilliumLogin({ sessionKey: "s", credential: "Tesco", passwordRef: "e2" }, d),
    ).rejects.toThrow(/not for this site/);
    expect(d.act).not.toHaveBeenCalled();
  });

  it("never types the password into a field that is not a password box", async () => {
    const d = deps({ fieldType: "text" });
    await expect(
      runAilliumLogin({ sessionKey: "s", credential: "Tesco", passwordRef: "e9" }, d),
    ).rejects.toThrow(/not a password box/);
    expect(d.act).toHaveBeenCalledTimes(1);
  });

  it("keeps the password out of error messages", async () => {
    const d = deps({ actError: new Error(`fill failed for "${login.password}"`) });
    const error = await runAilliumLogin(
      { sessionKey: "s", credential: "Tesco", passwordRef: "e2" },
      d,
    ).catch((err: Error) => err);
    const message = error instanceof Error ? error.message : "";
    expect(message).not.toContain(login.password);
    expect(message).toContain("[hidden]");
  });
});

describe("fetchSavedLogin", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("asks Core with the runtime token and passes on Core's own error", async () => {
    vi.stubEnv("AILLIUM_CORE_URL", "http://core.test/");
    vi.stubEnv("AILLIUM_RUNTIME_TOKEN", "runtime-token");
    const fetchImpl = vi.fn(async () =>
      Response.json({ message: "No saved login called Tesco." }, { status: 404 }),
    );
    await expect(
      fetchSavedLogin({
        sessionKey: "s",
        credential: "Tesco",
        pageUrl: "https://tesco.com",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toThrow("No saved login called Tesco.");
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://core.test/master-agent/runtime/browser-logins/resolve");
    expect((init.headers as Record<string, string>)["x-aillium-runtime-token"]).toBe(
      "runtime-token",
    );
  });

  it("needs Core and a task session", async () => {
    vi.stubEnv("AILLIUM_CORE_URL", "");
    vi.stubEnv("AILLIUM_RUNTIME_TOKEN", "");
    vi.stubEnv("OPERATOR_RUNTIME_TOKEN", "");
    await expect(
      fetchSavedLogin({ credential: "x", pageUrl: "https://a.test", sessionKey: "s" }),
    ).rejects.toThrow(/not configured/);
  });
});

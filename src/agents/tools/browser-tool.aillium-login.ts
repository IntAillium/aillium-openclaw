import { resolveAilliumCoreConfig } from "../../aillium/boundary-runtime.js";

/**
 * Signs in with a login the owner saved in Aillium. The password goes from
 * Aillium Core straight into the page; it is never shown to the agent, put in
 * a tool result, or written to the action log.
 */

export type SavedLogin = {
  label: string;
  username: string;
  password: string;
  domains: string[];
};

/** True when the page's host is one of the login's sites (or a subdomain of one). */
export function hostAllowedForLogin(pageUrl: string, domains: string[]): boolean {
  let host: string;
  try {
    const url = new URL(pageUrl);
    if (url.protocol !== "https:") {
      return false;
    }
    host = url.hostname.toLowerCase();
  } catch {
    return false;
  }
  return domains
    .map((d) =>
      d
        .trim()
        .toLowerCase()
        .replace(/^https?:\/\//, "")
        .replace(/\/.*$/, "")
        .replace(/^\*\./, ""),
    )
    .filter(Boolean)
    .some((domain) => host === domain || host.endsWith(`.${domain}`));
}

export function maskUsername(username: string): string {
  const at = username.indexOf("@");
  if (at > 1) {
    return `${username.slice(0, 2)}…${username.slice(at)}`;
  }
  return username.length > 3 ? `${username.slice(0, 2)}…` : "…";
}

export async function fetchSavedLogin(params: {
  sessionKey?: string;
  credential: string;
  pageUrl: string;
  fetchImpl?: typeof fetch;
}): Promise<SavedLogin> {
  const config = resolveAilliumCoreConfig();
  if (!config) {
    throw new Error("Saved logins need Aillium Core, which is not configured here.");
  }
  if (!params.sessionKey) {
    throw new Error("Saved logins are only available inside an Aillium task.");
  }
  const res = await (params.fetchImpl ?? fetch)(
    `${config.baseUrl}/master-agent/runtime/browser-logins/resolve`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-aillium-runtime-token": config.syncToken,
      },
      body: JSON.stringify({
        sessionKey: params.sessionKey,
        credential: params.credential,
        pageUrl: params.pageUrl,
      }),
      signal: AbortSignal.timeout(config.timeoutMs ?? 10_000),
    },
  );
  if (!res.ok) {
    // Core's message says what to do (no such login, wrong site); it never holds the secret.
    let message = `Aillium could not provide that login (HTTP ${res.status}).`;
    try {
      const body = (await res.json()) as { message?: unknown };
      if (typeof body?.message === "string" && body.message.trim()) {
        message = body.message.trim();
      }
    } catch {
      // keep the generic message
    }
    throw new Error(message);
  }
  const body = (await res.json()) as Partial<SavedLogin>;
  if (
    typeof body.username !== "string" ||
    typeof body.password !== "string" ||
    !Array.isArray(body.domains)
  ) {
    throw new Error("Aillium returned an incomplete login.");
  }
  return {
    label: typeof body.label === "string" ? body.label : params.credential,
    username: body.username,
    password: body.password,
    domains: body.domains.filter((d): d is string => typeof d === "string"),
  };
}

const PASSWORD_FIELD_CHECK =
  "(el) => (el && el.tagName === 'INPUT' ? String(el.type || '').toLowerCase() : '')";

type LoginPage = { targetId?: string; url?: string };

export type AilliumLoginDeps = {
  /** Looks at the tab first, so the site check uses the page that is really open. */
  readPage: (targetId: string | undefined) => Promise<LoginPage>;
  act: (request: Record<string, unknown>) => Promise<unknown>;
  fetchLogin?: typeof fetchSavedLogin;
};

/**
 * Types a saved login into the page. Only the login's name and a masked username
 * come back to the agent; the password stays inside this function.
 */
export async function runAilliumLogin(
  params: {
    sessionKey?: string;
    credential?: string;
    usernameRef?: string;
    passwordRef?: string;
    submitRef?: string;
    targetId?: string;
  },
  deps: AilliumLoginDeps,
): Promise<{ ok: true; login: string; username: string; site: string; submitted: boolean }> {
  const credential = params.credential?.trim();
  if (!credential) {
    throw new Error('login needs credential="<name of the saved login>".');
  }
  if (!params.passwordRef?.trim()) {
    throw new Error("login needs passwordRef (the password field's ref from a snapshot).");
  }
  const page = await deps.readPage(params.targetId);
  const pageUrl = page.url ?? "";
  if (!pageUrl) {
    throw new Error("Could not tell which site is open. Take a snapshot, then try again.");
  }
  const login = await (deps.fetchLogin ?? fetchSavedLogin)({
    sessionKey: params.sessionKey,
    credential,
    pageUrl,
  });
  // Core checks the site too; this second check keeps a password off the wrong page
  // even if the tab changed while the login was being fetched.
  if (!hostAllowedForLogin(pageUrl, login.domains)) {
    throw new Error(
      `The saved login "${login.label}" is not for this site (${safeHost(pageUrl)}). Open the right site first.`,
    );
  }
  const targetId = params.targetId ?? page.targetId;
  const base = targetId ? { targetId } : {};
  // The password only goes into a real password box, never a search or message field
  // where the page (or the agent) could read it back.
  const fieldType = await deps
    .act({ ...base, kind: "evaluate", ref: params.passwordRef, fn: PASSWORD_FIELD_CHECK })
    .then((res) => (res as { result?: unknown } | undefined)?.result)
    .catch(() => undefined);
  if (fieldType !== "password") {
    throw new Error(
      "passwordRef is not a password box. Take a fresh snapshot and pass the password field's ref.",
    );
  }
  try {
    if (params.usernameRef?.trim()) {
      await deps.act({ ...base, kind: "type", ref: params.usernameRef, text: login.username });
    }
    await deps.act({ ...base, kind: "type", ref: params.passwordRef, text: login.password });
    if (params.submitRef?.trim()) {
      await deps.act({ ...base, kind: "click", ref: params.submitRef });
    }
  } catch (err) {
    // Browser errors can echo the typed text back, so never pass them on as they are.
    const reason = err instanceof Error ? err.message : String(err);
    // The original error is left off on purpose: it may hold the typed password.
    // oxlint-disable-next-line preserve-caught-error
    throw new Error(
      `Signing in failed while filling the form: ${redact(reason, [login.password, login.username])}`,
    );
  }
  return {
    ok: true,
    login: login.label,
    username: maskUsername(login.username),
    site: safeHost(pageUrl),
    submitted: Boolean(params.submitRef?.trim()),
  };
}

function safeHost(pageUrl: string): string {
  try {
    return new URL(pageUrl).hostname;
  } catch {
    return "this page";
  }
}

function redact(text: string, secrets: string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret) {
      out = out.split(secret).join("[hidden]");
    }
  }
  return out;
}

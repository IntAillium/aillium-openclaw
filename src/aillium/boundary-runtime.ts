/**
 * Composition root for the Aillium integration boundary.
 *
 * The adapters in ./contracts, ./defaults, and ./live-boundary describe *how*
 * the operator runtime talks to Aillium Core, but until this module existed
 * nothing instantiated them — the live/default factories were exported and
 * never called, so runtime evidence and continuity signals never reached the
 * control plane. This module is the single place that:
 *   - resolves Aillium Core connection settings from the environment,
 *   - builds the live boundary when configured (falling back to no-op defaults),
 *   - exposes best-effort helpers that composition seams (gateway startup,
 *     agent bootstrap) call to forward runtime signals to Aillium Core.
 *
 * Keep enterprise concerns (tenancy, policy, approvals) in Aillium Core. This
 * boundary only forwards runtime signals; it never owns control-plane state.
 */

import { hostname } from "node:os";
import type { AilliumIntegrationBoundary, JsonValue, TenantSessionMetadata } from "./contracts.js";
import { createDefaultAilliumBoundary } from "./defaults.js";
import { type AilliumCoreConnectionConfig, createLiveAilliumBoundary } from "./live-boundary.js";

/** Capabilities this operator runtime advertises to Aillium Core on sync. */
const DEFAULT_RUNTIME_CAPABILITIES: readonly string[] = Object.freeze([
  "agent-runtime",
  "browser-control",
  "gateway",
  "hooks",
  "context-engine",
  "channels",
]);

export interface OperatorRuntimeSyncOptions {
  /**
   * Tenant this runtime belongs to. Required for registration (Core binds the
   * runtime to the tenant's enabled master-agent profile). Falls back to
   * AILLIUM_TENANT_ID.
   */
  tenantId?: string;
  /**
   * Existing session key to reactivate instead of creating a new session.
   * Falls back to AILLIUM_RUNTIME_SESSION_KEY / AILLIUM_RUNTIME_ID env vars.
   */
  runtimeSessionKey?: string;
  runtimeVersion?: string;
  capabilities?: readonly string[];
  metadata?: Record<string, JsonValue>;
  log?: { info: (msg: string) => void; warn: (msg: string) => void };
}

function trimmedEnv(name: string): string | undefined {
  const trimmed = process.env[name]?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Resolve Aillium Core connection settings from the environment.
 *
 * Returns null when Core integration is not configured (offline / local dev),
 * in which case the runtime uses no-op default adapters. The sync token must
 * match one of Core's accepted runtime tokens (MASTER_AGENT_RUNTIME_SYNC_TOKEN,
 * AILLIUM_MASTER_RUNTIME_SYNC_TOKEN, or OPERATOR_RUNTIME_TOKEN).
 */
export function resolveAilliumCoreConfig(): AilliumCoreConnectionConfig | null {
  const baseUrl = trimmedEnv("AILLIUM_CORE_URL");
  const syncToken = trimmedEnv("AILLIUM_RUNTIME_TOKEN") ?? trimmedEnv("OPERATOR_RUNTIME_TOKEN");
  if (!baseUrl || !syncToken) {
    return null;
  }
  const timeoutMs = Number(trimmedEnv("AILLIUM_RUNTIME_TIMEOUT_MS"));
  return {
    baseUrl: baseUrl.replace(/\/+$/, ""),
    syncToken,
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : undefined,
  };
}

export function isAilliumCoreConfigured(): boolean {
  return resolveAilliumCoreConfig() !== null;
}

let cachedBoundary: AilliumIntegrationBoundary | null = null;

/**
 * Returns the process-wide Aillium boundary (live when Core is configured,
 * no-op defaults otherwise). Cached after first resolution.
 */
export function getAilliumBoundary(): AilliumIntegrationBoundary {
  if (cachedBoundary) {
    return cachedBoundary;
  }
  const config = resolveAilliumCoreConfig();
  cachedBoundary = config ? createLiveAilliumBoundary(config) : createDefaultAilliumBoundary();
  return cachedBoundary;
}

/** Test-only: clear the cached boundary so env changes take effect. */
export function resetAilliumBoundary(): void {
  cachedBoundary = null;
}

/**
 * Resolve the runtime session key that binds this operator runtime to an
 * Aillium Core master-agent session. Only meaningful when an operator has bound
 * the runtime to a Core session; Core's operator-sync endpoint syncs an
 * existing session and has nothing to update without it.
 */
export function resolveRuntimeSessionKey(explicit?: string): string | undefined {
  return (
    explicit?.trim() ||
    trimmedEnv("AILLIUM_RUNTIME_SESSION_KEY") ||
    trimmedEnv("AILLIUM_RUNTIME_ID")
  );
}

/** Resolve the tenant this runtime registers under (AILLIUM_TENANT_ID). */
export function resolveTenantId(explicit?: string): string | undefined {
  return explicit?.trim() || trimmedEnv("AILLIUM_TENANT_ID");
}

/**
 * Resolve the Aillium agent identity this runtime acts as (AILLIUM_AGENT_ID),
 * used to fetch the agent's Staff Room context for system-prompt injection.
 */
export function resolveAgentId(explicit?: string): string | undefined {
  return explicit?.trim() || trimmedEnv("AILLIUM_AGENT_ID");
}

/**
 * Best-effort: register this operator runtime with Aillium Core.
 *
 * Calls Core's runtime register endpoint, which binds the runtime to the
 * tenant's enabled master-agent profile and returns a session key that
 * subsequent operator-sync calls reuse. No-op (returns false) unless Aillium
 * Core is configured AND a tenant id (or an existing session key to reactivate)
 * is available. Never throws; failures are logged and swallowed so a Core
 * outage cannot block gateway startup or agent execution.
 */
export async function registerOperatorRuntimeBestEffort(
  options: OperatorRuntimeSyncOptions = {},
): Promise<boolean> {
  if (!isAilliumCoreConfigured()) {
    return false;
  }
  const tenantId = resolveTenantId(options.tenantId);
  const runtimeSessionKey = resolveRuntimeSessionKey(options.runtimeSessionKey);
  if (!tenantId && !runtimeSessionKey) {
    options.log?.info(
      "aillium: Core is configured but neither AILLIUM_TENANT_ID nor a runtime session key is set; " +
        "skipping runtime registration",
    );
    return false;
  }

  const runtimeVersion =
    options.runtimeVersion?.trim() || trimmedEnv("OPENCLAW_VERSION") || "unknown";
  try {
    const result = await getAilliumBoundary().runtimeRegistration.register({
      runtimeId: runtimeSessionKey ?? `openclaw-gateway-${hostname()}`,
      runtimeVersion,
      capabilities: options.capabilities ?? DEFAULT_RUNTIME_CAPABILITIES,
      metadata: {
        ...(tenantId ? { tenantId } : {}),
        ...(runtimeSessionKey ? { runtimeSessionKey } : {}),
        host: hostname(),
        ...options.metadata,
      },
    });
    if (result.registered) {
      options.log?.info(
        `aillium: operator runtime registered with Aillium Core (session ${result.externalRuntimeRef ?? "unknown"})`,
      );
    } else {
      options.log?.warn(
        `aillium: runtime registration not accepted: ${result.message ?? "unknown"}`,
      );
    }
    return result.registered;
  } catch (err) {
    options.log?.warn(`aillium: runtime registration failed: ${String(err)}`);
    return false;
  }
}

/**
 * Best-effort Staff Room context fetch for an agent, suitable for injection into
 * an agent's system prompt at session bootstrap. Returns an empty string when
 * Core is not configured or the Staff Room is unavailable.
 */
export async function fetchStaffRoomAgentContext(
  agentId: string,
  metadata?: TenantSessionMetadata,
): Promise<string> {
  const staffRoom = getAilliumBoundary().staffRoom;
  if (!staffRoom) {
    return "";
  }
  return staffRoom.getAgentContext(agentId, metadata);
}

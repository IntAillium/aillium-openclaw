/**
 * Live Aillium integration boundary adapters.
 *
 * These replace the noop defaults when an Aillium Operator Runtime instance is
 * connected to an Aillium Core control plane. They forward runtime
 * registration, evidence events, and contract mapping through HTTP
 * to the Aillium Core API.
 */

import type {
  AilliumIntegrationBoundary,
  CapsuleLifecycleEvent,
  CapsuleLifecycleHook,
  ContextLifecycleEvent,
  ContextLifecycleHook,
  ContractAdapter,
  EvidenceCallbackHook,
  JsonValue,
  RuntimeRegistrationAdapter,
  RuntimeRegistrationInput,
  RuntimeRegistrationResult,
  StaffRoomContextProvider,
  StaffRoomRetrievalResult,
  TenantSessionMetadata,
  TenantSessionMetadataAdapter,
} from "./contracts.js";

export interface AilliumCoreConnectionConfig {
  /** Base URL for Aillium Core API (e.g. https://api.aillium.example/api) */
  baseUrl: string;
  /** Authentication token for runtime sync endpoints */
  syncToken: string;
  /** Optional timeout in milliseconds (default 15000) */
  timeoutMs?: number;
}

class LiveRuntimeRegistrationAdapter implements RuntimeRegistrationAdapter {
  constructor(private readonly config: AilliumCoreConnectionConfig) {}

  async register(input: RuntimeRegistrationInput): Promise<RuntimeRegistrationResult> {
    const metadata = (input.metadata as Record<string, unknown> | undefined) ?? {};
    const tenantId = typeof metadata.tenantId === "string" ? metadata.tenantId : undefined;
    const runtimeSessionKey =
      typeof metadata.runtimeSessionKey === "string" ? metadata.runtimeSessionKey : undefined;
    try {
      const response = await fetch(`${this.config.baseUrl}/master-agent/runtime/register`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-aillium-runtime-token": this.config.syncToken,
        },
        body: JSON.stringify({
          tenant_id: tenantId,
          runtime_id: input.runtimeId,
          runtime_session_key: runtimeSessionKey,
          runtime_version: input.runtimeVersion,
          capabilities: input.capabilities,
          metadata,
        }),
        signal: AbortSignal.timeout(this.config.timeoutMs ?? 15_000),
      });

      if (!response.ok) {
        const text = await response.text().catch(() => "");
        return {
          registered: false,
          message: `Aillium Core returned ${response.status}: ${text.slice(0, 200)}`,
        };
      }

      const result = (await response.json()) as Record<string, unknown>;
      return {
        registered: true,
        externalRuntimeRef:
          (result.runtime_session_key as string) ?? (result.session_id as string) ?? undefined,
        message: "Registered with Aillium Core",
      };
    } catch (err: unknown) {
      return {
        registered: false,
        message: `Registration failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }
}

class LiveContractAdapter implements ContractAdapter {
  async toExternalContract(
    input: JsonValue,
    _metadata?: TenantSessionMetadata,
  ): Promise<JsonValue> {
    // Pass-through: Aillium Core's task-bus already handles contract normalization.
    // This adapter exists for future contract versioning needs.
    return input;
  }

  async fromExternalContract(
    input: JsonValue,
    _metadata?: TenantSessionMetadata,
  ): Promise<JsonValue> {
    return input;
  }
}

class LiveEvidenceCallbackHook implements EvidenceCallbackHook {
  constructor(private readonly config: AilliumCoreConnectionConfig) {}

  async onEvidence(
    eventName: string,
    payload: JsonValue,
    metadata?: TenantSessionMetadata,
  ): Promise<void> {
    const sessionKey = metadata?.runtimeSessionKey as string | undefined;
    if (!sessionKey) {
      return;
    }

    try {
      await fetch(`${this.config.baseUrl}/master-agent/runtime/operator-sync`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-aillium-runtime-token": this.config.syncToken,
        },
        body: JSON.stringify({
          runtime_session_key: sessionKey,
          artifacts: [
            {
              uri: `evidence://${eventName}/${Date.now()}`,
              kind: eventName,
              metadata: {
                ...(typeof payload === "object" && payload !== null && !Array.isArray(payload)
                  ? (payload as Record<string, unknown>)
                  : { value: payload }),
                evidenceEmittedAt: new Date().toISOString(),
              },
            },
          ],
        }),
        signal: AbortSignal.timeout(this.config.timeoutMs ?? 15_000),
      });
    } catch (err) {
      // Best-effort evidence delivery; do not block runtime execution
      console.warn(
        `[aillium-boundary] onEvidence failed:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
}

class LiveTenantSessionMetadataAdapter implements TenantSessionMetadataAdapter {
  async project(metadata: TenantSessionMetadata): Promise<TenantSessionMetadata> {
    // Preserve all metadata — Aillium Core uses tenantId from its own session lookup,
    // not from runtime metadata, so no stripping needed.
    return metadata;
  }
}

class LiveContextLifecycleHook implements ContextLifecycleHook {
  constructor(private readonly config: AilliumCoreConnectionConfig) {}

  async onContextLifecycle(event: ContextLifecycleEvent): Promise<void> {
    try {
      await fetch(`${this.config.baseUrl}/master-agent/runtime/context-lifecycle`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-aillium-runtime-token": this.config.syncToken,
        },
        body: JSON.stringify({
          runtime_session_key: event.sessionKey,
          runtime_session_id: event.sessionId,
          event_kind: event.kind,
          payload: event.payload,
        }),
        signal: AbortSignal.timeout(this.config.timeoutMs ?? 15_000),
      });
    } catch (err) {
      // Best-effort lifecycle delivery; do not block runtime execution
      console.warn(
        `[aillium-boundary] onContextLifecycle failed:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
}

class LiveCapsuleLifecycleHook implements CapsuleLifecycleHook {
  constructor(private readonly config: AilliumCoreConnectionConfig) {}

  async onCapsuleLifecycle(event: CapsuleLifecycleEvent): Promise<void> {
    try {
      await fetch(`${this.config.baseUrl}/execution-capsules/runtime/lifecycle`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-aillium-runtime-token": this.config.syncToken,
        },
        body: JSON.stringify({
          capsule_id: event.capsuleId,
          session_key: event.sessionKey,
          event_kind: event.kind,
          payload: event.payload,
        }),
        signal: AbortSignal.timeout(this.config.timeoutMs ?? 15_000),
      });
    } catch (err) {
      // Best-effort capsule lifecycle delivery; do not block runtime execution
      console.warn(
        `[aillium-boundary] onCapsuleLifecycle failed:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
}

class LiveStaffRoomContextProvider implements StaffRoomContextProvider {
  constructor(private readonly config: AilliumCoreConnectionConfig) {}

  async getAgentContext(agentId: string, _metadata?: TenantSessionMetadata): Promise<string> {
    try {
      const response = await fetch(`${this.config.baseUrl}/staff-room/agent-context/${agentId}`, {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
          "x-aillium-runtime-token": this.config.syncToken,
        },
        signal: AbortSignal.timeout(this.config.timeoutMs ?? 15_000),
      });

      if (!response.ok) {
        return "";
      }

      const result = (await response.json()) as { context?: string };
      return result.context ?? "";
    } catch (err) {
      // Staff Room context retrieval is best-effort; do not block agent startup
      console.warn(
        `[aillium-boundary] getAgentContext failed:`,
        err instanceof Error ? err.message : String(err),
      );
      return "";
    }
  }

  async retrieveMemory(params: {
    agentId?: string;
    departmentId?: string;
    query?: string;
    maxResults?: number;
    metadata?: TenantSessionMetadata;
  }): Promise<StaffRoomRetrievalResult> {
    try {
      const qs = new URLSearchParams();
      if (params.agentId) {
        qs.set("agent_id", params.agentId);
      }
      if (params.departmentId) {
        qs.set("department_id", params.departmentId);
      }
      if (params.query) {
        qs.set("query", params.query);
      }
      if (params.maxResults) {
        qs.set("max_results", String(params.maxResults));
      }
      const queryString = qs.toString();

      const response = await fetch(
        `${this.config.baseUrl}/staff-room/retrieve${queryString ? `?${queryString}` : ""}`,
        {
          method: "GET",
          headers: {
            "Content-Type": "application/json",
            "x-aillium-runtime-token": this.config.syncToken,
          },
          signal: AbortSignal.timeout(this.config.timeoutMs ?? 15_000),
        },
      );

      if (!response.ok) {
        return { results: [], total_count: 0, agent_context: null };
      }

      return (await response.json()) as StaffRoomRetrievalResult;
    } catch (err) {
      // Best-effort retrieval; return empty results on failure
      console.warn(
        `[aillium-boundary] retrieveMemory failed:`,
        err instanceof Error ? err.message : String(err),
      );
      return { results: [], total_count: 0, agent_context: null };
    }
  }
}

export function createLiveAilliumBoundary(
  config: AilliumCoreConnectionConfig,
): AilliumIntegrationBoundary {
  return {
    runtimeRegistration: new LiveRuntimeRegistrationAdapter(config),
    contractAdapter: new LiveContractAdapter(),
    evidenceHooks: [new LiveEvidenceCallbackHook(config)],
    tenantSessionMetadata: new LiveTenantSessionMetadataAdapter(),
    contextLifecycle: new LiveContextLifecycleHook(config),
    capsuleLifecycle: new LiveCapsuleLifecycleHook(config),
    staffRoom: new LiveStaffRoomContextProvider(config),
  };
}

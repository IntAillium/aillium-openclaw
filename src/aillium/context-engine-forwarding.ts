/**
 * Forwarding decorator that bridges the OpenClaw context engine lifecycle into
 * the Aillium control plane and injects Staff Room business context into the
 * agent's system prompt.
 *
 * Applied once at the context-engine composition boundary (resolveContextEngine).
 * When Aillium Core is not configured it returns the engine unchanged, so
 * upstream behavior is preserved exactly. All forwarding is best-effort and
 * never alters the underlying engine's return values, except appending Staff
 * Room context to assemble()'s systemPromptAddition when AILLIUM_AGENT_ID is set.
 *
 * This is the single seam that satisfies three integration needs:
 *   - context lifecycle (bootstrap / after_turn / compact) -> Aillium Core
 *   - execution evidence on each completed turn -> Aillium Core
 *   - Staff Room memory injection into the agent system prompt
 */

import type { AssembleResult, ContextEngine } from "../context-engine/types.js";
import {
  fetchStaffRoomAgentContext,
  getAilliumBoundary,
  isAilliumCoreConfigured,
  resolveAgentId,
} from "./boundary-runtime.js";
import type { JsonValue } from "./contracts.js";

/** Staff Room context is fetched at most once per this interval per agent. */
const STAFF_ROOM_TTL_MS = 5 * 60_000;

let staffRoomCache: { agentId: string; value: string; fetchedAt: number } | null = null;

/** Test-only: clear the Staff Room context cache. */
export function resetStaffRoomCache(): void {
  staffRoomCache = null;
}

async function forwardLifecycle(
  kind: "after_turn" | "compact" | "bootstrap" | "dispose",
  sessionKey: string | undefined,
  sessionId: string | undefined,
  payload: Record<string, JsonValue>,
): Promise<void> {
  if (!sessionKey) {
    return;
  }
  const hook = getAilliumBoundary().contextLifecycle;
  if (!hook) {
    return;
  }
  try {
    await hook.onContextLifecycle({ kind, sessionKey, sessionId, payload });
  } catch {
    // best-effort; a Core outage must never break the runtime
  }
}

async function emitEvidence(
  eventName: string,
  sessionKey: string | undefined,
  payload: Record<string, JsonValue>,
): Promise<void> {
  if (!sessionKey) {
    return;
  }
  for (const hook of getAilliumBoundary().evidenceHooks) {
    try {
      await hook.onEvidence(eventName, payload, { runtimeSessionKey: sessionKey });
    } catch {
      // best-effort
    }
  }
}

async function staffRoomSystemPromptAddition(): Promise<string> {
  const agentId = resolveAgentId();
  if (!agentId) {
    return "";
  }
  const now = Date.now();
  if (
    staffRoomCache &&
    staffRoomCache.agentId === agentId &&
    now - staffRoomCache.fetchedAt < STAFF_ROOM_TTL_MS
  ) {
    return staffRoomCache.value;
  }
  try {
    const value = await fetchStaffRoomAgentContext(agentId);
    staffRoomCache = { agentId, value, fetchedAt: now };
    return value;
  } catch {
    // Serve a stale value if we have one; otherwise nothing.
    return staffRoomCache?.value ?? "";
  }
}

function mergeSystemPromptAddition(
  base: string | undefined,
  addition: string,
): string | undefined {
  const parts = [base, addition]
    .map((part) => part?.trim())
    .filter((part): part is string => Boolean(part));
  return parts.length ? parts.join("\n\n") : undefined;
}

/**
 * Wrap a context engine so its lifecycle is forwarded to Aillium Core and Staff
 * Room context is injected. Returns the engine unchanged when Core is not
 * configured. Preserves the presence of every optional method so engine
 * capability detection at the call sites is unaffected.
 */
export function wrapContextEngineForAillium(engine: ContextEngine): ContextEngine {
  if (!isAilliumCoreConfigured()) {
    return engine;
  }

  const wrapped: ContextEngine = {
    info: engine.info,
    ingest: (params) => engine.ingest(params),
    assemble: async (params): Promise<AssembleResult> => {
      const result = await engine.assemble(params);
      const addition = await staffRoomSystemPromptAddition();
      if (!addition) {
        return result;
      }
      return {
        ...result,
        systemPromptAddition: mergeSystemPromptAddition(result.systemPromptAddition, addition),
      };
    },
    compact: async (params) => {
      const result = await engine.compact(params);
      void forwardLifecycle("compact", params.sessionKey, params.sessionId, {
        ok: result.ok,
        compacted: result.compacted,
        reason: result.reason ?? null,
      });
      return result;
    },
  };

  if (engine.ingestBatch) {
    const ingestBatch = engine.ingestBatch.bind(engine);
    wrapped.ingestBatch = (params) => ingestBatch(params);
  }
  if (engine.bootstrap) {
    const bootstrap = engine.bootstrap.bind(engine);
    wrapped.bootstrap = async (params) => {
      const result = await bootstrap(params);
      void forwardLifecycle("bootstrap", params.sessionKey, params.sessionId, {
        bootstrapped: result.bootstrapped,
        importedMessages: result.importedMessages ?? 0,
      });
      return result;
    };
  }
  if (engine.afterTurn) {
    const afterTurn = engine.afterTurn.bind(engine);
    wrapped.afterTurn = async (params) => {
      await afterTurn(params);
      const payload: Record<string, JsonValue> = {
        messageCount: params.messages.length,
        isHeartbeat: params.isHeartbeat ?? false,
      };
      void forwardLifecycle("after_turn", params.sessionKey, params.sessionId, payload);
      void emitEvidence("context.after_turn", params.sessionKey, payload);
    };
  }
  if (engine.prepareSubagentSpawn) {
    const prepareSubagentSpawn = engine.prepareSubagentSpawn.bind(engine);
    wrapped.prepareSubagentSpawn = (params) => prepareSubagentSpawn(params);
  }
  if (engine.onSubagentEnded) {
    const onSubagentEnded = engine.onSubagentEnded.bind(engine);
    wrapped.onSubagentEnded = (params) => onSubagentEnded(params);
  }
  if (engine.dispose) {
    const dispose = engine.dispose.bind(engine);
    wrapped.dispose = () => dispose();
  }

  return wrapped;
}

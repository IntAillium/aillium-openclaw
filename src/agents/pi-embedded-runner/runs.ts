import {
  diagnosticLogger as diag,
  logMessageQueued,
  logSessionStateChange,
} from "../../logging/diagnostic.js";
import { getProcessSupervisor } from "../../process/supervisor/index.js";
import type { ProcessCancellationResult } from "../../process/supervisor/index.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";

type EmbeddedPiQueueHandle = {
  runId?: string;
  processScopeKey?: string;
  queueMessage: (text: string) => Promise<void>;
  isStreaming: () => boolean;
  isCompacting: () => boolean;
  abort: () => void;
};

export type ActiveEmbeddedRunSnapshot = {
  transcriptLeafId: string | null;
  messages?: unknown[];
  inFlightPrompt?: string;
};

type EmbeddedRunWaiter = {
  resolve: (ended: boolean) => void;
  timer: NodeJS.Timeout;
};

/**
 * Use global singleton state so busy/streaming checks stay consistent even
 * when the bundler emits multiple copies of this module into separate chunks.
 */
const EMBEDDED_RUN_STATE_KEY = Symbol.for("openclaw.embeddedRunState");

const embeddedRunState = resolveGlobalSingleton(EMBEDDED_RUN_STATE_KEY, () => ({
  activeRuns: new Map<string, EmbeddedPiQueueHandle>(),
  activeRunsByRunId: new Map<
    string,
    { sessionId: string; sessionKey?: string; handle: EmbeddedPiQueueHandle }
  >(),
  snapshots: new Map<string, ActiveEmbeddedRunSnapshot>(),
  waiters: new Map<string, Set<EmbeddedRunWaiter>>(),
}));
const ACTIVE_EMBEDDED_RUNS = embeddedRunState.activeRuns;
const ACTIVE_EMBEDDED_RUNS_BY_RUN_ID = embeddedRunState.activeRunsByRunId;
const ACTIVE_EMBEDDED_RUN_SNAPSHOTS = embeddedRunState.snapshots;
const EMBEDDED_RUN_WAITERS = embeddedRunState.waiters;

export function queueEmbeddedPiMessage(sessionId: string, text: string): boolean {
  const handle = ACTIVE_EMBEDDED_RUNS.get(sessionId);
  if (!handle) {
    diag.debug(`queue message failed: sessionId=${sessionId} reason=no_active_run`);
    return false;
  }
  if (!handle.isStreaming()) {
    diag.debug(`queue message failed: sessionId=${sessionId} reason=not_streaming`);
    return false;
  }
  if (handle.isCompacting()) {
    diag.debug(`queue message failed: sessionId=${sessionId} reason=compacting`);
    return false;
  }
  logMessageQueued({ sessionId, source: "pi-embedded-runner" });
  void handle.queueMessage(text);
  return true;
}

/**
 * Abort embedded PI runs.
 *
 * - With a sessionId, aborts that single run.
 * - With no sessionId, supports targeted abort modes (for example, compacting runs only).
 */
export function abortEmbeddedPiRun(sessionId: string): boolean;
export function abortEmbeddedPiRun(
  sessionId: undefined,
  opts: { mode: "all" | "compacting" },
): boolean;
export function abortEmbeddedPiRun(
  sessionId?: string,
  opts?: { mode?: "all" | "compacting" },
): boolean {
  if (typeof sessionId === "string" && sessionId.length > 0) {
    const handle = ACTIVE_EMBEDDED_RUNS.get(sessionId);
    if (!handle) {
      diag.debug(`abort failed: sessionId=${sessionId} reason=no_active_run`);
      return false;
    }
    diag.debug(`aborting run: sessionId=${sessionId}`);
    try {
      handle.abort();
    } catch (err) {
      diag.warn(`abort failed: sessionId=${sessionId} err=${String(err)}`);
      return false;
    }
    return true;
  }

  const mode = opts?.mode;
  if (mode === "compacting") {
    let aborted = false;
    for (const [id, handle] of ACTIVE_EMBEDDED_RUNS) {
      if (!handle.isCompacting()) {
        continue;
      }
      diag.debug(`aborting compacting run: sessionId=${id}`);
      try {
        handle.abort();
        aborted = true;
      } catch (err) {
        diag.warn(`abort failed: sessionId=${id} err=${String(err)}`);
      }
    }
    return aborted;
  }

  if (mode === "all") {
    let aborted = false;
    for (const [id, handle] of ACTIVE_EMBEDDED_RUNS) {
      diag.debug(`aborting run: sessionId=${id}`);
      try {
        handle.abort();
        aborted = true;
      } catch (err) {
        diag.warn(`abort failed: sessionId=${id} err=${String(err)}`);
      }
    }
    return aborted;
  }

  return false;
}

export function isEmbeddedPiRunActive(sessionId: string): boolean {
  const active = ACTIVE_EMBEDDED_RUNS.has(sessionId);
  if (active) {
    diag.debug(`run active check: sessionId=${sessionId} active=true`);
  }
  return active;
}

export function isEmbeddedPiRunStreaming(sessionId: string): boolean {
  const handle = ACTIVE_EMBEDDED_RUNS.get(sessionId);
  if (!handle) {
    return false;
  }
  return handle.isStreaming();
}

export function getActiveEmbeddedRunCount(): number {
  return ACTIVE_EMBEDDED_RUNS.size;
}

export function isEmbeddedPiRunActiveByRunId(runId: string, expectedSessionKey?: string): boolean {
  const active = ACTIVE_EMBEDDED_RUNS_BY_RUN_ID.get(runId.trim());
  return Boolean(active && (!expectedSessionKey || active.sessionKey === expectedSessionKey));
}

export type EmbeddedRunCancellationResult = {
  runId: string;
  sessionId?: string;
  sessionKey?: string;
  acknowledged: boolean;
  cooperativeAbortRequested: boolean;
  runDrained: boolean;
  processTeardown: ProcessCancellationResult;
  teardownComplete: boolean;
  deadlineMs: number;
  elapsedMs: number;
};

export function embeddedRunProcessScopeKey(runId: string): string {
  return `run:${runId.trim()}`;
}

/**
 * Abort one embedded run and wait for its model/tool wrapper and owned process
 * scope to drain. The result is explicit so the control plane can distinguish
 * an accepted request from completed teardown.
 */
export async function abortEmbeddedPiRunByRunId(
  runId: string,
  opts?: { deadlineMs?: number; expectedSessionKey?: string; forceProcessTeardown?: boolean },
): Promise<EmbeddedRunCancellationResult> {
  const normalizedRunId = runId.trim();
  const startedAt = Date.now();
  const deadlineMs = Math.max(1, Math.min(5_000, Math.floor(opts?.deadlineMs ?? 5_000)));
  const expectedSessionKey = opts?.expectedSessionKey;
  const candidate = ACTIVE_EMBEDDED_RUNS_BY_RUN_ID.get(normalizedRunId);
  const active =
    !expectedSessionKey || candidate?.sessionKey === expectedSessionKey ? candidate : undefined;
  if (!active) {
    const durableTeardown = expectedSessionKey
      ? await getProcessSupervisor().consumeVerifiedTeardownReceipt(
          embeddedRunProcessScopeKey(normalizedRunId),
          expectedSessionKey,
        )
      : undefined;
    if (durableTeardown?.teardownComplete) {
      return {
        runId: normalizedRunId,
        sessionKey: expectedSessionKey,
        acknowledged: true,
        cooperativeAbortRequested: false,
        runDrained: true,
        processTeardown: durableTeardown,
        teardownComplete: true,
        deadlineMs,
        elapsedMs: Date.now() - startedAt,
      };
    }
    return {
      runId: normalizedRunId,
      acknowledged: false,
      cooperativeAbortRequested: false,
      runDrained: false,
      processTeardown: {
        requested: false,
        matchedRunIds: [],
        terminatedRunIds: [],
        remainingRunIds: [],
        deadlineMs,
        elapsedMs: Date.now() - startedAt,
        teardownComplete: false,
      },
      teardownComplete: false,
      deadlineMs,
      elapsedMs: Date.now() - startedAt,
    };
  }
  let cooperativeAbortRequested = false;
  if (active) {
    try {
      active.handle.abort();
      cooperativeAbortRequested = true;
    } catch (err) {
      diag.warn(`abort failed: runId=${normalizedRunId} err=${String(err)}`);
    }
  }

  const elapsedBeforeProcessMs = Date.now() - startedAt;
  const processTeardown = await getProcessSupervisor().cancelScopeAndWait(
    active?.handle.processScopeKey ?? embeddedRunProcessScopeKey(normalizedRunId),
    {
      reason: "manual-cancel",
      deadlineMs: Math.max(1, deadlineMs - elapsedBeforeProcessMs),
      force: opts?.forceProcessTeardown === true,
    },
  );

  while (
    ACTIVE_EMBEDDED_RUNS_BY_RUN_ID.has(normalizedRunId) &&
    Date.now() - startedAt < deadlineMs
  ) {
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  const runDrained = !ACTIVE_EMBEDDED_RUNS_BY_RUN_ID.has(normalizedRunId);
  return {
    runId: normalizedRunId,
    sessionId: active?.sessionId,
    sessionKey: active?.sessionKey,
    acknowledged: Boolean(active) || processTeardown.requested,
    cooperativeAbortRequested,
    runDrained,
    processTeardown,
    teardownComplete: runDrained && processTeardown.teardownComplete,
    deadlineMs,
    elapsedMs: Date.now() - startedAt,
  };
}

export function getActiveEmbeddedRunSnapshot(
  sessionId: string,
): ActiveEmbeddedRunSnapshot | undefined {
  return ACTIVE_EMBEDDED_RUN_SNAPSHOTS.get(sessionId);
}

/**
 * Wait for active embedded runs to drain.
 *
 * Used during restarts so in-flight compaction runs can release session write
 * locks before the next lifecycle starts.
 */
export async function waitForActiveEmbeddedRuns(
  timeoutMs = 15_000,
  opts?: { pollMs?: number },
): Promise<{ drained: boolean }> {
  const pollMsRaw = opts?.pollMs ?? 250;
  const pollMs = Math.max(10, Math.floor(pollMsRaw));
  const maxWaitMs = Math.max(pollMs, Math.floor(timeoutMs));

  const startedAt = Date.now();
  while (true) {
    if (ACTIVE_EMBEDDED_RUNS.size === 0) {
      return { drained: true };
    }
    const elapsedMs = Date.now() - startedAt;
    if (elapsedMs >= maxWaitMs) {
      diag.warn(
        `wait for active embedded runs timed out: activeRuns=${ACTIVE_EMBEDDED_RUNS.size} timeoutMs=${maxWaitMs}`,
      );
      return { drained: false };
    }
    await new Promise<void>((resolve) => setTimeout(resolve, pollMs));
  }
}

export function waitForEmbeddedPiRunEnd(sessionId: string, timeoutMs = 15_000): Promise<boolean> {
  if (!sessionId || !ACTIVE_EMBEDDED_RUNS.has(sessionId)) {
    return Promise.resolve(true);
  }
  diag.debug(`waiting for run end: sessionId=${sessionId} timeoutMs=${timeoutMs}`);
  return new Promise((resolve) => {
    const waiters = EMBEDDED_RUN_WAITERS.get(sessionId) ?? new Set();
    const waiter: EmbeddedRunWaiter = {
      resolve,
      timer: setTimeout(
        () => {
          waiters.delete(waiter);
          if (waiters.size === 0) {
            EMBEDDED_RUN_WAITERS.delete(sessionId);
          }
          diag.warn(`wait timeout: sessionId=${sessionId} timeoutMs=${timeoutMs}`);
          resolve(false);
        },
        Math.max(100, timeoutMs),
      ),
    };
    waiters.add(waiter);
    EMBEDDED_RUN_WAITERS.set(sessionId, waiters);
    if (!ACTIVE_EMBEDDED_RUNS.has(sessionId)) {
      waiters.delete(waiter);
      if (waiters.size === 0) {
        EMBEDDED_RUN_WAITERS.delete(sessionId);
      }
      clearTimeout(waiter.timer);
      resolve(true);
    }
  });
}

function notifyEmbeddedRunEnded(sessionId: string) {
  const waiters = EMBEDDED_RUN_WAITERS.get(sessionId);
  if (!waiters || waiters.size === 0) {
    return;
  }
  EMBEDDED_RUN_WAITERS.delete(sessionId);
  diag.debug(`notifying waiters: sessionId=${sessionId} waiterCount=${waiters.size}`);
  for (const waiter of waiters) {
    clearTimeout(waiter.timer);
    waiter.resolve(true);
  }
}

export function setActiveEmbeddedRun(
  sessionId: string,
  handle: EmbeddedPiQueueHandle,
  sessionKey?: string,
) {
  const previousHandle = ACTIVE_EMBEDDED_RUNS.get(sessionId);
  const wasActive = Boolean(previousHandle);
  if (previousHandle && previousHandle !== handle) {
    const previousRunId = previousHandle.runId?.trim() || sessionId;
    if (ACTIVE_EMBEDDED_RUNS_BY_RUN_ID.get(previousRunId)?.handle === previousHandle) {
      ACTIVE_EMBEDDED_RUNS_BY_RUN_ID.delete(previousRunId);
    }
  }
  ACTIVE_EMBEDDED_RUNS.set(sessionId, handle);
  ACTIVE_EMBEDDED_RUNS_BY_RUN_ID.set(handle.runId?.trim() || sessionId, {
    sessionId,
    sessionKey,
    handle,
  });
  logSessionStateChange({
    sessionId,
    sessionKey,
    state: "processing",
    reason: wasActive ? "run_replaced" : "run_started",
  });
  if (!sessionId.startsWith("probe-")) {
    diag.debug(`run registered: sessionId=${sessionId} totalActive=${ACTIVE_EMBEDDED_RUNS.size}`);
  }
}

export function updateActiveEmbeddedRunSnapshot(
  sessionId: string,
  snapshot: ActiveEmbeddedRunSnapshot,
) {
  if (!ACTIVE_EMBEDDED_RUNS.has(sessionId)) {
    return;
  }
  ACTIVE_EMBEDDED_RUN_SNAPSHOTS.set(sessionId, snapshot);
}

export function clearActiveEmbeddedRun(
  sessionId: string,
  handle: EmbeddedPiQueueHandle,
  sessionKey?: string,
) {
  const handleRunId = handle.runId?.trim() || sessionId;
  if (ACTIVE_EMBEDDED_RUNS_BY_RUN_ID.get(handleRunId)?.handle === handle) {
    ACTIVE_EMBEDDED_RUNS_BY_RUN_ID.delete(handleRunId);
  }
  if (ACTIVE_EMBEDDED_RUNS.get(sessionId) === handle) {
    ACTIVE_EMBEDDED_RUNS.delete(sessionId);
    ACTIVE_EMBEDDED_RUN_SNAPSHOTS.delete(sessionId);
    logSessionStateChange({ sessionId, sessionKey, state: "idle", reason: "run_completed" });
    if (!sessionId.startsWith("probe-")) {
      diag.debug(`run cleared: sessionId=${sessionId} totalActive=${ACTIVE_EMBEDDED_RUNS.size}`);
    }
    notifyEmbeddedRunEnded(sessionId);
  } else {
    diag.debug(`run clear skipped: sessionId=${sessionId} reason=handle_mismatch`);
  }
}

export const __testing = {
  resetActiveEmbeddedRuns() {
    for (const waiters of EMBEDDED_RUN_WAITERS.values()) {
      for (const waiter of waiters) {
        clearTimeout(waiter.timer);
        waiter.resolve(true);
      }
    }
    EMBEDDED_RUN_WAITERS.clear();
    ACTIVE_EMBEDDED_RUNS.clear();
    ACTIVE_EMBEDDED_RUNS_BY_RUN_ID.clear();
    ACTIVE_EMBEDDED_RUN_SNAPSHOTS.clear();
  },
};

export type { EmbeddedPiQueueHandle };

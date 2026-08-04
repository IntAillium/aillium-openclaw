import crypto from "node:crypto";
import { getShellConfig } from "../../agents/shell-utils.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { isProcessTreeAlive } from "../kill-tree.js";
import { createChildAdapter } from "./adapters/child.js";
import { createPtyAdapter } from "./adapters/pty.js";
import {
  reconcileOwnedProcessJournalDetailed,
  reconcileWindowsOwnedProcessJournalDetailed,
  SUPERVISOR_OWNER_ENV,
  SUPERVISOR_RUN_ENV,
  type OwnedProcessJournalEntry,
  writeOwnedProcessJournal,
} from "./orphan-journal.js";
import { createRunRegistry } from "./registry.js";
import {
  appendVerifiedTeardownReceipts,
  consumeVerifiedTeardownReceipts,
} from "./teardown-receipts.js";
import type {
  ManagedRun,
  ProcessCancellationResult,
  ProcessSupervisor,
  RunExit,
  RunRecord,
  SpawnInput,
  TerminationReason,
} from "./types.js";
import {
  windowsProcessOwnerUnavailableError,
  type WindowsOwnedProcess,
  type WindowsProcessOwner,
} from "./windows-process-owner.js";

const log = createSubsystemLogger("process/supervisor");

type ActiveRun = {
  run: ManagedRun;
  scopeKey?: string;
  forceCancel: (reason: TerminationReason) => void;
  isAlive: () => boolean;
  windowsOwnedProcess?: WindowsOwnedProcess;
};

const DEFAULT_CANCEL_DEADLINE_MS = 5_000;
const COOPERATIVE_CANCEL_GRACE_MS = 1_000;

function clampTimeout(value?: number): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return Math.max(1, Math.floor(value));
}

function isTimeoutReason(reason: TerminationReason) {
  return reason === "overall-timeout" || reason === "no-output-timeout";
}

export function createProcessSupervisor(options?: {
  journalPath?: string;
  orphanMarkerVerifier?: (entry: OwnedProcessJournalEntry) => Promise<boolean>;
  journalWriter?: typeof writeOwnedProcessJournal;
  teardownReceiptPath?: string;
  teardownReceiptKeyPath?: string;
  platform?: NodeJS.Platform;
  windowsProcessOwner?: WindowsProcessOwner;
}): ProcessSupervisor {
  const registry = createRunRegistry();
  const active = new Map<string, ActiveRun>();
  const ownerId: string = crypto.randomUUID();
  const platform = options?.platform ?? process.platform;
  const windowsProcessOwner = options?.windowsProcessOwner;
  const journalPath = options?.journalPath;
  const journalWriter = options?.journalWriter ?? writeOwnedProcessJournal;
  const teardownReceiptPath =
    options?.teardownReceiptPath ??
    (journalPath ? `${journalPath}.teardown-receipts.json` : undefined);
  const teardownReceiptKeyPath =
    options?.teardownReceiptKeyPath ??
    (journalPath ? `${journalPath}.teardown-receipts.key` : undefined);
  let orphanResiduals: OwnedProcessJournalEntry[] = [];
  const startupOperation = journalPath
    ? (platform === "win32"
        ? reconcileWindowsOwnedProcessJournalDetailed(journalPath, windowsProcessOwner, 1_500)
        : reconcileOwnedProcessJournalDetailed(journalPath, 1_500, options?.orphanMarkerVerifier)
      ).then(async ({ residuals, unverified, verifiedTerminated }) => {
        orphanResiduals = residuals;
        if (teardownReceiptPath && teardownReceiptKeyPath) {
          const blockedCorrelations = new Set(
            [...residuals, ...unverified].flatMap((entry) =>
              entry.sessionId && entry.scopeKey ? [`${entry.sessionId}\0${entry.scopeKey}`] : [],
            ),
          );
          await appendVerifiedTeardownReceipts({
            receiptPath: teardownReceiptPath,
            keyPath: teardownReceiptKeyPath,
            invalidateEntries: [...residuals, ...unverified, ...verifiedTerminated],
            entries: verifiedTerminated.filter(
              (entry) =>
                entry.sessionId &&
                entry.scopeKey &&
                !blockedCorrelations.has(`${entry.sessionId}\0${entry.scopeKey}`),
            ),
          });
        }
      })
    : Promise.resolve();
  const startupSweep = startupOperation;
  // The serialization tail must always recover. Individual callers still see
  // their own write failure, but one rejected write cannot poison every later
  // persistence attempt.
  let journalWrite = startupOperation.catch(() => undefined);
  let receiptOperation = startupOperation.catch(() => undefined);
  const correlationLocks = new Map<string, Promise<void>>();
  const consumedTeardownCorrelations = new Set<string>();

  const acquireCorrelationLock = async (sessionId: string, scopeKey?: string) => {
    const normalizedSessionId = sessionId.trim();
    const normalizedScopeKey = scopeKey?.trim();
    if (!normalizedSessionId || !normalizedScopeKey) {
      return () => {};
    }
    const key = `${normalizedSessionId}\0${normalizedScopeKey}`;
    const previous = correlationLocks.get(key) ?? Promise.resolve();
    let releaseCurrent: (() => void) | undefined;
    const current = new Promise<void>((resolve) => {
      releaseCurrent = resolve;
    });
    correlationLocks.set(key, current);
    await previous;
    return () => {
      releaseCurrent?.();
      if (correlationLocks.get(key) === current) {
        correlationLocks.delete(key);
      }
    };
  };

  const persistJournal = async () => {
    if (!journalPath) {
      return;
    }
    journalWrite = journalWrite.then(() => {
      const current = Array.from(active.entries()).flatMap<OwnedProcessJournalEntry>(
        ([runId, entry]) => {
          const record = registry.get(runId);
          return record?.pid
            ? [
                {
                  ownerId,
                  runId,
                  pid: record.pid,
                  sessionId: record.sessionId,
                  scopeKey: entry.scopeKey,
                  startedAtMs: record.startedAtMs,
                  windowsJobIdentity: entry.windowsOwnedProcess?.identity,
                },
              ]
            : [];
        },
      );
      return journalWriter(journalPath, [...orphanResiduals, ...current]);
    });
    const operation = journalWrite;
    journalWrite = operation.catch((err) => {
      log.warn(`process ownership journal write failed: ${String(err)}`);
    });
    await operation;
  };

  const cancel = (runId: string, reason: TerminationReason = "manual-cancel", force = false) => {
    const current = active.get(runId);
    if (!current) {
      return;
    }
    registry.updateState(runId, "exiting", {
      terminationReason: reason,
    });
    if (force) {
      current.forceCancel(reason);
    } else {
      current.run.cancel(reason);
    }
  };

  const cancelScope = (scopeKey: string, reason: TerminationReason = "manual-cancel") => {
    if (!scopeKey.trim()) {
      return;
    }
    for (const [runId, run] of active.entries()) {
      if (run.scopeKey !== scopeKey) {
        continue;
      }
      cancel(runId, reason);
    }
  };

  const cancelScopeAndWait = async (
    scopeKey: string,
    opts?: { reason?: TerminationReason; deadlineMs?: number; force?: boolean },
  ): Promise<ProcessCancellationResult> => {
    const normalizedScope = scopeKey.trim();
    const startedAt = Date.now();
    const deadlineMs = Math.max(
      1,
      Math.min(
        DEFAULT_CANCEL_DEADLINE_MS,
        Math.floor(opts?.deadlineMs ?? DEFAULT_CANCEL_DEADLINE_MS),
      ),
    );
    const matchedRuns = normalizedScope
      ? Array.from(active.entries())
          .filter(([, run]) => run.scopeKey === normalizedScope)
          .map(([runId, run]) => ({ runId, isAlive: run.isAlive }))
      : [];
    const matchedRunIds = matchedRuns.map(({ runId }) => runId);
    for (const runId of matchedRunIds) {
      cancel(runId, opts?.reason ?? "manual-cancel", opts?.force === true);
    }

    const deadlineAt = startedAt + deadlineMs;
    while (Date.now() < deadlineAt) {
      const remainingRunIds = matchedRuns
        .filter(({ runId, isAlive }) => active.has(runId) || isAlive())
        .map(({ runId }) => runId);
      if (remainingRunIds.length === 0) {
        return {
          requested: matchedRunIds.length > 0,
          matchedRunIds,
          terminatedRunIds: [...matchedRunIds],
          remainingRunIds: [],
          deadlineMs,
          elapsedMs: Date.now() - startedAt,
          teardownComplete: true,
        };
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }

    const remainingRunIds = matchedRuns
      .filter(({ runId, isAlive }) => active.has(runId) || isAlive())
      .map(({ runId }) => runId);
    return {
      requested: matchedRunIds.length > 0,
      matchedRunIds,
      terminatedRunIds: matchedRunIds.filter((runId) => !active.has(runId)),
      remainingRunIds,
      deadlineMs,
      elapsedMs: Date.now() - startedAt,
      teardownComplete: remainingRunIds.length === 0,
    };
  };

  const consumeVerifiedTeardownReceipt = async (
    scopeKey: string,
    sessionId: string,
  ): Promise<ProcessCancellationResult | undefined> => {
    if (!teardownReceiptPath || !teardownReceiptKeyPath) {
      return undefined;
    }
    try {
      await startupSweep;
    } catch {
      // Never consume an older receipt when current journal reconciliation did
      // not complete; ownership for this runtime is still ambiguous.
      return undefined;
    }
    const normalizedScopeKey = scopeKey.trim();
    const normalizedSessionId = sessionId.trim();
    const releaseCorrelation = await acquireCorrelationLock(
      normalizedSessionId,
      normalizedScopeKey,
    );
    const startedAt = Date.now();
    try {
      const hasAmbiguousOwnership =
        orphanResiduals.some(
          (entry) =>
            entry.scopeKey === normalizedScopeKey && entry.sessionId === normalizedSessionId,
        ) ||
        registry
          .listByScope(normalizedScopeKey)
          .some((record) => record.sessionId === normalizedSessionId && record.state !== "exited");
      if (hasAmbiguousOwnership) {
        return undefined;
      }
      const operation = receiptOperation.then(async () => {
        const receipts = await consumeVerifiedTeardownReceipts({
          receiptPath: teardownReceiptPath,
          keyPath: teardownReceiptKeyPath,
          sessionId: normalizedSessionId,
          scopeKey: normalizedScopeKey,
        });
        if (receipts.length === 0) {
          return undefined;
        }
        consumedTeardownCorrelations.add(`${normalizedSessionId}\0${normalizedScopeKey}`);
        const runIds = receipts.map((receipt) => receipt.runId);
        return {
          requested: true,
          matchedRunIds: runIds,
          terminatedRunIds: runIds,
          remainingRunIds: [],
          deadlineMs: 0,
          elapsedMs: Date.now() - startedAt,
          teardownComplete: true,
        } satisfies ProcessCancellationResult;
      });
      receiptOperation = operation.then(
        () => undefined,
        () => undefined,
      );
      return await operation;
    } finally {
      releaseCorrelation();
    }
  };

  const spawn = async (input: SpawnInput): Promise<ManagedRun> => {
    await startupSweep;
    const runId = input.runId?.trim() || crypto.randomUUID();
    if (input.replaceExistingScope && input.scopeKey?.trim()) {
      cancelScope(input.scopeKey, "manual-cancel");
    }
    const releaseCorrelation = await acquireCorrelationLock(input.sessionId, input.scopeKey);
    const spawnCorrelation = input.scopeKey?.trim()
      ? `${input.sessionId.trim()}\0${input.scopeKey.trim()}`
      : undefined;
    if (spawnCorrelation && consumedTeardownCorrelations.has(spawnCorrelation)) {
      releaseCorrelation();
      throw new Error("cannot spawn work for a correlation with consumed teardown proof");
    }
    const startedAtMs = Date.now();
    const record: RunRecord = {
      runId,
      sessionId: input.sessionId,
      backendId: input.backendId,
      scopeKey: input.scopeKey?.trim() || undefined,
      state: "starting",
      startedAtMs,
      lastOutputAtMs: startedAtMs,
      createdAtMs: startedAtMs,
      updatedAtMs: startedAtMs,
    };
    registry.add(record);

    let forcedReason: TerminationReason | null = null;
    let settled = false;
    let terminalExit: RunExit | undefined;
    let windowsTeardownComplete = false;
    let windowsTeardownAttempt: Promise<boolean> | undefined;
    let windowsOwnedProcess: WindowsOwnedProcess | undefined;
    let stdout = "";
    let stderr = "";
    let timeoutTimer: NodeJS.Timeout | null = null;
    let noOutputTimer: NodeJS.Timeout | null = null;
    const captureOutput = input.captureOutput !== false;

    const overallTimeoutMs = clampTimeout(input.timeoutMs);
    const noOutputTimeoutMs = clampTimeout(input.noOutputTimeoutMs);

    const setForcedReason = (reason: TerminationReason) => {
      if (forcedReason) {
        return;
      }
      forcedReason = reason;
      registry.updateState(runId, "exiting", { terminationReason: reason });
    };

    let cancelAdapter: ((reason: TerminationReason) => void) | null = null;
    let forceCancelTimer: NodeJS.Timeout | null = null;
    let resolveForceCancel: (() => void) | null = null;
    let forceKillAdapter: (() => void) | null = null;
    const forceCancelState: { promise: Promise<void> | null } = { promise: null };

    const clearTimers = () => {
      if (timeoutTimer) {
        clearTimeout(timeoutTimer);
        timeoutTimer = null;
      }
      if (noOutputTimer) {
        clearTimeout(noOutputTimer);
        noOutputTimer = null;
      }
      if (forceCancelTimer) {
        clearTimeout(forceCancelTimer);
        forceCancelTimer = null;
      }
    };

    let cleanupSpawnedAdapter: (() => Promise<boolean>) | undefined;

    const requestCancel = (reason: TerminationReason) => {
      setForcedReason(reason);
      cancelAdapter?.(reason);
    };

    const requestForceCancel = (reason: TerminationReason) => {
      setForcedReason(reason);
      if (settled && (!windowsOwnedProcess || windowsTeardownComplete)) {
        return;
      }
      if (forceCancelTimer) {
        clearTimeout(forceCancelTimer);
        forceCancelTimer = null;
        resolveForceCancel?.();
        resolveForceCancel = null;
      }
      forceKillAdapter?.();
    };

    const touchOutput = () => {
      registry.touchOutput(runId);
      if (!noOutputTimeoutMs || settled) {
        return;
      }
      if (noOutputTimer) {
        clearTimeout(noOutputTimer);
      }
      noOutputTimer = setTimeout(() => {
        requestCancel("no-output-timeout");
      }, noOutputTimeoutMs);
    };

    try {
      // Preflight the journal before starting an external process. This catches
      // persistent permission/disk failures without creating work that cannot be
      // durably owned. Keep it inside the spawn transaction so the registry record
      // is finalized through the same failure path.
      await persistJournal();
      if (input.mode === "child" && input.argv.length === 0) {
        throw new Error("spawn argv cannot be empty");
      }
      const spawnEnv = {
        ...(input.env ?? process.env),
        [SUPERVISOR_OWNER_ENV]: ownerId,
        [SUPERVISOR_RUN_ENV]: runId,
      };
      const adapter =
        platform === "win32"
          ? await (async () => {
              if (!windowsProcessOwner) {
                throw windowsProcessOwnerUnavailableError();
              }
              windowsOwnedProcess = await windowsProcessOwner.launch({
                ownerId,
                runId,
                run: input,
                env: spawnEnv,
              });
              return windowsOwnedProcess.adapter;
            })()
          : input.mode === "pty"
            ? await (async () => {
                const { shell, args: shellArgs } = getShellConfig();
                const ptyCommand = input.ptyCommand.trim();
                if (!ptyCommand) {
                  throw new Error("PTY command cannot be empty");
                }
                return await createPtyAdapter({
                  shell,
                  args: [...shellArgs, ptyCommand],
                  cwd: input.cwd,
                  env: spawnEnv,
                });
              })()
            : await createChildAdapter({
                argv: input.argv,
                cwd: input.cwd,
                env: spawnEnv,
                windowsVerbatimArguments: input.windowsVerbatimArguments,
                input: input.input,
                stdinMode: input.stdinMode,
              });
      const retryWindowsFinalTeardown = async (exitCode: number): Promise<boolean> => {
        if (!windowsOwnedProcess) {
          return false;
        }
        if (windowsTeardownComplete) {
          return true;
        }
        if (windowsTeardownAttempt) {
          return await windowsTeardownAttempt;
        }
        const ownedProcess = windowsOwnedProcess;
        windowsTeardownAttempt = (async () => {
          try {
            await ownedProcess.terminate(exitCode);
          } catch (error) {
            log.warn(`Windows Job Object termination failed: runId=${runId} ${String(error)}`);
            return false;
          }
          let teardownVerified = false;
          try {
            teardownVerified = await ownedProcess.waitForEmpty(DEFAULT_CANCEL_DEADLINE_MS);
          } catch (error) {
            log.warn(`Windows Job Object empty wait failed: runId=${runId} ${String(error)}`);
            return false;
          }
          if (!teardownVerified) {
            log.warn(`Windows Job Object remained non-empty: runId=${runId}`);
            return false;
          }
          try {
            await ownedProcess.close();
          } catch (error) {
            log.warn(`Windows Job Object close failed: runId=${runId} ${String(error)}`);
            return false;
          }
          windowsTeardownComplete = true;
          active.delete(runId);
          adapter.dispose();
          if (terminalExit) {
            registry.finalize(runId, {
              reason: terminalExit.reason,
              exitCode: terminalExit.exitCode,
              exitSignal: terminalExit.exitSignal,
            });
          }
          try {
            await persistJournal();
          } catch (error) {
            log.warn(
              `Windows teardown journal cleanup deferred: runId=${runId} reason=${String(error)}`,
            );
          }
          return true;
        })();
        try {
          return await windowsTeardownAttempt;
        } finally {
          windowsTeardownAttempt = undefined;
        }
      };
      forceKillAdapter = () => {
        if (windowsOwnedProcess) {
          const operation = settled
            ? retryWindowsFinalTeardown(1)
            : windowsOwnedProcess.terminate(1).then(
                () => true,
                (error) => {
                  log.warn(
                    `Windows Job Object force termination failed: runId=${runId} ${String(error)}`,
                  );
                  return false;
                },
              );
          void operation.catch((error) => {
            log.warn(`Windows Job Object force retry failed: runId=${runId} ${String(error)}`);
          });
          return;
        }
        adapter.kill("SIGKILL");
      };
      cleanupSpawnedAdapter = async () => {
        settled = true;
        clearTimers();
        if (windowsOwnedProcess) {
          return await retryWindowsFinalTeardown(1);
        }
        adapter.kill("SIGKILL");
        const pid = adapter.pid;
        const deadlineAt = Date.now() + DEFAULT_CANCEL_DEADLINE_MS;
        while (platform !== "win32" && pid && isProcessTreeAlive(pid) && Date.now() < deadlineAt) {
          await new Promise<void>((resolve) => setTimeout(resolve, 10));
        }
        const teardownVerified = platform !== "win32" && (!pid || !isProcessTreeAlive(pid));
        if (teardownVerified) {
          active.delete(runId);
          adapter.dispose();
        }
        return teardownVerified;
      };

      registry.updateState(runId, "running", { pid: adapter.pid });

      cancelAdapter = (reason: TerminationReason) => {
        if (settled && (!windowsOwnedProcess || windowsTeardownComplete)) {
          return;
        }
        if (isTimeoutReason(reason)) {
          // Preserve hard execution-budget semantics. A timeout is already the
          // end of the allowed cooperative window, so force the tree now.
          if (windowsOwnedProcess) {
            const operation = settled
              ? retryWindowsFinalTeardown(1)
              : windowsOwnedProcess.terminate(1).then(
                  () => true,
                  (error) => {
                    log.warn(
                      `Windows Job Object timeout termination failed: runId=${runId} ${String(error)}`,
                    );
                    return false;
                  },
                );
            void operation.catch((error) => {
              log.warn(`Windows Job Object timeout retry failed: runId=${runId} ${String(error)}`);
            });
          } else {
            adapter.kill("SIGKILL");
          }
          return;
        }
        if (windowsOwnedProcess) {
          const operation = settled
            ? retryWindowsFinalTeardown(1)
            : windowsOwnedProcess.terminate(1).then(
                () => true,
                (error) => {
                  log.warn(
                    `Windows Job Object cooperative termination failed: runId=${runId} ${String(error)}`,
                  );
                  return false;
                },
              );
          void operation.catch((error) => {
            log.warn(
              `Windows Job Object cooperative retry failed: runId=${runId} ${String(error)}`,
            );
          });
          return;
        }
        // Give the command and its children a short cooperative shutdown window,
        // then force the tracked process tree well before the five-second run deadline.
        adapter.kill("SIGTERM");
        if (!forceCancelTimer) {
          forceCancelState.promise = new Promise<void>((resolve) => {
            resolveForceCancel = resolve;
          });
          forceCancelTimer = setTimeout(() => {
            // Force the original process group even if its leader exited after
            // SIGTERM; descendants may otherwise survive as orphaned work.
            adapter.kill("SIGKILL");
            forceCancelTimer = null;
            resolveForceCancel?.();
            resolveForceCancel = null;
          }, COOPERATIVE_CANCEL_GRACE_MS);
          forceCancelTimer.unref?.();
        }
      };

      if (overallTimeoutMs) {
        timeoutTimer = setTimeout(() => {
          requestCancel("overall-timeout");
        }, overallTimeoutMs);
      }
      if (noOutputTimeoutMs) {
        noOutputTimer = setTimeout(() => {
          requestCancel("no-output-timeout");
        }, noOutputTimeoutMs);
      }

      adapter.onStdout((chunk) => {
        if (captureOutput) {
          stdout += chunk;
        }
        input.onStdout?.(chunk);
        touchOutput();
      });
      adapter.onStderr((chunk) => {
        if (captureOutput) {
          stderr += chunk;
        }
        input.onStderr?.(chunk);
        touchOutput();
      });

      const waitPromise = (async (): Promise<RunExit> => {
        const result = await adapter.wait();
        if (forcedReason && forceCancelState.promise) {
          await forceCancelState.promise;
        }
        if (settled) {
          return {
            reason: forcedReason ?? "exit",
            exitCode: result.code,
            exitSignal: result.signal,
            durationMs: Date.now() - startedAtMs,
            stdout,
            stderr,
            timedOut: isTimeoutReason(forcedReason ?? "exit"),
            noOutputTimedOut: forcedReason === "no-output-timeout",
          };
        }
        settled = true;
        clearTimers();
        const reason: TerminationReason =
          forcedReason ?? (result.signal != null ? ("signal" as const) : ("exit" as const));
        const exit: RunExit = {
          reason,
          exitCode: result.code,
          exitSignal: result.signal,
          durationMs: Date.now() - startedAtMs,
          stdout,
          stderr,
          timedOut: isTimeoutReason(forcedReason ?? reason),
          noOutputTimedOut: forcedReason === "no-output-timeout",
        };
        terminalExit = exit;
        if (windowsOwnedProcess) {
          if (!(await retryWindowsFinalTeardown(0))) {
            throw new Error(`Windows Job Object teardown remains unverified: runId=${runId}`);
          }
          return exit;
        }
        adapter.dispose();
        active.delete(runId);
        try {
          await persistJournal();
        } catch (err) {
          // The process is already OS-terminal. Keep the stale ownership marker
          // for startup reconciliation and allow later writes to retry.
          log.warn(`run exit journal cleanup deferred: runId=${runId} reason=${String(err)}`);
        }
        registry.finalize(runId, {
          reason: exit.reason,
          exitCode: exit.exitCode,
          exitSignal: exit.exitSignal,
        });
        return exit;
      })().catch(async (err) => {
        // A leader can fail/exit while descendants remain in its process group.
        // Honour the scheduled force pass before releasing run ownership so a
        // successful cancellation acknowledgement still means the tree is down.
        if (forcedReason && forceCancelState.promise) {
          await forceCancelState.promise;
        }
        if (!settled) {
          settled = true;
          clearTimers();
          active.delete(runId);
          try {
            await persistJournal();
          } catch (journalErr) {
            log.warn(
              `spawn-error journal cleanup deferred: runId=${runId} reason=${String(journalErr)}`,
            );
          }
          adapter.dispose();
          registry.finalize(runId, {
            reason: "spawn-error",
            exitCode: null,
            exitSignal: null,
          });
        }
        throw err;
      });

      const managedRun: ManagedRun = {
        runId,
        pid: adapter.pid,
        startedAtMs,
        stdin: adapter.stdin,
        wait: async () => await waitPromise,
        cancel: (reason = "manual-cancel") => {
          requestCancel(reason);
        },
      };

      active.set(runId, {
        run: managedRun,
        scopeKey: input.scopeKey?.trim() || undefined,
        forceCancel: requestForceCancel,
        isAlive: () =>
          platform === "win32"
            ? !settled
            : adapter.pid
              ? isProcessTreeAlive(adapter.pid)
              : !settled,
        windowsOwnedProcess,
      });
      await persistJournal();
      releaseCorrelation();
      return managedRun;
    } catch (err) {
      if (cleanupSpawnedAdapter) {
        const teardownVerified = await cleanupSpawnedAdapter();
        try {
          await persistJournal();
        } catch (journalErr) {
          log.warn(
            `failed-spawn journal cleanup deferred: runId=${runId} reason=${String(journalErr)}`,
          );
        }
        if (!teardownVerified) {
          const cleanupError = new Error(
            `spawn failed and process-tree teardown could not be verified: runId=${runId}`,
            { cause: err },
          );
          log.error(cleanupError.message);
          releaseCorrelation();
          throw cleanupError;
        }
      }
      registry.finalize(runId, {
        reason: "spawn-error",
        exitCode: null,
        exitSignal: null,
      });
      log.warn(`spawn failed: runId=${runId} reason=${String(err)}`);
      releaseCorrelation();
      throw err;
    }
  };

  return {
    spawn,
    cancel,
    cancelScope,
    cancelScopeAndWait,
    consumeVerifiedTeardownReceipt,
    reconcileOrphans: async () => {
      await startupSweep;
    },
    getRecord: (runId: string) => registry.get(runId),
  };
}

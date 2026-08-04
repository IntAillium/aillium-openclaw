import type { SpawnInput, SpawnProcessAdapter } from "./types.js";

export type WindowsJobIdentity = {
  version: 1;
  jobName: string;
  ownerId: string;
  runId: string;
  rootPid: number;
  rootProcessCreationTime: string;
  killOnClose: true;
};

export type WindowsJobQuery = {
  jobName: string;
  memberPids: number[];
  activeProcessCount: number;
};

export type WindowsProcessIdentity = {
  pid: number;
  creationTime: string;
};

export type WindowsSuspendedProcess = {
  pid: number;
  creationTime: string;
  processHandle: string;
  primaryThreadHandle: string;
  adapter: SpawnProcessAdapter;
};

export type WindowsJobHandle = {
  handle: string;
  jobName: string;
};

export type WindowsNativeJobBridge = {
  createJob: (jobName: string) => Promise<WindowsJobHandle>;
  openJob: (jobName: string) => Promise<WindowsJobHandle | undefined>;
  setKillOnJobClose: (job: WindowsJobHandle) => Promise<void>;
  createProcessSuspended: (input: {
    run: SpawnInput;
    env: NodeJS.ProcessEnv;
  }) => Promise<WindowsSuspendedProcess>;
  assignProcess: (job: WindowsJobHandle, process: WindowsSuspendedProcess) => Promise<void>;
  resumePrimaryThread: (process: WindowsSuspendedProcess) => Promise<void>;
  queryJob: (job: WindowsJobHandle) => Promise<WindowsJobQuery>;
  queryProcessIdentity: (pid: number) => Promise<WindowsProcessIdentity | undefined>;
  terminateProcess: (process: WindowsSuspendedProcess, exitCode: number) => Promise<void>;
  terminateJob: (job: WindowsJobHandle, exitCode: number) => Promise<void>;
  waitForJobEmpty: (job: WindowsJobHandle, timeoutMs: number) => Promise<boolean>;
  closeProcessHandles: (process: WindowsSuspendedProcess) => Promise<void>;
  closeJob: (job: WindowsJobHandle) => Promise<void>;
};

export type WindowsRestartReconciliation =
  | "absent"
  | "terminated"
  | "identity_mismatch"
  | "unknown";

export type WindowsOwnedProcess = {
  adapter: SpawnProcessAdapter;
  identity: WindowsJobIdentity;
  query: () => Promise<WindowsJobQuery>;
  terminate: (exitCode?: number) => Promise<void>;
  waitForEmpty: (timeoutMs: number) => Promise<boolean>;
  close: () => Promise<void>;
};

export interface WindowsProcessOwner {
  launch(input: {
    ownerId: string;
    runId: string;
    run: SpawnInput;
    env: NodeJS.ProcessEnv;
  }): Promise<WindowsOwnedProcess>;
  reconcile(identity: WindowsJobIdentity, timeoutMs: number): Promise<WindowsRestartReconciliation>;
}

function encodeJobNamePart(value: string): string {
  return Buffer.from(value).toString("base64url").slice(0, 80);
}

export function buildWindowsJobName(ownerId: string, runId: string): string {
  return `Local\\AilliumOpenClaw-${encodeJobNamePart(ownerId)}-${encodeJobNamePart(runId)}`;
}

function exactRootIsMember(query: WindowsJobQuery, process: WindowsSuspendedProcess): boolean {
  return query.memberPids.includes(process.pid) && query.activeProcessCount > 0;
}

export function createWindowsProcessOwner(native: WindowsNativeJobBridge): WindowsProcessOwner {
  return {
    launch: async ({ ownerId, runId, run, env }) => {
      const jobName = buildWindowsJobName(ownerId, runId);
      const job = await native.createJob(jobName);
      let process: WindowsSuspendedProcess | undefined;
      let resumed = false;
      try {
        await native.setKillOnJobClose(job);
        process = await native.createProcessSuspended({ run, env });
        if (!Number.isInteger(process.pid) || process.pid <= 0 || !process.creationTime.trim()) {
          throw new Error("Windows native owner returned an invalid suspended-process identity");
        }
        await native.assignProcess(job, process);
        const membership = await native.queryJob(job);
        if (membership.jobName !== jobName || !exactRootIsMember(membership, process)) {
          throw new Error("Windows process was not verifiably assigned to its exact Job Object");
        }
        await native.resumePrimaryThread(process);
        resumed = true;
        const suspended = process;
        let closed = false;
        let closing: Promise<void> | undefined;
        const identity: WindowsJobIdentity = {
          version: 1,
          jobName,
          ownerId,
          runId,
          rootPid: suspended.pid,
          rootProcessCreationTime: suspended.creationTime,
          killOnClose: true,
        };
        return {
          adapter: suspended.adapter,
          identity,
          query: async () => await native.queryJob(job),
          terminate: async (exitCode = 1) => {
            await native.terminateJob(job, exitCode);
          },
          waitForEmpty: async (timeoutMs) =>
            await native.waitForJobEmpty(job, Math.max(1, Math.floor(timeoutMs))),
          close: async () => {
            if (closed) {
              return;
            }
            if (!closing) {
              closing = (async () => {
                await native.closeProcessHandles(suspended);
                await native.closeJob(job);
                closed = true;
              })();
            }
            try {
              await closing;
            } finally {
              closing = undefined;
            }
          },
        } satisfies WindowsOwnedProcess;
      } catch (error) {
        if (process) {
          try {
            await native.terminateProcess(process, 1);
          } catch {
            // Continue closing the Job Object; kill-on-close is the final containment boundary.
          }
          try {
            await native.closeProcessHandles(process);
          } catch {
            // Continue closing the Job Object.
          }
        }
        try {
          await native.terminateJob(job, 1);
        } catch {
          // Closing a configured Job Object still applies kill-on-close.
        }
        try {
          await native.closeJob(job);
        } catch {
          // Preserve the original launch failure.
        }
        if (resumed) {
          throw new Error("Windows owned process failed after resume and was force-closed", {
            cause: error,
          });
        }
        throw error;
      }
    },

    reconcile: async (identity, timeoutMs) => {
      if (
        identity.version !== 1 ||
        !identity.killOnClose ||
        identity.jobName !== buildWindowsJobName(identity.ownerId, identity.runId)
      ) {
        return "identity_mismatch";
      }
      const job = await native.openJob(identity.jobName);
      if (!job) {
        const process = await native.queryProcessIdentity(identity.rootPid);
        if (!process) {
          return "absent";
        }
        // A matching process without its durable Job Object cannot be safely
        // controlled after restart. A different creation time is PID reuse.
        return "identity_mismatch";
      }
      try {
        const [query, process] = await Promise.all([
          native.queryJob(job),
          native.queryProcessIdentity(identity.rootPid),
        ]);
        if (
          query.jobName !== identity.jobName ||
          !process ||
          process.creationTime !== identity.rootProcessCreationTime ||
          !query.memberPids.includes(identity.rootPid)
        ) {
          return "identity_mismatch";
        }
        await native.terminateJob(job, 1);
        return (await native.waitForJobEmpty(job, Math.max(1, Math.floor(timeoutMs))))
          ? "terminated"
          : "unknown";
      } catch {
        return "unknown";
      } finally {
        await native.closeJob(job).catch(() => undefined);
      }
    },
  };
}

export function windowsProcessOwnerUnavailableError(): Error {
  return new Error(
    "Windows process supervision requires the approved Aillium Job Object native bridge; unsafe unowned launch was refused",
  );
}

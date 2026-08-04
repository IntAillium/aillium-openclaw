import { describe, expect, it, vi } from "vitest";
import type { SpawnProcessAdapter } from "./types.js";
import {
  buildWindowsJobName,
  createWindowsProcessOwner,
  type WindowsNativeJobBridge,
  type WindowsSuspendedProcess,
} from "./windows-process-owner.js";

function adapter(): SpawnProcessAdapter {
  return {
    pid: 4242,
    onStdout: vi.fn(),
    onStderr: vi.fn(),
    wait: vi.fn(async () => ({ code: 0, signal: null })),
    kill: vi.fn(),
    dispose: vi.fn(),
  };
}

function fixture() {
  const events: string[] = [];
  const suspended: WindowsSuspendedProcess = {
    pid: 4242,
    creationTime: "133829712000000000",
    processHandle: "process-handle",
    primaryThreadHandle: "thread-handle",
    adapter: adapter(),
  };
  const job = {
    handle: "job-handle",
    jobName: buildWindowsJobName("owner-a", "run-a"),
  };
  const openJobMock = vi.fn<WindowsNativeJobBridge["openJob"]>(async () => job);
  const assignProcessMock = vi.fn(async () => {
    events.push("assign");
  });
  const queryProcessIdentityMock = vi.fn<WindowsNativeJobBridge["queryProcessIdentity"]>(
    async () => ({
      pid: 4242,
      creationTime: suspended.creationTime,
    }),
  );
  const terminateProcessMock = vi.fn(async () => {
    events.push("terminate-process");
  });
  const terminateJobMock = vi.fn(async () => {
    events.push("terminate-job");
  });
  const waitForJobEmptyMock = vi.fn(async () => {
    events.push("wait-empty");
    return true;
  });
  const native: WindowsNativeJobBridge = {
    createJob: vi.fn(async (jobName) => {
      events.push("create-job");
      return { ...job, jobName };
    }),
    openJob: openJobMock,
    setKillOnJobClose: vi.fn(async () => {
      events.push("set-kill-on-close");
    }),
    createProcessSuspended: vi.fn(async () => {
      events.push("create-suspended");
      return suspended;
    }),
    assignProcess: assignProcessMock,
    resumePrimaryThread: vi.fn(async () => {
      events.push("resume");
    }),
    queryJob: vi.fn(async () => {
      events.push("query-membership");
      return { jobName: job.jobName, memberPids: [4242], activeProcessCount: 1 };
    }),
    queryProcessIdentity: queryProcessIdentityMock,
    terminateProcess: terminateProcessMock,
    terminateJob: terminateJobMock,
    waitForJobEmpty: waitForJobEmptyMock,
    closeProcessHandles: vi.fn(async () => {
      events.push("close-process");
    }),
    closeJob: vi.fn(async () => {
      events.push("close-job");
    }),
  };
  return {
    events,
    job,
    native,
    suspended,
    openJobMock,
    assignProcessMock,
    queryProcessIdentityMock,
    terminateProcessMock,
    terminateJobMock,
    waitForJobEmptyMock,
  };
}

const run = {
  mode: "child" as const,
  argv: ["example.exe"],
  sessionId: "session-a",
  backendId: "test",
};

describe("WindowsProcessOwner", () => {
  it("assigns a suspended process to a kill-on-close job before resume", async () => {
    const { events, native } = fixture();
    const owner = createWindowsProcessOwner(native);
    const owned = await owner.launch({
      ownerId: "owner-a",
      runId: "run-a",
      run,
      env: {},
    });
    expect(events.slice(0, 6)).toEqual([
      "create-job",
      "set-kill-on-close",
      "create-suspended",
      "assign",
      "query-membership",
      "resume",
    ]);
    expect(owned.identity).toEqual({
      version: 1,
      jobName: buildWindowsJobName("owner-a", "run-a"),
      ownerId: "owner-a",
      runId: "run-a",
      rootPid: 4242,
      rootProcessCreationTime: "133829712000000000",
      killOnClose: true,
    });
    await expect(owned.query()).resolves.toMatchObject({ memberPids: [4242] });
    await owned.terminate();
    await expect(owned.waitForEmpty(500)).resolves.toBe(true);
    await owned.close();
  });

  it("never resumes and force-closes when assignment fails", async () => {
    const { events, native, assignProcessMock } = fixture();
    assignProcessMock.mockImplementationOnce(async () => {
      events.push("assign-failed");
      throw new Error("assign denied");
    });
    const owner = createWindowsProcessOwner(native);
    await expect(
      owner.launch({ ownerId: "owner-a", runId: "run-a", run, env: {} }),
    ).rejects.toThrow("assign denied");
    expect(events).not.toContain("resume");
    expect(events).toEqual([
      "create-job",
      "set-kill-on-close",
      "create-suspended",
      "assign-failed",
      "terminate-process",
      "close-process",
      "terminate-job",
      "close-job",
    ]);
  });

  it("reconciles an exact persisted job and waits for verified empty membership", async () => {
    const { native, terminateJobMock, waitForJobEmptyMock } = fixture();
    const owner = createWindowsProcessOwner(native);
    const identity = {
      version: 1 as const,
      jobName: buildWindowsJobName("owner-a", "run-a"),
      ownerId: "owner-a",
      runId: "run-a",
      rootPid: 4242,
      rootProcessCreationTime: "133829712000000000",
      killOnClose: true as const,
    };
    await expect(owner.reconcile(identity, 500)).resolves.toBe("terminated");
    expect(terminateJobMock).toHaveBeenCalledOnce();
    expect(waitForJobEmptyMock).toHaveBeenCalledWith(expect.anything(), 500);
  });

  it("fails closed on PID reuse and never terminates a mismatched process", async () => {
    const {
      native,
      openJobMock,
      queryProcessIdentityMock,
      terminateJobMock,
      terminateProcessMock,
    } = fixture();
    openJobMock.mockResolvedValueOnce(undefined);
    queryProcessIdentityMock.mockResolvedValueOnce({
      pid: 4242,
      creationTime: "different-process-creation-time",
    });
    const owner = createWindowsProcessOwner(native);
    await expect(
      owner.reconcile(
        {
          version: 1,
          jobName: buildWindowsJobName("owner-a", "run-a"),
          ownerId: "owner-a",
          runId: "run-a",
          rootPid: 4242,
          rootProcessCreationTime: "133829712000000000",
          killOnClose: true,
        },
        500,
      ),
    ).resolves.toBe("identity_mismatch");
    expect(terminateJobMock).not.toHaveBeenCalled();
    expect(terminateProcessMock).not.toHaveBeenCalled();
  });

  it("accepts an absent job only when the exact root process is also absent", async () => {
    const { native, openJobMock, queryProcessIdentityMock } = fixture();
    openJobMock.mockResolvedValueOnce(undefined);
    queryProcessIdentityMock.mockResolvedValueOnce(undefined);
    const owner = createWindowsProcessOwner(native);
    await expect(
      owner.reconcile(
        {
          version: 1,
          jobName: buildWindowsJobName("owner-a", "run-a"),
          ownerId: "owner-a",
          runId: "run-a",
          rootPid: 4242,
          rootProcessCreationTime: "133829712000000000",
          killOnClose: true,
        },
        500,
      ),
    ).resolves.toBe("absent");
  });

  it("keeps close retryable when native handle cleanup rejects", async () => {
    const { native } = fixture();
    const closeProcessHandles = vi.mocked(native.closeProcessHandles);
    closeProcessHandles.mockRejectedValueOnce(new Error("handle close rejected"));
    const owner = createWindowsProcessOwner(native);
    const owned = await owner.launch({
      ownerId: "owner-a",
      runId: "run-a",
      run,
      env: {},
    });

    await expect(owned.close()).rejects.toThrow("handle close rejected");
    await expect(owned.close()).resolves.toBeUndefined();
    expect(closeProcessHandles).toHaveBeenCalledTimes(2);
    expect(native.closeJob).toHaveBeenCalledOnce();
  });
});

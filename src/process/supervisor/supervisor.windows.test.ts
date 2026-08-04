import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { readOwnedProcessJournal } from "./orphan-journal.js";
import { createProcessSupervisor } from "./supervisor.js";
import { buildWindowsJobName, type WindowsProcessOwner } from "./windows-process-owner.js";

describe("process supervisor Windows owner integration", () => {
  it("refuses an unsafe native Windows launch when the Job Object bridge is unavailable", async () => {
    const supervisor = createProcessSupervisor({ platform: "win32" });
    await expect(
      supervisor.spawn({
        mode: "child",
        argv: ["unowned.exe"],
        sessionId: "session-a",
        backendId: "test",
        runId: "run-a",
      }),
    ).rejects.toThrow("unsafe unowned launch was refused");
  });

  it("routes Windows launches and teardown through the injected process owner", async () => {
    const terminate = vi.fn(async () => undefined);
    const waitForEmpty = vi.fn(async () => true);
    const close = vi.fn(async () => undefined);
    const launch = vi.fn(async ({ ownerId, runId }: { ownerId: string; runId: string }) => ({
      adapter: {
        pid: 4242,
        onStdout: vi.fn(),
        onStderr: vi.fn(),
        wait: vi.fn(async () => ({ code: 0, signal: null })),
        kill: vi.fn(),
        dispose: vi.fn(),
      },
      identity: {
        version: 1 as const,
        jobName: buildWindowsJobName(ownerId, runId),
        ownerId,
        runId,
        rootPid: 4242,
        rootProcessCreationTime: "133829712000000000",
        killOnClose: true as const,
      },
      query: vi.fn(async () => ({
        jobName: buildWindowsJobName(ownerId, runId),
        memberPids: [4242],
        activeProcessCount: 1,
      })),
      terminate,
      waitForEmpty,
      close,
    }));
    const owner: WindowsProcessOwner = {
      launch: launch as WindowsProcessOwner["launch"],
      reconcile: vi.fn(async () => "absent" as const),
    };
    const supervisor = createProcessSupervisor({ platform: "win32", windowsProcessOwner: owner });
    const run = await supervisor.spawn({
      mode: "child",
      argv: ["owned.exe"],
      sessionId: "session-a",
      backendId: "test",
      runId: "run-a",
    });
    await expect(run.wait()).resolves.toMatchObject({ reason: "exit", exitCode: 0 });
    expect(launch).toHaveBeenCalledOnce();
    expect(terminate).toHaveBeenCalledWith(0);
    expect(waitForEmpty).toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });

  it("persists the exact Windows run and Job Object identity while work is active", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-windows-supervisor-"));
    const journalPath = path.join(directory, "owned.json");
    let resolveWait: ((value: { code: number | null; signal: null }) => void) | undefined;
    const adapterWait = new Promise<{ code: number | null; signal: null }>((resolve) => {
      resolveWait = resolve;
    });
    const owner: WindowsProcessOwner = {
      launch: async ({ ownerId, runId }) => ({
        adapter: {
          pid: 4242,
          onStdout: vi.fn(),
          onStderr: vi.fn(),
          wait: async () => await adapterWait,
          kill: vi.fn(),
          dispose: vi.fn(),
        },
        identity: {
          version: 1,
          jobName: buildWindowsJobName(ownerId, runId),
          ownerId,
          runId,
          rootPid: 4242,
          rootProcessCreationTime: "133829712000000000",
          killOnClose: true,
        },
        query: async () => ({
          jobName: buildWindowsJobName(ownerId, runId),
          memberPids: [4242],
          activeProcessCount: 1,
        }),
        terminate: async () => undefined,
        waitForEmpty: async () => true,
        close: async () => undefined,
      }),
      reconcile: async () => "absent",
    };
    try {
      const supervisor = createProcessSupervisor({
        platform: "win32",
        windowsProcessOwner: owner,
        journalPath,
      });
      const run = await supervisor.spawn({
        mode: "child",
        argv: ["owned.exe"],
        sessionId: "session-a",
        backendId: "test",
        runId: "run-a",
      });
      await expect(readOwnedProcessJournal(journalPath)).resolves.toEqual([
        expect.objectContaining({
          runId: "run-a",
          pid: 4242,
          windowsJobIdentity: expect.objectContaining({
            jobName: expect.stringContaining("AilliumOpenClaw"),
            rootPid: 4242,
            rootProcessCreationTime: "133829712000000000",
          }),
        }),
      ]);
      resolveWait?.({ code: 0, signal: null });
      await run.wait();
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it.each(["terminate", "wait-empty", "close"] as const)(
    "retains a settled run and completes teardown on retry after %s rejects",
    async (failurePoint) => {
      const terminate = vi
        .fn<() => Promise<void>>()
        .mockImplementationOnce(async () => {
          if (failurePoint === "terminate") {
            throw new Error("terminate rejected");
          }
        })
        .mockResolvedValue(undefined);
      const waitForEmpty = vi
        .fn<() => Promise<boolean>>()
        .mockImplementationOnce(async () => {
          if (failurePoint === "wait-empty") {
            throw new Error("empty wait rejected");
          }
          return true;
        })
        .mockResolvedValue(true);
      const close = vi
        .fn<() => Promise<void>>()
        .mockImplementationOnce(async () => {
          if (failurePoint === "close") {
            throw new Error("close rejected");
          }
        })
        .mockResolvedValue(undefined);
      const owner: WindowsProcessOwner = {
        launch: async ({ ownerId, runId }) => ({
          adapter: {
            pid: 4242,
            onStdout: vi.fn(),
            onStderr: vi.fn(),
            wait: async () => ({ code: 0, signal: null }),
            kill: vi.fn(),
            dispose: vi.fn(),
          },
          identity: {
            version: 1,
            jobName: buildWindowsJobName(ownerId, runId),
            ownerId,
            runId,
            rootPid: 4242,
            rootProcessCreationTime: "133829712000000000",
            killOnClose: true,
          },
          query: async () => ({
            jobName: buildWindowsJobName(ownerId, runId),
            memberPids: [4242],
            activeProcessCount: 1,
          }),
          terminate,
          waitForEmpty,
          close,
        }),
        reconcile: async () => "absent",
      };
      const supervisor = createProcessSupervisor({
        platform: "win32",
        windowsProcessOwner: owner,
      });
      const run = await supervisor.spawn({
        mode: "child",
        argv: ["owned.exe"],
        sessionId: "session-retry",
        backendId: "test",
        runId: `run-retry-${failurePoint}`,
        scopeKey: `scope-retry-${failurePoint}`,
      });

      await expect(run.wait()).rejects.toThrow("teardown remains unverified");
      const retry = await supervisor.cancelScopeAndWait(`scope-retry-${failurePoint}`, {
        force: true,
        deadlineMs: 500,
      });

      expect(retry).toMatchObject({
        requested: true,
        teardownComplete: true,
        remainingRunIds: [],
      });
      expect(supervisor.getRecord(run.runId)?.state).toBe("exited");
      if (failurePoint === "terminate") {
        expect(terminate).toHaveBeenCalledTimes(2);
      }
      if (failurePoint === "wait-empty") {
        expect(waitForEmpty).toHaveBeenCalledTimes(2);
      }
      if (failurePoint === "close") {
        expect(close).toHaveBeenCalledTimes(2);
      }
    },
  );
});

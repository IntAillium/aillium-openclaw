import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isProcessTreeAlive, killProcessTree } from "../kill-tree.js";
import {
  readOwnedProcessJournal,
  processListContainsOwnedMarker,
  SUPERVISOR_OWNER_ENV,
  SUPERVISOR_RUN_ENV,
  writeOwnedProcessJournal,
} from "./orphan-journal.js";
import { createProcessSupervisor } from "./supervisor.js";
import { appendVerifiedTeardownReceipts } from "./teardown-receipts.js";

const cleanup: Array<() => Promise<void>> = [];

async function waitForPidFile(filePath: string, timeoutMs = 2_000): Promise<number> {
  const deadlineAt = Date.now() + timeoutMs;
  while (Date.now() < deadlineAt) {
    try {
      const pid = Number((await fs.readFile(filePath, "utf8")).trim());
      if (Number.isFinite(pid) && pid > 0) {
        return pid;
      }
    } catch {
      // The fixture has not created its marker yet.
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for pid marker: ${filePath}`);
}

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((fn) => fn()));
});

describe("process supervisor orphan journal", () => {
  it.skipIf(process.platform === "win32")(
    "kills a marker-verified process group left by a previous runtime instance",
    async () => {
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-supervisor-"));
      const journalPath = path.join(directory, "owned.json");
      const ownerId = "previous-owner";
      const runId = "orphan-run";
      const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
        detached: true,
        stdio: "ignore",
        env: {
          ...process.env,
          [SUPERVISOR_OWNER_ENV]: ownerId,
          [SUPERVISOR_RUN_ENV]: runId,
        },
      });
      const pid = child.pid;
      if (!pid) {
        throw new Error("failed to spawn orphan fixture");
      }
      cleanup.push(async () => {
        if (isProcessTreeAlive(pid)) {
          killProcessTree(pid, { graceMs: 0 });
        }
        await fs.rm(directory, { recursive: true, force: true });
      });
      await writeOwnedProcessJournal(journalPath, [
        { ownerId, runId, pid, scopeKey: "run:orphan", startedAtMs: Date.now() },
      ]);

      const supervisor = createProcessSupervisor({
        journalPath,
        orphanMarkerVerifier: async (entry) => entry.ownerId === ownerId && entry.runId === runId,
      });
      await supervisor.reconcileOrphans();

      await expect.poll(() => isProcessTreeAlive(pid), { timeout: 2_000 }).toBe(false);
      await expect(readOwnedProcessJournal(journalPath)).resolves.toEqual([]);
    },
    10_000,
  );

  it.skipIf(process.platform === "win32")(
    "consumes exact signed teardown proof after a supervisor restart only once",
    async () => {
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-restart-receipt-"));
      const journalPath = path.join(directory, "owned.json");
      const ownerId = "previous-owner";
      const runId = "owned-process-run";
      const scopeKey = "run:canonical-chat-run";
      const sessionId = "tenant:session-a";
      const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
        detached: true,
        stdio: "ignore",
        env: {
          ...process.env,
          [SUPERVISOR_OWNER_ENV]: ownerId,
          [SUPERVISOR_RUN_ENV]: runId,
        },
      });
      const pid = child.pid;
      if (!pid) {
        throw new Error("failed to spawn restart receipt fixture");
      }
      cleanup.push(async () => {
        if (isProcessTreeAlive(pid)) {
          killProcessTree(pid, { graceMs: 0 });
        }
        await fs.rm(directory, { recursive: true, force: true });
      });
      await writeOwnedProcessJournal(journalPath, [
        { ownerId, runId, pid, sessionId, scopeKey, startedAtMs: Date.now() },
      ]);

      const firstRuntime = createProcessSupervisor({
        journalPath,
        orphanMarkerVerifier: async (entry) => entry.ownerId === ownerId && entry.runId === runId,
      });
      await firstRuntime.reconcileOrphans();
      await expect.poll(() => isProcessTreeAlive(pid), { timeout: 2_000 }).toBe(false);

      const restartedRuntime = createProcessSupervisor({
        journalPath,
        orphanMarkerVerifier: async () => false,
      });
      await restartedRuntime.reconcileOrphans();
      await expect(
        restartedRuntime.consumeVerifiedTeardownReceipt(scopeKey, "tenant:different"),
      ).resolves.toBeUndefined();
      const consumePromise = restartedRuntime.consumeVerifiedTeardownReceipt(scopeKey, sessionId);
      const relaunchedPath = path.join(directory, "relaunched");
      const concurrentSpawn = restartedRuntime.spawn({
        mode: "child",
        argv: [
          process.execPath,
          "-e",
          `require("node:fs").writeFileSync(${JSON.stringify(relaunchedPath)}, "yes")`,
        ],
        sessionId,
        backendId: "restart-race-test",
        runId: "concurrent-relaunch",
        scopeKey,
        stdinMode: "pipe-closed",
      });
      await expect(consumePromise).resolves.toMatchObject({
        requested: true,
        matchedRunIds: [runId],
        terminatedRunIds: [runId],
        remainingRunIds: [],
        teardownComplete: true,
      });
      await expect(concurrentSpawn).rejects.toThrow(
        "cannot spawn work for a correlation with consumed teardown proof",
      );
      await expect(fs.stat(relaunchedPath)).rejects.toThrow();
      await expect(
        restartedRuntime.consumeVerifiedTeardownReceipt(scopeKey, sessionId),
      ).resolves.toBeUndefined();
    },
    10_000,
  );

  it.skipIf(process.platform === "win32")(
    "does not issue scope proof when only one of multiple correlated trees is verified absent",
    async () => {
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-partial-receipt-"));
      const journalPath = path.join(directory, "owned.json");
      const sessionId = "tenant:shared-session";
      const scopeKey = "run:shared-chat-run";
      const createFixture = (ownerId: string, runId: string) =>
        spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
          detached: true,
          stdio: "ignore",
          env: {
            ...process.env,
            [SUPERVISOR_OWNER_ENV]: ownerId,
            [SUPERVISOR_RUN_ENV]: runId,
          },
        });
      const verified = createFixture("owner-verified", "process-verified");
      const unverified = createFixture("owner-unverified", "process-unverified");
      if (!verified.pid || !unverified.pid) {
        throw new Error("failed to spawn partial receipt fixtures");
      }
      const verifiedPid = verified.pid;
      const unverifiedPid = unverified.pid;
      cleanup.push(async () => {
        for (const pid of [verifiedPid, unverifiedPid]) {
          if (isProcessTreeAlive(pid)) {
            killProcessTree(pid, { graceMs: 0 });
          }
        }
        await fs.rm(directory, { recursive: true, force: true });
      });
      const startedAtMs = Date.now();
      await writeOwnedProcessJournal(journalPath, [
        {
          ownerId: "owner-verified",
          runId: "process-verified",
          pid: verifiedPid,
          sessionId,
          scopeKey,
          startedAtMs,
        },
        {
          ownerId: "owner-unverified",
          runId: "process-unverified",
          pid: unverifiedPid,
          sessionId,
          scopeKey,
          startedAtMs,
        },
      ]);

      const supervisor = createProcessSupervisor({
        journalPath,
        orphanMarkerVerifier: async (entry) => entry.runId === "process-verified",
      });
      await supervisor.reconcileOrphans();
      await expect.poll(() => isProcessTreeAlive(verifiedPid), { timeout: 2_000 }).toBe(false);
      expect(isProcessTreeAlive(unverifiedPid)).toBe(true);
      await expect(
        supervisor.consumeVerifiedTeardownReceipt(scopeKey, sessionId),
      ).resolves.toBeUndefined();
    },
    10_000,
  );

  it("parses process-group ownership markers without accepting a different run", () => {
    const entry = {
      ownerId: "owner-1",
      runId: "run-1",
      pid: 4321,
      startedAtMs: 1,
    };
    expect(
      processListContainsOwnedMarker(
        "99 4321 node OPENCLAW_SUPERVISOR_OWNER_ID=owner-1 OPENCLAW_SUPERVISOR_RUN_ID=run-1",
        entry,
      ),
    ).toBe(true);
    expect(
      processListContainsOwnedMarker(
        "99 4321 node OPENCLAW_SUPERVISOR_OWNER_ID=owner-1 OPENCLAW_SUPERVISOR_RUN_ID=run-2",
        entry,
      ),
    ).toBe(false);
  });

  it("does not consume an older receipt when current journal reconciliation fails", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-reconcile-failure-"));
    const receiptPath = path.join(directory, "receipts.json");
    const keyPath = path.join(directory, "receipts.key");
    cleanup.push(async () => {
      await fs.rm(directory, { recursive: true, force: true });
    });
    await appendVerifiedTeardownReceipts({
      receiptPath,
      keyPath,
      entries: [
        {
          ownerId: "old-owner",
          runId: "old-run",
          pid: 2_147_483_000,
          sessionId: "tenant:old-session",
          scopeKey: "run:old-chat-run",
          startedAtMs: Date.now() - 1_000,
        },
      ],
    });
    // Passing a directory as the journal target forces the reconciliation's
    // atomic rename to fail while leaving the separately stored receipt intact.
    const supervisor = createProcessSupervisor({
      journalPath: directory,
      teardownReceiptPath: receiptPath,
      teardownReceiptKeyPath: keyPath,
      orphanMarkerVerifier: async () => false,
    });

    await expect(
      supervisor.consumeVerifiedTeardownReceipt("run:old-chat-run", "tenant:old-session"),
    ).resolves.toBeUndefined();
  });

  it("gates a new spawn until startup reconciliation has serialized the old journal", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-supervisor-race-"));
    const journalPath = path.join(directory, "owned.json");
    cleanup.push(async () => {
      await fs.rm(directory, { recursive: true, force: true });
    });
    await writeOwnedProcessJournal(journalPath, [
      {
        ownerId: "previous-owner",
        runId: "previous-run",
        pid: 2_147_483_000,
        startedAtMs: 1,
      },
    ]);
    let releaseMarkerCheck: (() => void) | undefined;
    const markerCheck = new Promise<void>((resolve) => {
      releaseMarkerCheck = resolve;
    });
    const supervisor = createProcessSupervisor({
      journalPath,
      orphanMarkerVerifier: async () => {
        await markerCheck;
        return false;
      },
    });
    let spawnSettled = false;
    const spawnPromise = supervisor
      .spawn({
        mode: "child",
        argv: [process.execPath, "-e", "setInterval(() => {}, 1000)"],
        sessionId: "new-session",
        backendId: "race-test",
        runId: "new-run",
        scopeKey: "run:new-run",
        stdinMode: "pipe-closed",
      })
      .then((run) => {
        spawnSettled = true;
        return run;
      });
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    expect(spawnSettled).toBe(false);

    releaseMarkerCheck?.();
    const run = await spawnPromise;
    expect(await readOwnedProcessJournal(journalPath)).toEqual([
      expect.objectContaining({ runId: "new-run", pid: run.pid }),
    ]);
    await supervisor.cancelScopeAndWait("run:new-run", {
      deadlineMs: 1_000,
      force: true,
    });
    await run.wait();
  });

  it("does not launch work when the journal preflight fails and recovers the write queue", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-journal-preflight-"));
    const journalPath = path.join(directory, "owned.json");
    const launchedPath = path.join(directory, "launched");
    cleanup.push(async () => {
      await fs.rm(directory, { recursive: true, force: true });
    });
    let writeCalls = 0;
    const supervisor = createProcessSupervisor({
      journalPath,
      orphanMarkerVerifier: async () => false,
      journalWriter: async (targetPath, entries) => {
        writeCalls += 1;
        if (writeCalls === 1) {
          throw new Error("injected journal preflight failure");
        }
        await writeOwnedProcessJournal(targetPath, entries);
      },
    });

    await expect(
      supervisor.spawn({
        mode: "child",
        argv: [
          process.execPath,
          "-e",
          `require("node:fs").writeFileSync(${JSON.stringify(launchedPath)}, "yes")`,
        ],
        sessionId: "journal-preflight",
        backendId: "journal-test",
        runId: "preflight-failure",
        stdinMode: "pipe-closed",
      }),
    ).rejects.toThrow("injected journal preflight failure");
    await expect(fs.stat(launchedPath)).rejects.toThrow();
    expect(supervisor.getRecord("preflight-failure")).toMatchObject({
      state: "exited",
      terminationReason: "spawn-error",
    });

    const recoveredRun = await supervisor.spawn({
      mode: "child",
      argv: [process.execPath, "-e", "process.exit(0)"],
      sessionId: "journal-recovered",
      backendId: "journal-test",
      runId: "preflight-recovered",
      stdinMode: "pipe-closed",
    });
    await expect(recoveredRun.wait()).resolves.toMatchObject({ exitCode: 0 });
    await expect(readOwnedProcessJournal(journalPath)).resolves.toEqual([]);
  });

  it.skipIf(process.platform === "win32")(
    "force-kills and verifies the spawned process tree when the journal append fails",
    async () => {
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-journal-append-"));
      const journalPath = path.join(directory, "owned.json");
      const descendantPidPath = path.join(directory, "descendant.pid");
      let leaderPid: number | undefined;
      let descendantPid: number | undefined;
      cleanup.push(async () => {
        if (leaderPid && isProcessTreeAlive(leaderPid)) {
          killProcessTree(leaderPid, { graceMs: 0 });
        }
        if (descendantPid && isProcessTreeAlive(descendantPid)) {
          killProcessTree(descendantPid, { graceMs: 0 });
        }
        await fs.rm(directory, { recursive: true, force: true });
      });
      let failedAppend = false;
      const supervisor = createProcessSupervisor({
        journalPath,
        orphanMarkerVerifier: async () => false,
        journalWriter: async (targetPath, entries) => {
          const entry = entries.find((candidate) => candidate.runId === "append-failure");
          if (entry && !failedAppend) {
            leaderPid = entry.pid;
            descendantPid = await waitForPidFile(descendantPidPath);
            failedAppend = true;
            throw new Error("injected journal append failure");
          }
          await writeOwnedProcessJournal(targetPath, entries);
        },
      });
      const fixture = [
        'const { spawn } = require("node:child_process");',
        'const fs = require("node:fs");',
        'const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });',
        `fs.writeFileSync(${JSON.stringify(descendantPidPath)}, String(child.pid));`,
        "setInterval(() => {}, 1000);",
      ].join("\n");

      await expect(
        supervisor.spawn({
          mode: "child",
          argv: [process.execPath, "-e", fixture],
          sessionId: "journal-append",
          backendId: "journal-test",
          runId: "append-failure",
          stdinMode: "pipe-closed",
        }),
      ).rejects.toThrow("injected journal append failure");

      expect(leaderPid).toBeTypeOf("number");
      expect(descendantPid).toBeTypeOf("number");
      await expect.poll(() => isProcessTreeAlive(leaderPid!), { timeout: 2_000 }).toBe(false);
      await expect.poll(() => isProcessTreeAlive(descendantPid!), { timeout: 2_000 }).toBe(false);
      await expect(readOwnedProcessJournal(journalPath)).resolves.toEqual([]);
      expect(supervisor.getRecord("append-failure")).toMatchObject({
        state: "exited",
        terminationReason: "spawn-error",
      });
    },
    10_000,
  );

  it("keeps a completed run successful and retries after exit-journal cleanup fails", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-journal-exit-"));
    const journalPath = path.join(directory, "owned.json");
    cleanup.push(async () => {
      await fs.rm(directory, { recursive: true, force: true });
    });
    let firstRunWasPersisted = false;
    let failedExitCleanup = false;
    const supervisor = createProcessSupervisor({
      journalPath,
      orphanMarkerVerifier: async () => false,
      journalWriter: async (targetPath, entries) => {
        if (entries.some((entry) => entry.runId === "exit-cleanup-failure")) {
          firstRunWasPersisted = true;
        } else if (firstRunWasPersisted && !failedExitCleanup) {
          failedExitCleanup = true;
          throw new Error("injected exit cleanup failure");
        }
        await writeOwnedProcessJournal(targetPath, entries);
      },
    });

    const firstRun = await supervisor.spawn({
      mode: "child",
      argv: [process.execPath, "-e", "process.exit(0)"],
      sessionId: "journal-exit",
      backendId: "journal-test",
      runId: "exit-cleanup-failure",
      stdinMode: "pipe-closed",
    });
    await expect(firstRun.wait()).resolves.toMatchObject({ exitCode: 0, reason: "exit" });
    expect(failedExitCleanup).toBe(true);

    const recoveredRun = await supervisor.spawn({
      mode: "child",
      argv: [process.execPath, "-e", "process.exit(0)"],
      sessionId: "journal-exit-recovered",
      backendId: "journal-test",
      runId: "exit-cleanup-recovered",
      stdinMode: "pipe-closed",
    });
    await expect(recoveredRun.wait()).resolves.toMatchObject({ exitCode: 0 });
    await expect(readOwnedProcessJournal(journalPath)).resolves.toEqual([]);
  });
});

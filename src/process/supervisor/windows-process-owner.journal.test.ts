import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  readOwnedProcessJournal,
  reconcileWindowsOwnedProcessJournalDetailed,
  writeOwnedProcessJournal,
  type OwnedProcessJournalEntry,
} from "./orphan-journal.js";
import { buildWindowsJobName, type WindowsProcessOwner } from "./windows-process-owner.js";

const directories: string[] = [];

async function journalFixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-windows-job-journal-"));
  directories.push(directory);
  const journalPath = path.join(directory, "owned.json");
  const entry: OwnedProcessJournalEntry = {
    ownerId: "owner-a",
    runId: "run-a",
    pid: 4242,
    sessionId: "session-a",
    scopeKey: "scope-a",
    startedAtMs: 1,
    windowsJobIdentity: {
      version: 1,
      jobName: buildWindowsJobName("owner-a", "run-a"),
      ownerId: "owner-a",
      runId: "run-a",
      rootPid: 4242,
      rootProcessCreationTime: "133829712000000000",
      killOnClose: true,
    },
  };
  await writeOwnedProcessJournal(journalPath, [entry]);
  return { entry, journalPath };
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => fs.rm(directory, { recursive: true })),
  );
});

describe("Windows Job Object journal", () => {
  it("persists the exact run, job, PID, and process creation identity", async () => {
    const { entry, journalPath } = await journalFixture();
    await expect(readOwnedProcessJournal(journalPath)).resolves.toEqual([entry]);
  });

  it("retains PID-reuse or unknown reconciliation as a fail-closed residual", async () => {
    const { entry, journalPath } = await journalFixture();
    const owner: WindowsProcessOwner = {
      launch: vi.fn(),
      reconcile: vi.fn(async () => "identity_mismatch" as const),
    };
    await expect(
      reconcileWindowsOwnedProcessJournalDetailed(journalPath, owner, 500),
    ).resolves.toEqual({
      residuals: [entry],
      unverified: [entry],
      verifiedTerminated: [],
    });
    await expect(readOwnedProcessJournal(journalPath)).resolves.toEqual([entry]);
  });

  it("removes a journal entry only after exact Job Object teardown is verified", async () => {
    const { entry, journalPath } = await journalFixture();
    const owner: WindowsProcessOwner = {
      launch: vi.fn(),
      reconcile: vi.fn(async () => "terminated" as const),
    };
    await expect(
      reconcileWindowsOwnedProcessJournalDetailed(journalPath, owner, 500),
    ).resolves.toEqual({
      residuals: [],
      unverified: [],
      verifiedTerminated: [entry],
    });
    await expect(readOwnedProcessJournal(journalPath)).resolves.toEqual([]);
  });
});

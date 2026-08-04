import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { isProcessTreeAlive, killProcessTree } from "../kill-tree.js";
import type { WindowsJobIdentity, WindowsProcessOwner } from "./windows-process-owner.js";

const execFileAsync = promisify(execFile);

export const SUPERVISOR_OWNER_ENV = "OPENCLAW_SUPERVISOR_OWNER_ID";
export const SUPERVISOR_RUN_ENV = "OPENCLAW_SUPERVISOR_RUN_ID";

export type OwnedProcessJournalEntry = {
  ownerId: string;
  runId: string;
  pid: number;
  sessionId?: string;
  scopeKey?: string;
  startedAtMs: number;
  windowsJobIdentity?: WindowsJobIdentity;
};

export type OwnedProcessJournalReconciliation = {
  residuals: OwnedProcessJournalEntry[];
  unverified: OwnedProcessJournalEntry[];
  verifiedTerminated: OwnedProcessJournalEntry[];
};

function isWindowsJobIdentity(value: unknown): value is WindowsJobIdentity {
  if (!value || typeof value !== "object") {
    return false;
  }
  const identity = value as Partial<WindowsJobIdentity>;
  return (
    identity.version === 1 &&
    typeof identity.jobName === "string" &&
    identity.jobName.length > 0 &&
    typeof identity.ownerId === "string" &&
    identity.ownerId.length > 0 &&
    typeof identity.runId === "string" &&
    identity.runId.length > 0 &&
    Number.isInteger(identity.rootPid) &&
    Number(identity.rootPid) > 0 &&
    typeof identity.rootProcessCreationTime === "string" &&
    identity.rootProcessCreationTime.length > 0 &&
    identity.killOnClose === true
  );
}

type OwnedProcessJournal = {
  version: 1;
  runs: OwnedProcessJournalEntry[];
};

export async function readOwnedProcessJournal(
  journalPath: string,
): Promise<OwnedProcessJournalEntry[]> {
  try {
    const parsed = JSON.parse(await fs.readFile(journalPath, "utf8")) as OwnedProcessJournal;
    if (parsed.version !== 1 || !Array.isArray(parsed.runs)) {
      return [];
    }
    return parsed.runs.filter(
      (entry) =>
        entry &&
        typeof entry.ownerId === "string" &&
        typeof entry.runId === "string" &&
        (entry.sessionId === undefined || typeof entry.sessionId === "string") &&
        (entry.scopeKey === undefined || typeof entry.scopeKey === "string") &&
        Number.isInteger(entry.pid) &&
        entry.pid > 0 &&
        Number.isFinite(entry.startedAtMs) &&
        (entry.windowsJobIdentity === undefined || isWindowsJobIdentity(entry.windowsJobIdentity)),
    );
  } catch {
    return [];
  }
}

export async function reconcileWindowsOwnedProcessJournalDetailed(
  journalPath: string,
  owner: WindowsProcessOwner | undefined,
  deadlineMs = 1_500,
): Promise<OwnedProcessJournalReconciliation> {
  const recorded = await readOwnedProcessJournal(journalPath);
  const residuals: OwnedProcessJournalEntry[] = [];
  const unverified: OwnedProcessJournalEntry[] = [];
  const verifiedTerminated: OwnedProcessJournalEntry[] = [];
  for (const entry of recorded) {
    const identity = entry.windowsJobIdentity;
    if (
      !owner ||
      !identity ||
      identity.ownerId !== entry.ownerId ||
      identity.runId !== entry.runId ||
      identity.rootPid !== entry.pid
    ) {
      residuals.push(entry);
      unverified.push(entry);
      continue;
    }
    const result = await owner.reconcile(identity, deadlineMs).catch(() => "unknown" as const);
    if (result === "absent" || result === "terminated") {
      verifiedTerminated.push(entry);
      continue;
    }
    residuals.push(entry);
    unverified.push(entry);
  }
  await writeOwnedProcessJournal(journalPath, residuals);
  return { residuals, unverified, verifiedTerminated };
}

export async function writeOwnedProcessJournal(
  journalPath: string,
  runs: OwnedProcessJournalEntry[],
): Promise<void> {
  await fs.mkdir(path.dirname(journalPath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${journalPath}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  await fs.writeFile(
    temporaryPath,
    `${JSON.stringify({ version: 1, runs } satisfies OwnedProcessJournal)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  await fs.rename(temporaryPath, journalPath);
}

export function processListContainsOwnedMarker(
  output: string,
  entry: OwnedProcessJournalEntry,
): boolean {
  const ownerMarker = `${SUPERVISOR_OWNER_ENV}=${entry.ownerId}`;
  const runMarker = `${SUPERVISOR_RUN_ENV}=${entry.runId}`;
  return output.split("\n").some((line) => {
    const columns = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
    if (!columns) {
      return false;
    }
    const processGroupId = Number(columns[2]);
    return processGroupId === entry.pid && line.includes(ownerMarker) && line.includes(runMarker);
  });
}

async function ownedMarkerStillPresent(entry: OwnedProcessJournalEntry): Promise<boolean> {
  if (process.platform === "win32") {
    // Windows does not expose a reliable per-process environment query without
    // privileged APIs. Fail closed instead of risking a recycled-PID kill.
    return false;
  }
  try {
    const { stdout } = await execFileAsync("ps", ["eww", "-axo", "pid=,pgid=,command="], {
      maxBuffer: 8 * 1024 * 1024,
    });
    return processListContainsOwnedMarker(stdout, entry);
  } catch {
    return false;
  }
}

export async function reconcileOwnedProcessJournal(
  journalPath: string,
  deadlineMs = 1_500,
  markerVerifier: (entry: OwnedProcessJournalEntry) => Promise<boolean> = ownedMarkerStillPresent,
): Promise<OwnedProcessJournalEntry[]> {
  const result = await reconcileOwnedProcessJournalDetailed(
    journalPath,
    deadlineMs,
    markerVerifier,
  );
  return result.residuals;
}

export async function reconcileOwnedProcessJournalDetailed(
  journalPath: string,
  deadlineMs = 1_500,
  markerVerifier: (entry: OwnedProcessJournalEntry) => Promise<boolean> = ownedMarkerStillPresent,
): Promise<OwnedProcessJournalReconciliation> {
  const recorded = await readOwnedProcessJournal(journalPath);
  const confirmed = (
    await Promise.all(recorded.map(async (entry) => ((await markerVerifier(entry)) ? entry : null)))
  ).filter((entry): entry is OwnedProcessJournalEntry => entry !== null);
  const confirmedKeys = new Set(
    confirmed.map((entry) => `${entry.ownerId}:${entry.runId}:${entry.pid}`),
  );
  const unverified = recorded.filter(
    (entry) => !confirmedKeys.has(`${entry.ownerId}:${entry.runId}:${entry.pid}`),
  );
  const unverifiedAlive = unverified.filter((entry) => isProcessTreeAlive(entry.pid));
  for (const entry of confirmed) {
    killProcessTree(entry.pid, { graceMs: 0 });
  }
  const deadlineAt = Date.now() + Math.max(1, deadlineMs);
  let remaining = confirmed;
  while (remaining.length > 0 && Date.now() < deadlineAt) {
    remaining = remaining.filter((entry) => isProcessTreeAlive(entry.pid));
    if (remaining.length > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
  }
  const residuals = [...unverifiedAlive, ...remaining];
  const residualKeys = new Set(
    residuals.map((entry) => `${entry.ownerId}:${entry.runId}:${entry.pid}`),
  );
  const verifiedTerminated = confirmed.filter(
    (entry) => !residualKeys.has(`${entry.ownerId}:${entry.runId}:${entry.pid}`),
  );
  await writeOwnedProcessJournal(journalPath, residuals);
  return { residuals, unverified, verifiedTerminated };
}

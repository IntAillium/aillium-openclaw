import { spawn, spawnSync } from "node:child_process";

const DEFAULT_GRACE_MS = 3000;
const MAX_GRACE_MS = 60_000;

/**
 * Best-effort process-tree termination with graceful shutdown.
 * - Windows: use taskkill /T to include descendants. Sends SIGTERM-equivalent
 *   first (without /F), then force-kills if process survives.
 * - Unix: send SIGTERM to process group first, wait grace period, then SIGKILL.
 *
 * This gives child processes a chance to clean up (close connections, remove
 * temp files, terminate their own children) before being hard-killed.
 */
export function killProcessTree(pid: number, opts?: { graceMs?: number }): void {
  if (!Number.isFinite(pid) || pid <= 0) {
    return;
  }

  const graceMs = normalizeGraceMs(opts?.graceMs);

  if (process.platform === "win32") {
    killProcessTreeWindows(pid, graceMs);
    return;
  }

  killProcessTreeUnix(pid, graceMs);
}

function normalizeGraceMs(value?: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_GRACE_MS;
  }
  return Math.max(0, Math.min(MAX_GRACE_MS, Math.floor(value)));
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Verify that neither the owned process group nor its leader is observable by
 * the OS. This is stronger than an in-memory supervisor transition and is used
 * before reporting teardown as complete.
 */
export function isProcessTreeAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) {
    return false;
  }
  if (process.platform === "win32") {
    return isProcessAlive(pid);
  }
  try {
    const result = spawnSync("ps", ["-axo", "pid=,pgid=,stat="], {
      encoding: "utf8",
      timeout: 1_000,
    });
    if (result.status === 0 && typeof result.stdout === "string") {
      return result.stdout.split("\n").some((line) => {
        const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)/);
        if (!match) {
          return false;
        }
        const processId = Number(match[1]);
        const processGroupId = Number(match[2]);
        const state = match[3] ?? "";
        return (processId === pid || processGroupId === pid) && !state.startsWith("Z");
      });
    }
  } catch {
    // Fall through to the portable signal-zero check.
  }
  return isProcessAlive(-pid) || isProcessAlive(pid);
}

function killProcessTreeUnix(pid: number, graceMs: number): void {
  // Step 1: Try graceful SIGTERM to process group
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    // Process group doesn't exist or we lack permission - try direct
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Already gone
      return;
    }
  }

  // Step 2: Wait grace period, then SIGKILL if still alive
  setTimeout(() => {
    if (isProcessAlive(-pid)) {
      try {
        process.kill(-pid, "SIGKILL");
        return;
      } catch {
        // Fall through to direct pid kill
      }
    }
    if (!isProcessAlive(pid)) {
      return;
    }
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Process exited between liveness check and kill
    }
  }, graceMs).unref(); // Don't block event loop exit
}

function runTaskkill(args: string[]): void {
  try {
    spawn("taskkill", args, {
      stdio: "ignore",
      detached: true,
      windowsHide: true,
    });
  } catch {
    // Ignore taskkill spawn failures
  }
}

function killProcessTreeWindows(pid: number, graceMs: number): void {
  // Step 1: Try graceful termination (taskkill without /F)
  runTaskkill(["/T", "/PID", String(pid)]);

  // Step 2: Always issue the forced tree pass. The leader can exit while a
  // descendant remains, so leader liveness is not proof of tree teardown.
  setTimeout(() => {
    runTaskkill(["/F", "/T", "/PID", String(pid)]);
  }, graceMs).unref(); // Don't block event loop exit
}

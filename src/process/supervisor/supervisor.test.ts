import { describe, expect, it } from "vitest";
import { createProcessSupervisor } from "./supervisor.js";

type ProcessSupervisor = ReturnType<typeof createProcessSupervisor>;
type SpawnOptions = Parameters<ProcessSupervisor["spawn"]>[0];
type ChildSpawnOptions = Omit<Extract<SpawnOptions, { mode: "child" }>, "backendId" | "mode">;

function createWriteStdoutArgv(output: string): string[] {
  if (process.platform === "win32") {
    return [process.execPath, "-e", `process.stdout.write(${JSON.stringify(output)})`];
  }
  return ["/usr/bin/printf", "%s", output];
}

async function spawnChild(supervisor: ProcessSupervisor, options: ChildSpawnOptions) {
  return supervisor.spawn({
    ...options,
    backendId: "test",
    mode: "child",
  });
}

describe("process supervisor", () => {
  it("spawns child runs and captures output", async () => {
    const supervisor = createProcessSupervisor();
    const run = await spawnChild(supervisor, {
      sessionId: "s1",
      argv: createWriteStdoutArgv("ok"),
      timeoutMs: 1_000,
      stdinMode: "pipe-closed",
    });
    const exit = await run.wait();
    expect(exit.reason).toBe("exit");
    expect(exit.exitCode).toBe(0);
    expect(exit.stdout).toBe("ok");
  });

  it("enforces no-output timeout for silent processes", async () => {
    const supervisor = createProcessSupervisor();
    const run = await spawnChild(supervisor, {
      sessionId: "s1",
      argv: [process.execPath, "-e", "setTimeout(() => {}, 14)"],
      timeoutMs: 300,
      noOutputTimeoutMs: 5,
      stdinMode: "pipe-closed",
    });
    const exit = await run.wait();
    expect(exit.reason).toBe("no-output-timeout");
    expect(exit.noOutputTimedOut).toBe(true);
    expect(exit.timedOut).toBe(true);
  });

  it("cancels prior scoped run when replaceExistingScope is enabled", async () => {
    const supervisor = createProcessSupervisor();
    const first = await spawnChild(supervisor, {
      sessionId: "s1",
      scopeKey: "scope:a",
      argv: [process.execPath, "-e", "setTimeout(() => {}, 80)"],
      timeoutMs: 1_000,
      stdinMode: "pipe-open",
    });

    const second = await spawnChild(supervisor, {
      sessionId: "s1",
      scopeKey: "scope:a",
      replaceExistingScope: true,
      argv: createWriteStdoutArgv("new"),
      timeoutMs: 1_000,
      stdinMode: "pipe-closed",
    });

    const firstExit = await first.wait();
    const secondExit = await second.wait();
    expect(firstExit.reason === "manual-cancel" || firstExit.reason === "signal").toBe(true);
    expect(secondExit.reason).toBe("exit");
    expect(secondExit.stdout).toBe("new");
  });

  it("applies overall timeout even for near-immediate timer firing", async () => {
    const supervisor = createProcessSupervisor();
    const run = await spawnChild(supervisor, {
      sessionId: "s-timeout",
      argv: [process.execPath, "-e", "setTimeout(() => {}, 12)"],
      timeoutMs: 1,
      stdinMode: "pipe-closed",
    });
    const exit = await run.wait();
    expect(exit.reason).toBe("overall-timeout");
    expect(exit.timedOut).toBe(true);
  });

  it("can stream output without retaining it in RunExit payload", async () => {
    const supervisor = createProcessSupervisor();
    let streamed = "";
    const run = await spawnChild(supervisor, {
      sessionId: "s-capture",
      argv: createWriteStdoutArgv("streamed"),
      timeoutMs: 1_000,
      stdinMode: "pipe-closed",
      captureOutput: false,
      onStdout: (chunk) => {
        streamed += chunk;
      },
    });
    const exit = await run.wait();
    expect(streamed).toBe("streamed");
    expect(exit.stdout).toBe("");
  });

  it("forces an ignored cooperative abort across the tracked process tree", async () => {
    if (process.platform === "win32") {
      return;
    }
    const supervisor = createProcessSupervisor();
    let stdout = "";
    let resolveDescendantPid: ((pid: number) => void) | undefined;
    const descendantPidPromise = new Promise<number>((resolve) => {
      resolveDescendantPid = resolve;
    });
    const descendantScript = "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)";
    const parentScript = [
      "const {spawn}=require('node:child_process')",
      `const child=spawn(process.execPath,['-e',${JSON.stringify(descendantScript)}],{stdio:'ignore'})`,
      "process.stdout.write(String(child.pid)+'\\n')",
      "setInterval(()=>{},1000)",
    ].join(";");
    await spawnChild(supervisor, {
      sessionId: "s-forced-tree",
      scopeKey: "run:forced-tree",
      argv: [process.execPath, "-e", parentScript],
      stdinMode: "pipe-closed",
      captureOutput: false,
      onStdout: (chunk) => {
        stdout += chunk;
        const parsed = Number.parseInt(stdout.trim(), 10);
        if (Number.isFinite(parsed) && parsed > 0) {
          resolveDescendantPid?.(parsed);
          resolveDescendantPid = undefined;
        }
      },
    });

    const descendantPid = await descendantPidPromise;
    const cancellation = await supervisor.cancelScopeAndWait("run:forced-tree", {
      deadlineMs: 4_500,
    });
    expect(cancellation.requested).toBe(true);
    expect(cancellation.teardownComplete).toBe(true);
    expect(cancellation.remainingRunIds).toEqual([]);
    expect(cancellation.elapsedMs).toBeLessThan(5_000);

    await expect
      .poll(
        () => {
          try {
            process.kill(descendantPid, 0);
            return false;
          } catch {
            return true;
          }
        },
        { timeout: 1_000, interval: 20 },
      )
      .toBe(true);
  }, 10_000);
});

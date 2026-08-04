import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCommand } from "./invoke.js";

const tempDirs: string[] = [];

async function waitForFile(filePath: string, timeoutMs = 2_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      return await fs.readFile(filePath, "utf8");
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error(`timed out waiting for ${filePath}`);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("node-host system.run cancellation", () => {
  it("kills the spawned command tree before the invocation completes", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-node-cancel-"));
    tempDirs.push(dir);
    const pidFile = path.join(dir, "descendant.pid");
    const script = [
      "const { spawn } = require('node:child_process')",
      "const fs = require('node:fs')",
      "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })",
      "fs.writeFileSync(process.argv[1], String(child.pid))",
      "setInterval(() => {}, 1000)",
    ].join(";");
    const controller = new AbortController();
    const operation = runCommand(
      [process.execPath, "-e", script, pidFile],
      undefined,
      undefined,
      10_000,
      controller.signal,
    );
    const descendantPid = Number.parseInt((await waitForFile(pidFile)).trim(), 10);
    expect(isProcessAlive(descendantPid)).toBe(true);

    controller.abort(new Error("cancelled by caller"));
    await expect(operation).resolves.toMatchObject({
      success: false,
      timedOut: false,
      error: "node invocation cancelled",
    });
    await expect.poll(() => isProcessAlive(descendantPid), { timeout: 2_000 }).toBe(false);
  });
});

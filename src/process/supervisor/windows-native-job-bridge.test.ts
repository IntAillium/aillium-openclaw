import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  buildWindowsCommandLine,
  createBundledWindowsNativeJobBridge,
  createDefaultWindowsProcessOwner,
  loadBundledWindowsJobObjectBinding,
  resolveBundledWindowsJobObjectBindingPath,
  WINDOWS_JOB_OBJECT_BINDING_FILE,
  WINDOWS_JOB_OBJECT_NATIVE_ABI_VERSION,
  type BundledWindowsJobObjectBinding,
} from "./windows-native-job-bridge.js";
import { createWindowsProcessOwner } from "./windows-process-owner.js";

function openNull(flags: "r" | "w"): number {
  return fs.openSync("/dev/null", flags);
}

function binding(createdInputs: unknown[] = []): BundledWindowsJobObjectBinding {
  return {
    abiVersion: WINDOWS_JOB_OBJECT_NATIVE_ABI_VERSION,
    createJob: vi.fn(() => "job-token"),
    openJob: vi.fn(() => "job-token"),
    setKillOnJobClose: vi.fn(),
    createProcessSuspended: vi.fn((input) => {
      createdInputs.push(input);
      return {
        pid: 4242,
        creationTime: "133829712000000000",
        processToken: "process-token",
        primaryThreadToken: "thread-token",
        stdinFd: openNull("w"),
        stdoutFd: openNull("r"),
        stderrFd: openNull("r"),
      };
    }),
    assignProcess: vi.fn(),
    resumePrimaryThread: vi.fn(),
    queryJob: vi.fn(() => ({
      jobName: "Local\\AilliumOpenClaw-b3duZXItYQ-cnVuLWE",
      memberPids: [4242],
      activeProcessCount: 1,
    })),
    queryProcessIdentity: vi.fn(() => ({
      pid: 4242,
      creationTime: "133829712000000000",
    })),
    queryProcessExit: vi.fn(() => 0),
    terminateProcess: vi.fn(),
    terminateJob: vi.fn(),
    closeProcessHandles: vi.fn(),
    closeJob: vi.fn(),
  };
}

describe("bundled Windows Job Object bridge", () => {
  it("quotes Windows argv deterministically", () => {
    expect(buildWindowsCommandLine(["C:\\Program Files\\tool.exe", "plain", 'say "hi"'])).toBe(
      '"C:\\Program Files\\tool.exe" plain "say \\"hi\\""',
    );
  });

  it("loads only the exact first-party ABI", () => {
    const exact = binding();
    expect(
      loadBundledWindowsJobObjectBinding({
        moduleUrl: pathToFileURL("/approved/openclaw/dist/runtime.js").href,
        load: () => exact,
      }),
    ).toBe(exact);
    expect(() =>
      loadBundledWindowsJobObjectBinding({
        moduleUrl: pathToFileURL("/approved/openclaw/dist/runtime.js").href,
        load: () => ({ abiVersion: 999 }),
      }),
    ).toThrow("incompatible ABI");
  });

  it("resolves the approved artifact beside the built dist bundle", () => {
    expect(
      resolveBundledWindowsJobObjectBindingPath(
        pathToFileURL("/approved/openclaw/dist/plugin-sdk/runtime.js").href,
      ),
    ).toBe(`/approved/openclaw/dist/native/windows-job-object/${WINDOWS_JOB_OBJECT_BINDING_FILE}`);
    expect(() =>
      resolveBundledWindowsJobObjectBindingPath(
        pathToFileURL("/approved/openclaw/src/process/supervisor/runtime.ts").href,
      ),
    ).toThrow("requires an approved built package under dist");
  });

  it("never falls back to an artifact under the current working directory", () => {
    let loadedPath = "";
    const exact = binding();
    loadBundledWindowsJobObjectBinding({
      moduleUrl: pathToFileURL("/approved/openclaw/dist/runtime.js").href,
      load: (candidate) => {
        loadedPath = candidate;
        return exact;
      },
    });
    expect(loadedPath).toBe(
      `/approved/openclaw/dist/native/windows-job-object/${WINDOWS_JOB_OBJECT_BINDING_FILE}`,
    );
    expect(loadedPath).not.toBe(
      path.resolve(
        process.cwd(),
        "native/windows-job-object/build/Release",
        WINDOWS_JOB_OBJECT_BINDING_FILE,
      ),
    );
  });

  it("refuses startup deterministically when the compiled binding is absent", () => {
    expect(() =>
      createDefaultWindowsProcessOwner({
        platform: "win32",
        loadBinding: () => {
          throw new Error("binding missing");
        },
      }),
    ).toThrow("binding missing");
  });

  it("does not attempt to load the Windows binding on another platform", () => {
    const loadBinding = vi.fn(() => binding());
    expect(createDefaultWindowsProcessOwner({ platform: "darwin", loadBinding })).toBeUndefined();
    expect(loadBinding).not.toHaveBeenCalled();
  });

  it("injects the concrete bundled bridge into the process owner", async () => {
    const createdInputs: unknown[] = [];
    const native = binding(createdInputs);
    const owner = createDefaultWindowsProcessOwner({
      platform: "win32",
      loadBinding: () => native,
    });
    const owned = await owner!.launch({
      ownerId: "owner-a",
      runId: "run-a",
      run: {
        mode: "child",
        argv: ["tool.exe", "argument"],
        sessionId: "session-a",
        backendId: "test",
        stdinMode: "pipe-closed",
      },
      env: { TEST_VALUE: "yes" },
    });
    expect(createdInputs).toEqual([
      expect.objectContaining({
        commandLine: "tool.exe argument",
        environment: ["TEST_VALUE=yes"],
        stdinMode: "pipe-closed",
      }),
    ]);
    expect(owned.identity.rootProcessCreationTime).toBe("133829712000000000");
    await owned.close();
    owned.adapter.dispose();
    await new Promise<void>((resolve) => setImmediate(resolve));
  });

  it("terminates the suspended process and closes native handles when adapter creation fails", async () => {
    const native = binding();
    const descriptor = native.createProcessSuspended({
      commandLine: "placeholder.exe",
      environment: [],
      stdinMode: "pipe-closed",
    });
    vi.mocked(native.createProcessSuspended).mockClear();
    vi.mocked(native.createProcessSuspended).mockReturnValueOnce(descriptor);
    const bridge = createBundledWindowsNativeJobBridge(native, {
      streams: {
        createReadable: () => {
          throw new Error("stream construction failed");
        },
        createWritable: () => {
          throw new Error("stream construction failed");
        },
      },
    });
    const owner = createWindowsProcessOwner(bridge);
    const closeSync = vi.spyOn(fs, "closeSync");
    try {
      await expect(
        owner.launch({
          ownerId: "owner-a",
          runId: "run-a",
          run: {
            mode: "child",
            argv: ["tool.exe"],
            sessionId: "session-a",
            backendId: "test",
          },
          env: {},
        }),
      ).rejects.toThrow("failed to construct");
      expect(native.terminateProcess).toHaveBeenCalledWith(descriptor.processToken, 1);
      expect(native.closeProcessHandles).toHaveBeenCalledWith(
        descriptor.processToken,
        descriptor.primaryThreadToken,
      );
      expect(native.terminateJob).toHaveBeenCalled();
      expect(native.closeJob).toHaveBeenCalled();
      for (const fd of [descriptor.stdinFd, descriptor.stdoutFd, descriptor.stderrFd]) {
        if (fd !== undefined) {
          expect(closeSync.mock.calls.filter(([closedFd]) => closedFd === fd)).toHaveLength(1);
          expect(() => fs.fstatSync(fd)).toThrow();
        }
      }
    } finally {
      closeSync.mockRestore();
    }
    for (const fd of [descriptor.stdinFd, descriptor.stdoutFd, descriptor.stderrFd]) {
      if (fd !== undefined) {
        expect(() => fs.closeSync(fd)).toThrow();
      }
    }
  });

  it("closes partially transferred stream descriptors without double-closing them", async () => {
    const native = binding();
    const descriptor = native.createProcessSuspended({
      commandLine: "placeholder.exe",
      environment: [],
      stdinMode: "pipe-closed",
    });
    vi.mocked(native.createProcessSuspended).mockClear();
    vi.mocked(native.createProcessSuspended).mockReturnValueOnce(descriptor);
    let readableCount = 0;
    const closeSync = vi.spyOn(fs, "closeSync");
    try {
      const bridge = createBundledWindowsNativeJobBridge(native, {
        streams: {
          createReadable: (fd) => {
            readableCount += 1;
            if (readableCount === 2) {
              throw new Error("second stream rejected");
            }
            return fs.createReadStream("", { fd, autoClose: true });
          },
          createWritable: (fd) => fs.createWriteStream("", { fd, autoClose: true }),
        },
      });
      await expect(
        bridge.createProcessSuspended({
          run: {
            mode: "child",
            argv: ["tool.exe"],
            sessionId: "session-a",
            backendId: "test",
          },
          env: {},
        }),
      ).rejects.toThrow("failed to construct");
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(
        closeSync.mock.calls.filter(([closedFd]) => closedFd === descriptor.stdoutFd),
      ).toHaveLength(0);
      for (const fd of [descriptor.stdinFd, descriptor.stderrFd]) {
        if (fd !== undefined) {
          expect(closeSync.mock.calls.filter(([closedFd]) => closedFd === fd)).toHaveLength(1);
        }
      }
      for (const fd of [descriptor.stdinFd, descriptor.stdoutFd, descriptor.stderrFd]) {
        if (fd !== undefined) {
          expect(() => fs.fstatSync(fd)).toThrow();
        }
      }
    } finally {
      closeSync.mockRestore();
    }
    for (const fd of [descriptor.stdinFd, descriptor.stdoutFd, descriptor.stderrFd]) {
      if (fd !== undefined) {
        expect(() => fs.closeSync(fd)).toThrow();
      }
    }
  });

  it("refuses ConPTY work without creating an unowned native process", async () => {
    const native = binding();
    const owner = createDefaultWindowsProcessOwner({
      platform: "win32",
      loadBinding: () => native,
    });
    await expect(
      owner!.launch({
        ownerId: "owner-a",
        runId: "run-a",
        run: {
          mode: "pty",
          ptyCommand: "interactive.exe",
          sessionId: "session-a",
          backendId: "test",
        },
        env: {},
      }),
    ).rejects.toThrow("does not yet support ConPTY");
    expect(native.createProcessSuspended).not.toHaveBeenCalled();
    expect(native.terminateJob).toHaveBeenCalled();
    expect(native.closeJob).toHaveBeenCalled();
  });

  it("uses STARTUPINFOEX to whitelist only the three intended stdio handles", () => {
    const testDirectory = path.dirname(fileURLToPath(import.meta.url));
    const source = fs.readFileSync(
      path.resolve(testDirectory, "../../../native/windows-job-object/src/addon.cc"),
      "utf8",
    );
    expect(source).toContain("STARTUPINFOEXW startup{}");
    expect(source).toContain("PROC_THREAD_ATTRIBUTE_HANDLE_LIST");
    expect(source).toContain(
      "HANDLE inherited_handles[] = {stdin_child, stdout_child, stderr_child}",
    );
    expect(source).toContain("EXTENDED_STARTUPINFO_PRESENT");
    expect(source).toContain("startup.StartupInfo.hStdInput = stdin_child");
    expect(source).not.toContain("STARTUPINFOW startup{}");
  });
});

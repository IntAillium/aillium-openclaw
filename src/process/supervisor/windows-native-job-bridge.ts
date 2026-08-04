import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ManagedRunStdin, SpawnProcessAdapter } from "./types.js";
import {
  createWindowsProcessOwner,
  type WindowsJobHandle,
  type WindowsJobQuery,
  type WindowsNativeJobBridge,
  type WindowsProcessIdentity,
  type WindowsProcessOwner,
  type WindowsSuspendedProcess,
} from "./windows-process-owner.js";

export const WINDOWS_JOB_OBJECT_NATIVE_ABI_VERSION = 1;
export const WINDOWS_JOB_OBJECT_BINDING_FILE = "openclaw_windows_job_object.node";

type NativeProcessDescriptor = {
  pid: number;
  creationTime: string;
  processToken: string;
  primaryThreadToken: string;
  stdinFd?: number;
  stdoutFd: number;
  stderrFd: number;
};

export type BundledWindowsJobObjectBinding = {
  abiVersion: number;
  createJob: (jobName: string) => string;
  openJob: (jobName: string) => string | undefined;
  setKillOnJobClose: (jobToken: string) => void;
  createProcessSuspended: (input: {
    commandLine: string;
    cwd?: string;
    environment: string[];
    stdinMode: "inherit" | "pipe-open" | "pipe-closed";
  }) => NativeProcessDescriptor;
  assignProcess: (jobToken: string, processToken: string) => void;
  resumePrimaryThread: (primaryThreadToken: string) => void;
  queryJob: (jobToken: string) => WindowsJobQuery;
  queryProcessIdentity: (pid: number) => WindowsProcessIdentity | undefined;
  queryProcessExit: (processToken: string) => number | undefined;
  terminateProcess: (processToken: string, exitCode: number) => void;
  terminateJob: (jobToken: string, exitCode: number) => void;
  closeProcessHandles: (processToken: string, primaryThreadToken: string) => void;
  closeJob: (jobToken: string) => void;
};

type BindingLoader = (candidate: string) => unknown;

export function resolveBundledWindowsJobObjectBindingPath(moduleUrl = import.meta.url): string {
  const modulePath = fileURLToPath(moduleUrl);
  const distMarker = `${path.sep}dist${path.sep}`;
  const distIndex = modulePath.lastIndexOf(distMarker);
  if (distIndex < 0) {
    throw new Error(
      "Windows Job Object binding resolution requires an approved built package under dist",
    );
  }
  const packageRoot = modulePath.slice(0, distIndex);
  return path.join(packageRoot, "dist/native/windows-job-object", WINDOWS_JOB_OBJECT_BINDING_FILE);
}

function isBinding(value: unknown): value is BundledWindowsJobObjectBinding {
  if (!value || typeof value !== "object") {
    return false;
  }
  const binding = value as Partial<BundledWindowsJobObjectBinding>;
  return (
    binding.abiVersion === WINDOWS_JOB_OBJECT_NATIVE_ABI_VERSION &&
    typeof binding.createJob === "function" &&
    typeof binding.openJob === "function" &&
    typeof binding.setKillOnJobClose === "function" &&
    typeof binding.createProcessSuspended === "function" &&
    typeof binding.assignProcess === "function" &&
    typeof binding.resumePrimaryThread === "function" &&
    typeof binding.queryJob === "function" &&
    typeof binding.queryProcessIdentity === "function" &&
    typeof binding.queryProcessExit === "function" &&
    typeof binding.terminateProcess === "function" &&
    typeof binding.terminateJob === "function" &&
    typeof binding.closeProcessHandles === "function" &&
    typeof binding.closeJob === "function"
  );
}

export function loadBundledWindowsJobObjectBinding(input?: {
  moduleUrl?: string;
  load?: BindingLoader;
}): BundledWindowsJobObjectBinding {
  const load = input?.load ?? createRequire(import.meta.url);
  const candidate = resolveBundledWindowsJobObjectBindingPath(input?.moduleUrl);
  try {
    const loaded = load(candidate);
    if (!isBinding(loaded)) {
      throw new Error("incompatible ABI");
    }
    return loaded;
  } catch (error) {
    throw new Error(
      `bundled Windows Job Object bridge is unavailable; native Windows execution was refused (${candidate}: ${error instanceof Error ? error.message : String(error)})`,
      { cause: error },
    );
  }
}

function quoteWindowsArgument(argument: string): string {
  if (argument.length > 0 && !/[\s"]/u.test(argument)) {
    return argument;
  }
  let quoted = '"';
  let backslashes = 0;
  for (const character of argument) {
    if (character === "\\") {
      backslashes += 1;
      continue;
    }
    if (character === '"') {
      quoted += "\\".repeat(backslashes * 2 + 1) + '"';
      backslashes = 0;
      continue;
    }
    quoted += "\\".repeat(backslashes) + character;
    backslashes = 0;
  }
  return `${quoted}${"\\".repeat(backslashes * 2)}"`;
}

export function buildWindowsCommandLine(argv: string[], verbatim = false): string {
  if (argv.length === 0 || !argv[0]?.trim()) {
    throw new Error("Windows native process argv cannot be empty");
  }
  return verbatim ? argv.join(" ") : argv.map(quoteWindowsArgument).join(" ");
}

function toEnvironmentEntries(env: NodeJS.ProcessEnv): string[] {
  return Object.entries(env)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string")
    .map(([key, value]) => `${key}=${value}`)
    .toSorted((left, right) => left.localeCompare(right, undefined, { sensitivity: "base" }));
}

function createReadableFd(fd: number): fs.ReadStream {
  return fs.createReadStream("", { fd, autoClose: true });
}

function createWritableFd(fd: number): fs.WriteStream {
  return fs.createWriteStream("", { fd, autoClose: true });
}

type NativeDescriptorOwnership = {
  transfer: (fd: number) => void;
};

type NativeAdapterStreamFactory = {
  createReadable: (fd: number) => fs.ReadStream;
  createWritable: (fd: number) => fs.WriteStream;
};

const defaultNativeAdapterStreamFactory: NativeAdapterStreamFactory = {
  createReadable: createReadableFd,
  createWritable: createWritableFd,
};

function createNativeAdapter(
  binding: BundledWindowsJobObjectBinding,
  descriptor: NativeProcessDescriptor,
  input?: string,
  stdinMode: "inherit" | "pipe-open" | "pipe-closed" = "inherit",
  ownership?: NativeDescriptorOwnership,
  streams: NativeAdapterStreamFactory = defaultNativeAdapterStreamFactory,
): SpawnProcessAdapter {
  let stdout: fs.ReadStream | undefined;
  let stderr: fs.ReadStream | undefined;
  let stdinStream: fs.WriteStream | undefined;
  try {
    stdout = streams.createReadable(descriptor.stdoutFd);
    ownership?.transfer(descriptor.stdoutFd);
    stderr = streams.createReadable(descriptor.stderrFd);
    ownership?.transfer(descriptor.stderrFd);
    stdinStream =
      descriptor.stdinFd === undefined ? undefined : streams.createWritable(descriptor.stdinFd);
    if (descriptor.stdinFd !== undefined) {
      ownership?.transfer(descriptor.stdinFd);
    }
  } catch (error) {
    stdout?.destroy();
    stderr?.destroy();
    stdinStream?.destroy();
    throw error;
  }
  if (stdinStream) {
    if (input !== undefined) {
      stdinStream.end(input);
    } else if (stdinMode === "pipe-closed") {
      stdinStream.end();
    }
  }
  const stdin: ManagedRunStdin | undefined = stdinStream
    ? {
        get destroyed() {
          return stdinStream.destroyed;
        },
        write: (data, callback) => stdinStream.write(data, callback),
        end: () => stdinStream.end(),
        destroy: () => stdinStream.destroy(),
      }
    : undefined;
  let disposed = false;
  return {
    pid: descriptor.pid,
    stdin,
    onStdout: (listener) => stdout.on("data", (chunk) => listener(chunk.toString())),
    onStderr: (listener) => stderr.on("data", (chunk) => listener(chunk.toString())),
    wait: async () => {
      while (true) {
        const exitCode = binding.queryProcessExit(descriptor.processToken);
        if (exitCode !== undefined) {
          return { code: exitCode, signal: null };
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 20));
      }
    },
    kill: () => binding.terminateProcess(descriptor.processToken, 1),
    dispose: () => {
      if (disposed) {
        return;
      }
      disposed = true;
      stdout.destroy();
      stderr.destroy();
      stdinStream?.destroy();
    },
  };
}

export function createBundledWindowsNativeJobBridge(
  binding: BundledWindowsJobObjectBinding,
  options?: {
    streams?: NativeAdapterStreamFactory;
  },
): WindowsNativeJobBridge {
  return {
    createJob: async (jobName): Promise<WindowsJobHandle> => ({
      handle: binding.createJob(jobName),
      jobName,
    }),
    openJob: async (jobName) => {
      const handle = binding.openJob(jobName);
      return handle ? { handle, jobName } : undefined;
    },
    setKillOnJobClose: async (job) => binding.setKillOnJobClose(job.handle),
    createProcessSuspended: async ({ run, env }): Promise<WindowsSuspendedProcess> => {
      if (run.mode !== "child") {
        throw new Error("bundled Windows Job Object bridge does not yet support ConPTY launches");
      }
      const stdinMode = run.stdinMode ?? (run.input !== undefined ? "pipe-closed" : "inherit");
      const descriptor = binding.createProcessSuspended({
        commandLine: buildWindowsCommandLine(run.argv, run.windowsVerbatimArguments),
        cwd: run.cwd,
        environment: toEnvironmentEntries(env),
        stdinMode,
      });
      const untransferredDescriptors = new Set(
        [descriptor.stdinFd, descriptor.stdoutFd, descriptor.stderrFd].filter(
          (fd): fd is number => fd !== undefined,
        ),
      );
      const ownership: NativeDescriptorOwnership = {
        transfer: (fd) => {
          if (!untransferredDescriptors.delete(fd)) {
            throw new Error(`Windows native descriptor ${fd} was transferred more than once`);
          }
        },
      };
      let adapter: SpawnProcessAdapter;
      try {
        adapter = createNativeAdapter(
          binding,
          descriptor,
          run.input,
          stdinMode,
          ownership,
          options?.streams,
        );
        if (untransferredDescriptors.size > 0) {
          adapter.dispose();
          throw new Error("Windows native adapter did not accept every CRT descriptor");
        }
      } catch (error) {
        const rollbackErrors: unknown[] = [error];
        for (const fd of untransferredDescriptors) {
          try {
            fs.closeSync(fd);
          } catch (closeError) {
            rollbackErrors.push(closeError);
          }
        }
        try {
          binding.terminateProcess(descriptor.processToken, 1);
        } catch (terminateError) {
          rollbackErrors.push(terminateError);
        }
        try {
          binding.closeProcessHandles(descriptor.processToken, descriptor.primaryThreadToken);
        } catch (closeHandlesError) {
          rollbackErrors.push(closeHandlesError);
        }
        const rollbackFailureSummary = rollbackErrors
          .slice(1)
          .map((rollbackError) =>
            rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
          )
          .join("; ");
        throw new Error(
          `failed to construct the Windows native process adapter${rollbackFailureSummary ? `; rollback failures: ${rollbackFailureSummary}` : ""}`,
          { cause: error },
        );
      }
      return {
        pid: descriptor.pid,
        creationTime: descriptor.creationTime,
        processHandle: descriptor.processToken,
        primaryThreadHandle: descriptor.primaryThreadToken,
        adapter,
      };
    },
    assignProcess: async (job, process) => binding.assignProcess(job.handle, process.processHandle),
    resumePrimaryThread: async (process) =>
      binding.resumePrimaryThread(process.primaryThreadHandle),
    queryJob: async (job) => binding.queryJob(job.handle),
    queryProcessIdentity: async (pid) => binding.queryProcessIdentity(pid),
    terminateProcess: async (process, exitCode) =>
      binding.terminateProcess(process.processHandle, exitCode),
    terminateJob: async (job, exitCode) => binding.terminateJob(job.handle, exitCode),
    waitForJobEmpty: async (job, timeoutMs) => {
      const deadlineAt = Date.now() + Math.max(1, timeoutMs);
      while (Date.now() < deadlineAt) {
        if (binding.queryJob(job.handle).activeProcessCount === 0) {
          return true;
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 20));
      }
      return binding.queryJob(job.handle).activeProcessCount === 0;
    },
    closeProcessHandles: async (process) => {
      binding.closeProcessHandles(process.processHandle, process.primaryThreadHandle);
    },
    closeJob: async (job) => binding.closeJob(job.handle),
  };
}

export function createDefaultWindowsProcessOwner(input?: {
  platform?: NodeJS.Platform;
  loadBinding?: () => BundledWindowsJobObjectBinding;
}): WindowsProcessOwner | undefined {
  if ((input?.platform ?? process.platform) !== "win32") {
    return undefined;
  }
  const binding = (input?.loadBinding ?? loadBundledWindowsJobObjectBinding)();
  return createWindowsProcessOwner(createBundledWindowsNativeJobBridge(binding));
}

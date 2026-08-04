import path from "node:path";
import { resolveStateDir } from "../../config/paths.js";
import { createProcessSupervisor } from "./supervisor.js";
import type { ProcessSupervisor } from "./types.js";
import { createDefaultWindowsProcessOwner } from "./windows-native-job-bridge.js";

let singleton: ProcessSupervisor | null = null;

export function getProcessSupervisor(): ProcessSupervisor {
  if (singleton) {
    return singleton;
  }
  singleton = createProcessSupervisor({
    journalPath: path.join(resolveStateDir(), "process-supervisor-owned.json"),
    windowsProcessOwner: createDefaultWindowsProcessOwner(),
  });
  return singleton;
}

export { createProcessSupervisor } from "./supervisor.js";
export { createWindowsProcessOwner } from "./windows-process-owner.js";
export {
  createBundledWindowsNativeJobBridge,
  createDefaultWindowsProcessOwner,
  loadBundledWindowsJobObjectBinding,
} from "./windows-native-job-bridge.js";
export type {
  ManagedRun,
  ProcessSupervisor,
  ProcessCancellationResult,
  RunExit,
  RunRecord,
  RunState,
  SpawnInput,
  SpawnMode,
  TerminationReason,
} from "./types.js";
export type {
  WindowsJobIdentity,
  WindowsNativeJobBridge,
  WindowsOwnedProcess,
  WindowsProcessOwner,
  WindowsRestartReconciliation,
} from "./windows-process-owner.js";

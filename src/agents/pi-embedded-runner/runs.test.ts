import { afterEach, describe, expect, it, vi } from "vitest";
import { importFreshModule } from "../../../test/helpers/import-fresh.js";
import { getProcessSupervisor } from "../../process/supervisor/index.js";
import {
  __testing,
  abortEmbeddedPiRunByRunId,
  abortEmbeddedPiRun,
  clearActiveEmbeddedRun,
  getActiveEmbeddedRunSnapshot,
  isEmbeddedPiRunActive,
  setActiveEmbeddedRun,
  updateActiveEmbeddedRunSnapshot,
  waitForActiveEmbeddedRuns,
} from "./runs.js";

describe("pi-embedded runner run registry", () => {
  afterEach(() => {
    __testing.resetActiveEmbeddedRuns();
    vi.restoreAllMocks();
  });

  it("aborts only compacting runs in compacting mode", () => {
    const abortCompacting = vi.fn();
    const abortNormal = vi.fn();

    setActiveEmbeddedRun("session-compacting", {
      queueMessage: async () => {},
      isStreaming: () => true,
      isCompacting: () => true,
      abort: abortCompacting,
    });

    setActiveEmbeddedRun("session-normal", {
      queueMessage: async () => {},
      isStreaming: () => true,
      isCompacting: () => false,
      abort: abortNormal,
    });

    const aborted = abortEmbeddedPiRun(undefined, { mode: "compacting" });
    expect(aborted).toBe(true);
    expect(abortCompacting).toHaveBeenCalledTimes(1);
    expect(abortNormal).not.toHaveBeenCalled();
  });

  it("aborts every active run in all mode", () => {
    const abortA = vi.fn();
    const abortB = vi.fn();

    setActiveEmbeddedRun("session-a", {
      queueMessage: async () => {},
      isStreaming: () => true,
      isCompacting: () => true,
      abort: abortA,
    });

    setActiveEmbeddedRun("session-b", {
      queueMessage: async () => {},
      isStreaming: () => true,
      isCompacting: () => false,
      abort: abortB,
    });

    const aborted = abortEmbeddedPiRun(undefined, { mode: "all" });
    expect(aborted).toBe(true);
    expect(abortA).toHaveBeenCalledTimes(1);
    expect(abortB).toHaveBeenCalledTimes(1);
  });

  it("waits for active runs to drain", async () => {
    vi.useFakeTimers();
    try {
      const handle = {
        queueMessage: async () => {},
        isStreaming: () => true,
        isCompacting: () => false,
        abort: vi.fn(),
      };
      setActiveEmbeddedRun("session-a", handle);
      setTimeout(() => {
        clearActiveEmbeddedRun("session-a", handle);
      }, 500);

      const waitPromise = waitForActiveEmbeddedRuns(1_000, { pollMs: 100 });
      await vi.advanceTimersByTimeAsync(500);
      const result = await waitPromise;

      expect(result.drained).toBe(true);
    } finally {
      await vi.runOnlyPendingTimersAsync();
      vi.useRealTimers();
    }
  });

  it("returns drained=false when timeout elapses", async () => {
    vi.useFakeTimers();
    try {
      setActiveEmbeddedRun("session-a", {
        queueMessage: async () => {},
        isStreaming: () => true,
        isCompacting: () => false,
        abort: vi.fn(),
      });

      const waitPromise = waitForActiveEmbeddedRuns(1_000, { pollMs: 100 });
      await vi.advanceTimersByTimeAsync(1_000);
      const result = await waitPromise;
      expect(result.drained).toBe(false);
    } finally {
      await vi.runOnlyPendingTimersAsync();
      vi.useRealTimers();
    }
  });

  it("shares active run state across distinct module instances", async () => {
    const runsA = await importFreshModule<typeof import("./runs.js")>(
      import.meta.url,
      "./runs.js?scope=shared-a",
    );
    const runsB = await importFreshModule<typeof import("./runs.js")>(
      import.meta.url,
      "./runs.js?scope=shared-b",
    );
    const handle = {
      queueMessage: async () => {},
      isStreaming: () => true,
      isCompacting: () => false,
      abort: vi.fn(),
    };

    runsA.__testing.resetActiveEmbeddedRuns();
    runsB.__testing.resetActiveEmbeddedRuns();

    try {
      runsA.setActiveEmbeddedRun("session-shared", handle);
      expect(runsB.isEmbeddedPiRunActive("session-shared")).toBe(true);

      runsB.clearActiveEmbeddedRun("session-shared", handle);
      expect(runsA.isEmbeddedPiRunActive("session-shared")).toBe(false);
    } finally {
      runsA.__testing.resetActiveEmbeddedRuns();
      runsB.__testing.resetActiveEmbeddedRuns();
    }
  });

  it("tracks and clears per-session transcript snapshots for active runs", () => {
    const handle = {
      queueMessage: async () => {},
      isStreaming: () => true,
      isCompacting: () => false,
      abort: vi.fn(),
    };

    setActiveEmbeddedRun("session-snapshot", handle);
    updateActiveEmbeddedRunSnapshot("session-snapshot", {
      transcriptLeafId: "assistant-1",
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }], timestamp: 1 }],
      inFlightPrompt: "keep going",
    });
    expect(getActiveEmbeddedRunSnapshot("session-snapshot")).toEqual({
      transcriptLeafId: "assistant-1",
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }], timestamp: 1 }],
      inFlightPrompt: "keep going",
    });

    clearActiveEmbeddedRun("session-snapshot", handle);
    expect(getActiveEmbeddedRunSnapshot("session-snapshot")).toBeUndefined();
  });

  it("cancels one run without affecting another active run", async () => {
    const abortA = vi.fn();
    const abortB = vi.fn();
    const handleA = {
      runId: "run-a",
      processScopeKey: "run:run-a",
      queueMessage: async () => {},
      isStreaming: () => true,
      isCompacting: () => false,
      abort: abortA,
    };
    const handleB = {
      runId: "run-b",
      processScopeKey: "run:run-b",
      queueMessage: async () => {},
      isStreaming: () => true,
      isCompacting: () => false,
      abort: abortB,
    };
    abortA.mockImplementation(() => clearActiveEmbeddedRun("session-a", handleA));
    setActiveEmbeddedRun("session-a", handleA, "tenant:session-a");
    setActiveEmbeddedRun("session-b", handleB, "tenant:session-b");

    const result = await abortEmbeddedPiRunByRunId("run-a", {
      deadlineMs: 500,
      expectedSessionKey: "tenant:session-a",
    });

    expect(result.acknowledged).toBe(true);
    expect(result.runDrained).toBe(true);
    expect(result.teardownComplete).toBe(true);
    expect(result.sessionKey).toBe("tenant:session-a");
    expect(abortA).toHaveBeenCalledTimes(1);
    expect(abortB).not.toHaveBeenCalled();
    expect(isEmbeddedPiRunActive("session-b")).toBe(true);
  });

  it("does not abort a run when the expected session key does not match", async () => {
    const abort = vi.fn();
    const handle = {
      runId: "run-a",
      processScopeKey: "run:run-a",
      queueMessage: async () => {},
      isStreaming: () => true,
      isCompacting: () => false,
      abort,
    };
    setActiveEmbeddedRun("session-a", handle, "tenant:session-a");

    const result = await abortEmbeddedPiRunByRunId("run-a", {
      deadlineMs: 500,
      expectedSessionKey: "tenant:different",
    });

    expect(result).toMatchObject({
      acknowledged: false,
      runDrained: false,
      teardownComplete: false,
    });
    expect(abort).not.toHaveBeenCalled();
    expect(isEmbeddedPiRunActive("session-a")).toBe(true);
  });

  it("accepts exact durable teardown proof when the embedded registry was lost on restart", async () => {
    const supervisor = getProcessSupervisor();
    const consume = vi.spyOn(supervisor, "consumeVerifiedTeardownReceipt").mockResolvedValue({
      requested: true,
      matchedRunIds: ["owned-process-run"],
      terminatedRunIds: ["owned-process-run"],
      remainingRunIds: [],
      deadlineMs: 0,
      elapsedMs: 2,
      teardownComplete: true,
    });

    const result = await abortEmbeddedPiRunByRunId("canonical-run", {
      deadlineMs: 500,
      expectedSessionKey: "tenant:session-a",
      forceProcessTeardown: true,
    });

    expect(consume).toHaveBeenCalledWith("run:canonical-run", "tenant:session-a");
    expect(result).toMatchObject({
      runId: "canonical-run",
      sessionKey: "tenant:session-a",
      acknowledged: true,
      cooperativeAbortRequested: false,
      runDrained: true,
      teardownComplete: true,
      processTeardown: { teardownComplete: true },
    });
  });
});

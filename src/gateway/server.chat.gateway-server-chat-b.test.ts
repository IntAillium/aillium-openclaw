import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test, vi } from "vitest";
import {
  __testing as embeddedRunsTesting,
  clearActiveEmbeddedRun,
  setActiveEmbeddedRun,
} from "../agents/pi-embedded-runner/runs.js";
import type { GetReplyOptions } from "../auto-reply/types.js";
import { getProcessSupervisor } from "../process/supervisor/index.js";
import { signForceAbortAuthority } from "./aillium-force-abort-authority.js";
import { __setMaxChatHistoryMessagesBytesForTest } from "./server-constants.js";
import {
  connectOk,
  getReplyFromConfig,
  installGatewayTestHooks,
  onceMessage,
  rpcReq,
  startServerWithClient,
  testState,
  writeSessionStore,
} from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });
const FAST_WAIT_OPTS = { timeout: 250, interval: 2 } as const;

const sendReq = (
  ws: { send: (payload: string) => void },
  id: string,
  method: string,
  params: unknown,
) => {
  ws.send(
    JSON.stringify({
      type: "req",
      id,
      method,
      params,
    }),
  );
};

async function withGatewayChatHarness(
  run: (ctx: {
    ws: Awaited<ReturnType<typeof startServerWithClient>>["ws"];
    createSessionDir: () => Promise<string>;
  }) => Promise<void>,
) {
  const tempDirs: string[] = [];
  const { server, ws } = await startServerWithClient();
  const createSessionDir = async () => {
    const sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-gw-"));
    tempDirs.push(sessionDir);
    testState.sessionStorePath = path.join(sessionDir, "sessions.json");
    return sessionDir;
  };

  try {
    await run({ ws, createSessionDir });
  } finally {
    __setMaxChatHistoryMessagesBytesForTest();
    testState.sessionStorePath = undefined;
    ws.close();
    await server.close();
    await Promise.all(tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
  }
}

async function writeMainSessionStore() {
  await writeSessionStore({
    entries: {
      main: { sessionId: "sess-main", updatedAt: Date.now() },
    },
  });
}

async function writeMainSessionTranscript(sessionDir: string, lines: string[]) {
  await fs.writeFile(path.join(sessionDir, "sess-main.jsonl"), `${lines.join("\n")}\n`, "utf-8");
}

async function fetchHistoryMessages(
  ws: Awaited<ReturnType<typeof startServerWithClient>>["ws"],
): Promise<unknown[]> {
  const historyRes = await rpcReq<{ messages?: unknown[] }>(ws, "chat.history", {
    sessionKey: "main",
    limit: 1000,
  });
  expect(historyRes.ok).toBe(true);
  return historyRes.payload?.messages ?? [];
}

async function prepareMainHistoryHarness(params: {
  ws: Awaited<ReturnType<typeof startServerWithClient>>["ws"];
  createSessionDir: () => Promise<string>;
  historyMaxBytes?: number;
}) {
  if (params.historyMaxBytes !== undefined) {
    __setMaxChatHistoryMessagesBytesForTest(params.historyMaxBytes);
  }
  await connectOk(params.ws);
  const sessionDir = await params.createSessionDir();
  await writeMainSessionStore();
  return sessionDir;
}

describe("gateway server chat", () => {
  test("smoke: caps history payload and preserves routing metadata", async () => {
    await withGatewayChatHarness(async ({ ws, createSessionDir }) => {
      const historyMaxBytes = 64 * 1024;
      const sessionDir = await prepareMainHistoryHarness({
        ws,
        createSessionDir,
        historyMaxBytes,
      });

      const bigText = "x".repeat(2_000);
      const historyLines: string[] = [];
      for (let i = 0; i < 45; i += 1) {
        historyLines.push(
          JSON.stringify({
            message: {
              role: "user",
              content: [{ type: "text", text: `${i}:${bigText}` }],
              timestamp: Date.now() + i,
            },
          }),
        );
      }
      await writeMainSessionTranscript(sessionDir, historyLines);
      const messages = await fetchHistoryMessages(ws);
      const bytes = Buffer.byteLength(JSON.stringify(messages), "utf8");
      expect(bytes).toBeLessThanOrEqual(historyMaxBytes);
      expect(messages.length).toBeLessThan(45);

      await writeSessionStore({
        entries: {
          main: {
            sessionId: "sess-main",
            updatedAt: Date.now(),
            lastChannel: "whatsapp",
            lastTo: "+1555",
          },
        },
      });

      const sendRes = await rpcReq(ws, "chat.send", {
        sessionKey: "main",
        message: "hello",
        idempotencyKey: "idem-route",
      });
      expect(sendRes.ok).toBe(true);

      const sessionStorePath = testState.sessionStorePath;
      if (!sessionStorePath) {
        throw new Error("expected session store path");
      }
      const stored = JSON.parse(await fs.readFile(sessionStorePath, "utf-8")) as Record<
        string,
        { lastChannel?: string; lastTo?: string } | undefined
      >;
      expect(stored["agent:main:main"]?.lastChannel).toBe("whatsapp");
      expect(stored["agent:main:main"]?.lastTo).toBe("+1555");
    });
  });

  test("chat.send does not force-disable block streaming", async () => {
    await withGatewayChatHarness(async ({ ws, createSessionDir }) => {
      const spy = getReplyFromConfig;
      await connectOk(ws);

      await createSessionDir();
      await writeMainSessionStore();
      testState.agentConfig = { blockStreamingDefault: "on" };
      try {
        spy.mockClear();
        let capturedOpts: GetReplyOptions | undefined;
        spy.mockImplementationOnce(async (_ctx: unknown, opts?: GetReplyOptions) => {
          capturedOpts = opts;
          return undefined;
        });

        const sendRes = await rpcReq(ws, "chat.send", {
          sessionKey: "main",
          message: "hello",
          idempotencyKey: "idem-block-streaming",
        });
        expect(sendRes.ok).toBe(true);

        await vi.waitFor(() => {
          expect(spy.mock.calls.length).toBeGreaterThan(0);
        }, FAST_WAIT_OPTS);

        expect(capturedOpts?.disableBlockStreaming).toBeUndefined();
      } finally {
        testState.agentConfig = undefined;
      }
    });
  });

  test("chat.history hard-caps single oversized nested payloads", async () => {
    await withGatewayChatHarness(async ({ ws, createSessionDir }) => {
      const historyMaxBytes = 64 * 1024;
      const sessionDir = await prepareMainHistoryHarness({
        ws,
        createSessionDir,
        historyMaxBytes,
      });

      const hugeNestedText = "n".repeat(120_000);
      const oversizedLine = JSON.stringify({
        message: {
          role: "assistant",
          timestamp: Date.now(),
          content: [
            {
              type: "tool_result",
              toolUseId: "tool-1",
              output: {
                nested: {
                  payload: hugeNestedText,
                },
              },
            },
          ],
        },
      });
      await writeMainSessionTranscript(sessionDir, [oversizedLine]);
      const messages = await fetchHistoryMessages(ws);
      expect(messages.length).toBe(1);

      const serialized = JSON.stringify(messages);
      const bytes = Buffer.byteLength(serialized, "utf8");
      expect(bytes).toBeLessThanOrEqual(historyMaxBytes);
      expect(serialized).toContain("[chat.history omitted: message too large]");
      expect(serialized.includes(hugeNestedText.slice(0, 256))).toBe(false);
    });
  });

  test("chat.history keeps recent small messages when latest message is oversized", async () => {
    await withGatewayChatHarness(async ({ ws, createSessionDir }) => {
      const historyMaxBytes = 64 * 1024;
      const sessionDir = await prepareMainHistoryHarness({
        ws,
        createSessionDir,
        historyMaxBytes,
      });

      const baseText = "s".repeat(1_200);
      const lines: string[] = [];
      for (let i = 0; i < 30; i += 1) {
        lines.push(
          JSON.stringify({
            message: {
              role: "user",
              timestamp: Date.now() + i,
              content: [{ type: "text", text: `small-${i}:${baseText}` }],
            },
          }),
        );
      }

      const hugeNestedText = "z".repeat(120_000);
      lines.push(
        JSON.stringify({
          message: {
            role: "assistant",
            timestamp: Date.now() + 1_000,
            content: [
              {
                type: "tool_result",
                toolUseId: "tool-1",
                output: {
                  nested: {
                    payload: hugeNestedText,
                  },
                },
              },
            ],
          },
        }),
      );

      await writeMainSessionTranscript(sessionDir, lines);
      const messages = await fetchHistoryMessages(ws);
      const serialized = JSON.stringify(messages);
      const bytes = Buffer.byteLength(serialized, "utf8");

      expect(bytes).toBeLessThanOrEqual(historyMaxBytes);
      expect(messages.length).toBeGreaterThan(1);
      expect(serialized).toContain("small-29:");
      expect(serialized).toContain("[chat.history omitted: message too large]");
      expect(serialized.includes(hugeNestedText.slice(0, 256))).toBe(false);
    });
  });

  test("chat.history preserves usage and cost metadata for assistant messages", async () => {
    await withGatewayChatHarness(async ({ ws, createSessionDir }) => {
      await connectOk(ws);

      const sessionDir = await createSessionDir();
      await writeMainSessionStore();

      await writeMainSessionTranscript(sessionDir, [
        JSON.stringify({
          message: {
            role: "assistant",
            timestamp: Date.now(),
            content: [{ type: "text", text: "hello" }],
            usage: { input: 12, output: 5, totalTokens: 17 },
            cost: { total: 0.0123 },
            details: { debug: true },
          },
        }),
      ]);

      const messages = await fetchHistoryMessages(ws);
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({
        role: "assistant",
        usage: { input: 12, output: 5, totalTokens: 17 },
        cost: { total: 0.0123 },
      });
      expect(messages[0]).not.toHaveProperty("details");
    });
  });

  test("chat.history strips inline directives from displayed message text", async () => {
    await withGatewayChatHarness(async ({ ws, createSessionDir }) => {
      await connectOk(ws);

      const sessionDir = await createSessionDir();
      await writeMainSessionStore();

      const lines = [
        JSON.stringify({
          message: {
            role: "assistant",
            content: [
              { type: "text", text: "Hello [[reply_to_current]] world [[audio_as_voice]]" },
            ],
            timestamp: Date.now(),
          },
        }),
        JSON.stringify({
          message: {
            role: "assistant",
            content: "A [[reply_to:abc-123]] B",
            timestamp: Date.now() + 1,
          },
        }),
        JSON.stringify({
          message: {
            role: "assistant",
            text: "[[ reply_to : 456 ]] C",
            timestamp: Date.now() + 2,
          },
        }),
        JSON.stringify({
          message: {
            role: "assistant",
            content: [{ type: "text", text: "  keep padded  " }],
            timestamp: Date.now() + 3,
          },
        }),
      ];
      await writeMainSessionTranscript(sessionDir, lines);
      const messages = await fetchHistoryMessages(ws);
      expect(messages.length).toBe(4);

      const serialized = JSON.stringify(messages);
      expect(serialized.includes("[[reply_to")).toBe(false);
      expect(serialized.includes("[[audio_as_voice]]")).toBe(false);

      const first = messages[0] as { content?: Array<{ text?: string }> };
      const second = messages[1] as { content?: string };
      const third = messages[2] as { text?: string };
      const fourth = messages[3] as { content?: Array<{ text?: string }> };

      expect(first.content?.[0]?.text?.replace(/\s+/g, " ").trim()).toBe("Hello world");
      expect(second.content?.replace(/\s+/g, " ").trim()).toBe("A B");
      expect(third.text?.replace(/\s+/g, " ").trim()).toBe("C");
      expect(fourth.content?.[0]?.text).toBe("  keep padded  ");
    });
  });

  test("smoke: supports abort and idempotent completion", async () => {
    await withGatewayChatHarness(async ({ ws, createSessionDir }) => {
      const spy = getReplyFromConfig;
      let aborted = false;
      await connectOk(ws);

      await createSessionDir();
      await writeMainSessionStore();

      spy.mockClear();
      spy.mockImplementationOnce(async (_ctx, opts) => {
        opts?.onAgentRunStart?.(opts.runId ?? "idem-abort-1");
        const signal = opts?.abortSignal;
        await new Promise<void>((resolve) => {
          if (!signal || signal.aborted) {
            aborted = Boolean(signal?.aborted);
            resolve();
            return;
          }
          signal.addEventListener(
            "abort",
            () => {
              aborted = true;
              resolve();
            },
            { once: true },
          );
        });
        return undefined;
      });

      const sendResP = onceMessage(ws, (o) => o.type === "res" && o.id === "send-abort-1", 2_000);
      sendReq(ws, "send-abort-1", "chat.send", {
        sessionKey: "main",
        message: "hello",
        idempotencyKey: "idem-abort-1",
        timeoutMs: 30_000,
      });

      const sendRes = await sendResP;
      expect(sendRes.ok).toBe(true);
      await vi.waitFor(() => {
        expect(spy.mock.calls.length).toBeGreaterThan(0);
      }, FAST_WAIT_OPTS);

      const inFlight = await rpcReq<{ status?: string }>(ws, "chat.send", {
        sessionKey: "main",
        message: "hello",
        idempotencyKey: "idem-abort-1",
      });
      expect(inFlight.ok).toBe(true);
      expect(["started", "in_flight", "ok"]).toContain(inFlight.payload?.status ?? "");

      const abortRes = await rpcReq<{
        aborted?: boolean;
        cancellation?: {
          acknowledged?: boolean;
          runDrained?: boolean;
          teardownComplete?: boolean;
          observedWithinMs?: number;
        };
      }>(ws, "chat.abort", {
        sessionKey: "main",
        runId: "idem-abort-1",
      });
      expect(abortRes.ok).toBe(true);
      expect(abortRes.payload?.aborted).toBe(true);
      expect(abortRes.payload?.cancellation?.observedWithinMs).toBeLessThan(2_000);
      await vi.waitFor(() => {
        expect(aborted).toBe(true);
      }, FAST_WAIT_OPTS);

      spy.mockClear();
      spy.mockResolvedValueOnce(undefined);

      const completeRes = await rpcReq<{ status?: string }>(ws, "chat.send", {
        sessionKey: "main",
        message: "hello",
        idempotencyKey: "idem-complete-1",
      });
      expect(completeRes.ok).toBe(true);

      await vi.waitFor(async () => {
        const again = await rpcReq<{ status?: string }>(ws, "chat.send", {
          sessionKey: "main",
          message: "hello",
          idempotencyKey: "idem-complete-1",
        });
        expect(again.ok).toBe(true);
        expect(again.payload?.status).toBe("ok");
      }, FAST_WAIT_OPTS);
    });
  });

  test("force-aborts an exact embedded run after the chat controller entry is gone", async () => {
    await withGatewayChatHarness(async ({ ws }) => {
      vi.stubEnv("AILLIUM_FORCE_ABORT_SIGNING_SECRET", "force-runtime-secret");
      await connectOk(ws);
      const abort = vi.fn();
      const handle = {
        runId: "force-run-1",
        processScopeKey: "run:force-run-1",
        queueMessage: async () => {},
        isStreaming: () => true,
        isCompacting: () => false,
        abort,
      };
      abort.mockImplementation(() => clearActiveEmbeddedRun("force-session-id", handle, "main"));
      setActiveEmbeddedRun("force-session-id", handle, "main");
      const supervisor = getProcessSupervisor();
      const managedProcess = await supervisor.spawn({
        mode: "child",
        argv: [process.execPath, "-e", "setInterval(() => {}, 1000)"],
        sessionId: "force-session-id",
        backendId: "force-test-child",
        runId: "force-process-1",
        scopeKey: "run:force-run-1",
        stdinMode: "pipe-closed",
      });
      try {
        const result = await rpcReq<{
          ok?: boolean;
          aborted?: boolean;
          runIds?: string[];
          sessionKey?: string;
          runId?: string;
          runtimeVerified?: boolean;
          teardownComplete?: boolean;
          active?: boolean;
          cancellation?: {
            processTeardown?: {
              matchedRunIds?: string[];
              terminatedRunIds?: string[];
              remainingRunIds?: string[];
            };
          };
        }>(ws, "chat.abort", {
          sessionKey: "main",
          runId: "force-run-1",
          force: true,
          deadlineMs: 650,
          forceAuthority: signForceAbortAuthority({
            secret: "force-runtime-secret",
            tenantId: "tenant-1",
            sessionKey: "main",
            runId: "force-run-1",
            fenceToken: "7",
            cancellationGeneration: 1,
          }),
        });
        expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
        expect(result.payload).toMatchObject({
          ok: true,
          aborted: true,
          runIds: ["force-run-1"],
          sessionKey: "main",
          runId: "force-run-1",
          runtimeVerified: true,
          teardownComplete: true,
          active: false,
        });
        expect(abort).toHaveBeenCalledTimes(1);
        expect(result.payload?.cancellation?.processTeardown).toMatchObject({
          matchedRunIds: ["force-process-1"],
          terminatedRunIds: ["force-process-1"],
          remainingRunIds: [],
        });
        await expect(managedProcess.wait()).resolves.toMatchObject({ reason: "manual-cancel" });
      } finally {
        await supervisor.cancelScopeAndWait("run:force-run-1", { deadlineMs: 1_000 });
        embeddedRunsTesting.resetActiveEmbeddedRuns();
        vi.unstubAllEnvs();
      }
    });
  });

  test("force abort does not touch an embedded run under a different session key", async () => {
    await withGatewayChatHarness(async ({ ws }) => {
      vi.stubEnv("AILLIUM_FORCE_ABORT_SIGNING_SECRET", "force-runtime-secret");
      await connectOk(ws);
      const abort = vi.fn();
      const handle = {
        runId: "force-run-mismatch",
        processScopeKey: "run:force-run-mismatch",
        queueMessage: async () => {},
        isStreaming: () => true,
        isCompacting: () => false,
        abort,
      };
      setActiveEmbeddedRun("force-session-id", handle, "tenant:other");
      try {
        const result = await rpcReq<{ runtimeVerified?: boolean }>(ws, "chat.abort", {
          sessionKey: "main",
          runId: "force-run-mismatch",
          force: true,
          deadlineMs: 650,
          forceAuthority: signForceAbortAuthority({
            secret: "force-runtime-secret",
            tenantId: "tenant-1",
            sessionKey: "main",
            runId: "force-run-mismatch",
            fenceToken: "8",
            cancellationGeneration: 2,
          }),
        });
        expect(result.ok).toBe(true);
        expect(result.payload?.runtimeVerified).toBe(false);
        expect(abort).not.toHaveBeenCalled();
      } finally {
        embeddedRunsTesting.resetActiveEmbeddedRuns();
        vi.unstubAllEnvs();
      }
    });
  });

  test("rejects force abort without an exact run id", async () => {
    await withGatewayChatHarness(async ({ ws }) => {
      await connectOk(ws);
      const result = await rpcReq(ws, "chat.abort", {
        sessionKey: "main",
        force: true,
      });
      expect(result.ok).toBe(false);
    });
  });

  test("does not accept a force authority minted with the generic gateway runtime token", async () => {
    await withGatewayChatHarness(async ({ ws }) => {
      vi.stubEnv("AILLIUM_RUNTIME_TOKEN", "generic-runtime-secret");
      vi.stubEnv("AILLIUM_FORCE_ABORT_SIGNING_SECRET", "dedicated-force-secret");
      await connectOk(ws);
      try {
        const result = await rpcReq(ws, "chat.abort", {
          sessionKey: "main",
          runId: "force-run-generic-secret",
          force: true,
          deadlineMs: 650,
          forceAuthority: signForceAbortAuthority({
            secret: "generic-runtime-secret",
            tenantId: "tenant-1",
            sessionKey: "main",
            runId: "force-run-generic-secret",
            fenceToken: "9",
            cancellationGeneration: 3,
          }),
        });
        expect(result.ok).toBe(false);
      } finally {
        vi.unstubAllEnvs();
      }
    });
  });

  test("rejects a valid Core force authority bound to a different session", async () => {
    await withGatewayChatHarness(async ({ ws }) => {
      vi.stubEnv("AILLIUM_FORCE_ABORT_SIGNING_SECRET", "dedicated-force-secret");
      await connectOk(ws);
      try {
        const result = await rpcReq(ws, "chat.abort", {
          sessionKey: "main",
          runId: "force-run-wrong-session",
          force: true,
          deadlineMs: 650,
          forceAuthority: signForceAbortAuthority({
            secret: "dedicated-force-secret",
            tenantId: "tenant-1",
            sessionKey: "other-session",
            runId: "force-run-wrong-session",
            fenceToken: "10",
            cancellationGeneration: 4,
          }),
        });
        expect(result.ok).toBe(false);
      } finally {
        vi.unstubAllEnvs();
      }
    });
  });
});

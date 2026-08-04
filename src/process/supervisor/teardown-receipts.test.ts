import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  appendVerifiedTeardownReceipts,
  consumeVerifiedTeardownReceipts,
} from "./teardown-receipts.js";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((directory) => fs.rm(directory, { recursive: true })));
});

async function createStorePaths() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-receipts-"));
  cleanup.push(directory);
  return {
    receiptPath: path.join(directory, "receipts.json"),
    keyPath: path.join(directory, "receipts.key"),
  };
}

const entry = {
  ownerId: "owner-a",
  runId: "owned-run-a",
  pid: 42_424,
  sessionId: "tenant:session-a",
  scopeKey: "run:chat-run-a",
  startedAtMs: 900,
};

describe("signed process teardown receipts", () => {
  it("rejects a tampered correlation and does not expose signed proof", async () => {
    const paths = await createStorePaths();
    await appendVerifiedTeardownReceipts({ ...paths, entries: [entry], nowMs: 1_000 });
    const store = JSON.parse(await fs.readFile(paths.receiptPath, "utf8")) as {
      receipts: Array<Record<string, unknown>>;
    };
    store.receipts[0].sessionId = "tenant:attacker";
    await fs.writeFile(paths.receiptPath, JSON.stringify(store));

    await expect(
      consumeVerifiedTeardownReceipts({
        ...paths,
        sessionId: "tenant:attacker",
        scopeKey: entry.scopeKey,
        nowMs: 1_001,
        isTreeAlive: () => false,
      }),
    ).resolves.toEqual([]);
  });

  it("rejects expired proof", async () => {
    const paths = await createStorePaths();
    await appendVerifiedTeardownReceipts({
      ...paths,
      entries: [entry],
      nowMs: 1_000,
      ttlMs: 10,
    });

    await expect(
      consumeVerifiedTeardownReceipts({
        ...paths,
        sessionId: entry.sessionId,
        scopeKey: entry.scopeKey,
        nowMs: 1_011,
        isTreeAlive: () => false,
      }),
    ).resolves.toEqual([]);
  });

  it("rejects proof when the recorded PID or process group is live", async () => {
    const paths = await createStorePaths();
    await appendVerifiedTeardownReceipts({ ...paths, entries: [entry], nowMs: 1_000 });

    await expect(
      consumeVerifiedTeardownReceipts({
        ...paths,
        sessionId: entry.sessionId,
        scopeKey: entry.scopeKey,
        nowMs: 1_001,
        isTreeAlive: () => true,
      }),
    ).resolves.toEqual([]);
    await expect(
      consumeVerifiedTeardownReceipts({
        ...paths,
        sessionId: entry.sessionId,
        scopeKey: entry.scopeKey,
        nowMs: 1_002,
        isTreeAlive: () => false,
      }),
    ).resolves.toEqual([]);
  });
});

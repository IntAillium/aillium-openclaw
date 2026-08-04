import { createHmac } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  digestGovernedOperationRequest,
  GovernedOperationStore,
  type GovernedOperationIdentity,
} from "./aillium-governed-operation-store.js";

const tempDirs: string[] = [];

function storePath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-governed-operation-"));
  tempDirs.push(dir);
  return path.join(dir, "operations.json");
}

function identity(overrides: Partial<GovernedOperationIdentity> = {}): GovernedOperationIdentity {
  return {
    tenantId: "tenant-a",
    taskId: "task-a",
    executionRef: "execution-a",
    sessionKey: "agent:master:main",
    operationId: "task:task-a",
    idempotencyKey: "task:task-a",
    fenceToken: "7",
    cancellationGeneration: 2,
    ...overrides,
  };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("GovernedOperationStore", () => {
  it("durably deduplicates the exact operation and never resends after restart", () => {
    const filePath = storePath();
    const exactIdentity = identity();
    const requestDigest = digestGovernedOperationRequest({ message: "prepare report" });
    const first = new GovernedOperationStore(filePath);
    expect(first.reserve({ identity: exactIdentity, requestDigest }).kind).toBe("reserved");
    first.transition({ identity: exactIdentity, requestDigest, status: "running" });

    const restarted = new GovernedOperationStore(filePath);
    expect(restarted.get(exactIdentity)?.status).toBe("unknown");
    const duplicate = restarted.reserve({ identity: exactIdentity, requestDigest });
    expect(duplicate.kind).toBe("existing");
    if (duplicate.kind === "existing") {
      expect(duplicate.record.status).toBe("unknown");
    }
  });

  it("rejects stale fences, changed payloads, and cross-session reuse", () => {
    const store = new GovernedOperationStore(storePath());
    const exactIdentity = identity();
    const requestDigest = digestGovernedOperationRequest({ message: "prepare report" });
    expect(store.reserve({ identity: exactIdentity, requestDigest }).kind).toBe("reserved");

    expect(
      store.reserve({
        identity: identity({ fenceToken: "6" }),
        requestDigest,
      }).kind,
    ).toBe("conflict");
    expect(
      store.reserve({
        identity: identity({ sessionKey: "agent:finance:main" }),
        requestDigest,
      }).kind,
    ).toBe("conflict");
    expect(
      store.reserve({
        identity: exactIdentity,
        requestDigest: digestGovernedOperationRequest({ message: "different request" }),
      }).kind,
    ).toBe("conflict");
  });

  it("keeps tenant and run results isolated and signs an exact result receipt", () => {
    const store = new GovernedOperationStore(storePath());
    const exactIdentity = identity();
    const requestDigest = digestGovernedOperationRequest({ message: "prepare report" });
    store.reserve({ identity: exactIdentity, requestDigest });
    store.transition({ identity: exactIdentity, requestDigest, status: "running" });
    store.transition({
      identity: exactIdentity,
      requestDigest,
      status: "succeeded",
      outputText: "exact task result",
      error: null,
    });

    expect(store.get(identity({ tenantId: "tenant-b" }))).toBeUndefined();
    expect(
      store.get(identity({ operationId: "task:task-b", idempotencyKey: "task:task-b" })),
    ).toBeUndefined();
    expect(store.get(identity({ executionRef: "execution-b" }))).toBeUndefined();

    const receipt = store.receipt({
      identity: exactIdentity,
      secret: "receipt-secret",
      now: new Date("2026-08-04T10:00:00.000Z"),
    });
    expect(receipt).toMatchObject({
      status: "succeeded",
      outputText: "exact task result",
      runId: "task:task-a",
      providerIdempotency: "unsupported_fail_closed",
    });
    const { signature, ...unsigned } = receipt!;
    const canonicalJson = (value: unknown): string => {
      if (Array.isArray(value)) {
        return `[${value.map(canonicalJson).join(",")}]`;
      }
      if (value && typeof value === "object") {
        return `{${Object.entries(value as Record<string, unknown>)
          .toSorted(([left], [right]) => left.localeCompare(right))
          .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
          .join(",")}}`;
      }
      return JSON.stringify(value);
    };
    expect(signature).toBe(
      createHmac("sha256", "receipt-secret").update(canonicalJson(unsigned)).digest("base64url"),
    );
  });
});

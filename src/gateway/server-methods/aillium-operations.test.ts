import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  GOVERNED_OPERATION_SECRET_ENV,
  resetGovernedOperationAuthorityNoncesForTests,
  signGovernedOperationAuthority,
} from "../aillium-governed-operation-authority.js";
import {
  digestGovernedOperationRequest,
  getGovernedOperationStore,
  resetGovernedOperationStoreForTests,
} from "../aillium-governed-operation-store.js";
import { ailliumOperationHandlers } from "./aillium-operations.js";

const secret = "test-operation-result-secret";
let stateDir = "";

function signedAuthority(overrides: { sessionKey?: string; nonce?: string } = {}) {
  return signGovernedOperationAuthority({
    secret,
    tenantId: "tenant-a",
    taskId: "task-a",
    executionRef: "execution-a",
    sessionKey: overrides.sessionKey ?? "agent:master:main",
    operationId: "task:task-a",
    idempotencyKey: "task:task-a",
    fenceToken: "7",
    cancellationGeneration: 2,
    nonce: overrides.nonce,
  });
}

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-operation-handler-"));
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  vi.stubEnv(GOVERNED_OPERATION_SECRET_ENV, secret);
  resetGovernedOperationAuthorityNoncesForTests();
  resetGovernedOperationStoreForTests();
});

afterEach(() => {
  vi.unstubAllEnvs();
  resetGovernedOperationStoreForTests();
  fs.rmSync(stateDir, { recursive: true, force: true });
});

describe("aillium.operation.result", () => {
  it("returns only the exact run-scoped signed receipt", async () => {
    const authority = signedAuthority({ nonce: "reserve" });
    const identity = {
      tenantId: authority.tenantId,
      taskId: authority.taskId,
      executionRef: authority.executionRef,
      sessionKey: authority.sessionKey,
      operationId: authority.operationId,
      idempotencyKey: authority.idempotencyKey,
      fenceToken: authority.fenceToken,
      cancellationGeneration: authority.cancellationGeneration,
    };
    const requestDigest = digestGovernedOperationRequest({ message: "exact request" });
    const store = getGovernedOperationStore();
    store.reserve({ identity, requestDigest });
    store.transition({ identity, requestDigest, status: "running" });
    store.transition({
      identity,
      requestDigest,
      status: "succeeded",
      outputText: "exact result",
    });

    const respond = vi.fn();
    const queryAuthority = signedAuthority({ nonce: "query" });
    await ailliumOperationHandlers["aillium.operation.result"]?.({
      params: { authority: queryAuthority },
      respond,
    } as never);
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        operationId: "task:task-a",
        runId: "task:task-a",
        status: "succeeded",
        receipt: expect.objectContaining({ outputText: "exact result" }),
      }),
    );
  });

  it("fails closed for a different session", async () => {
    const authority = signedAuthority({ nonce: "reserve" });
    const identity = {
      tenantId: authority.tenantId,
      taskId: authority.taskId,
      executionRef: authority.executionRef,
      sessionKey: authority.sessionKey,
      operationId: authority.operationId,
      idempotencyKey: authority.idempotencyKey,
      fenceToken: authority.fenceToken,
      cancellationGeneration: authority.cancellationGeneration,
    };
    getGovernedOperationStore().reserve({
      identity,
      requestDigest: digestGovernedOperationRequest({ message: "exact request" }),
    });

    const respond = vi.fn();
    await ailliumOperationHandlers["aillium.operation.result"]?.({
      params: {
        authority: signedAuthority({ sessionKey: "agent:finance:main", nonce: "query-other" }),
      },
      respond,
    } as never);
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: "operation not found or exact identity mismatch" }),
    );
  });
});

import { describe, expect, it } from "vitest";
import {
  resetGovernedOperationAuthorityNoncesForTests,
  signGovernedOperationAuthority,
  verifyGovernedOperationAuthority,
} from "./aillium-governed-operation-authority.js";

const secret = "test-governed-operation-secret";

function authority(overrides: Partial<Parameters<typeof signGovernedOperationAuthority>[0]> = {}) {
  return signGovernedOperationAuthority({
    secret,
    tenantId: "tenant-a",
    taskId: "task-a",
    executionRef: "execution-a",
    sessionKey: "agent:master:main",
    operationId: "task:task-a",
    idempotencyKey: "task:task-a",
    fenceToken: "7",
    cancellationGeneration: 2,
    now: new Date("2026-08-04T10:00:00.000Z"),
    nonce: "nonce-a",
    ...overrides,
  });
}

describe("governed operation authority", () => {
  it("binds Core authority to the exact operation and session", () => {
    resetGovernedOperationAuthorityNoncesForTests();
    const signed = authority();
    expect(
      verifyGovernedOperationAuthority({
        authority: signed,
        secret,
        sessionKey: "agent:master:main",
        operationId: "task:task-a",
        now: new Date("2026-08-04T10:00:01.000Z"),
      }),
    ).toEqual(signed);
    expect(() =>
      verifyGovernedOperationAuthority({
        authority: authority({ nonce: "nonce-b" }),
        secret,
        sessionKey: "agent:finance:main",
        operationId: "task:task-a",
        now: new Date("2026-08-04T10:00:01.000Z"),
      }),
    ).toThrow("Invalid Core governed-operation authority");
  });

  it("rejects replayed and expired authority", () => {
    resetGovernedOperationAuthorityNoncesForTests();
    const signed = authority();
    verifyGovernedOperationAuthority({
      authority: signed,
      secret,
      sessionKey: signed.sessionKey,
      operationId: signed.operationId,
      now: new Date("2026-08-04T10:00:01.000Z"),
    });
    expect(() =>
      verifyGovernedOperationAuthority({
        authority: signed,
        secret,
        sessionKey: signed.sessionKey,
        operationId: signed.operationId,
        now: new Date("2026-08-04T10:00:02.000Z"),
      }),
    ).toThrow("Replayed Core governed-operation authority");
    expect(() =>
      verifyGovernedOperationAuthority({
        authority: authority({ nonce: "nonce-expired" }),
        secret,
        sessionKey: signed.sessionKey,
        operationId: signed.operationId,
        now: new Date("2026-08-04T10:00:06.000Z"),
      }),
    ).toThrow("Invalid Core governed-operation authority");
  });
});

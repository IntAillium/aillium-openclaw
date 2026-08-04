import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

export const GOVERNED_OPERATION_SECRET_ENV = "AILLIUM_GOVERNED_OPERATION_SIGNING_SECRET";

export type GovernedOperationAuthority = {
  version: 1;
  issuer: "aillium-core";
  audience: "openclaw:governed-operation";
  tenantId: string;
  taskId: string;
  executionRef: string;
  sessionKey: string;
  operationId: string;
  idempotencyKey: string;
  fenceToken: string;
  cancellationGeneration: number;
  issuedAt: string;
  expiresAt: string;
  nonce: string;
  signature: string;
};

const seenNonces = new Map<string, number>();

function unsigned(authority: Omit<GovernedOperationAuthority, "signature">): string {
  return JSON.stringify(authority);
}

export function signGovernedOperationAuthority(input: {
  secret: string;
  tenantId: string;
  taskId: string;
  executionRef: string;
  sessionKey: string;
  operationId: string;
  idempotencyKey: string;
  fenceToken: string;
  cancellationGeneration: number;
  now?: Date;
  nonce?: string;
}): GovernedOperationAuthority {
  const now = input.now ?? new Date();
  const claim: Omit<GovernedOperationAuthority, "signature"> = {
    version: 1,
    issuer: "aillium-core",
    audience: "openclaw:governed-operation",
    tenantId: input.tenantId,
    taskId: input.taskId,
    executionRef: input.executionRef,
    sessionKey: input.sessionKey,
    operationId: input.operationId,
    idempotencyKey: input.idempotencyKey,
    fenceToken: input.fenceToken,
    cancellationGeneration: input.cancellationGeneration,
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 5_000).toISOString(),
    nonce: input.nonce ?? randomUUID(),
  };
  return {
    ...claim,
    signature: createHmac("sha256", input.secret).update(unsigned(claim)).digest("base64url"),
  };
}

export function verifyGovernedOperationAuthority(input: {
  authority: GovernedOperationAuthority;
  secret: string;
  sessionKey: string;
  operationId: string;
  now?: Date;
  consumeNonce?: boolean;
}): GovernedOperationAuthority {
  const { signature, ...claim } = input.authority;
  const expected = createHmac("sha256", input.secret).update(unsigned(claim)).digest();
  const received = Buffer.from(signature, "base64url");
  const now = (input.now ?? new Date()).getTime();
  const issuedAt = Date.parse(claim.issuedAt);
  const expiresAt = Date.parse(claim.expiresAt);
  if (
    !input.secret ||
    received.length !== expected.length ||
    !timingSafeEqual(received, expected) ||
    claim.version !== 1 ||
    claim.issuer !== "aillium-core" ||
    claim.audience !== "openclaw:governed-operation" ||
    claim.sessionKey !== input.sessionKey ||
    claim.operationId !== input.operationId ||
    claim.idempotencyKey !== input.operationId ||
    !claim.tenantId ||
    !claim.taskId ||
    !claim.executionRef ||
    !/^(0|[1-9]\d*)$/.test(claim.fenceToken) ||
    !Number.isInteger(claim.cancellationGeneration) ||
    claim.cancellationGeneration < 0 ||
    !Number.isFinite(issuedAt) ||
    !Number.isFinite(expiresAt) ||
    issuedAt > now + 1_000 ||
    expiresAt < now ||
    expiresAt - issuedAt > 5_000
  ) {
    throw new Error("Invalid Core governed-operation authority");
  }

  if (input.consumeNonce !== false) {
    for (const [nonce, expiry] of seenNonces) {
      if (expiry < now) {
        seenNonces.delete(nonce);
      }
    }
    if (seenNonces.has(claim.nonce)) {
      throw new Error("Replayed Core governed-operation authority");
    }
    seenNonces.set(claim.nonce, expiresAt);
  }
  return input.authority;
}

export function resetGovernedOperationAuthorityNoncesForTests(): void {
  seenNonces.clear();
}

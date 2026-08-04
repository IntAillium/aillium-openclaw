import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

export type ForceAbortAuthority = {
  version: 1;
  issuer: "aillium-core";
  audience: "openclaw:chat.abort.force";
  tenantId: string;
  sessionKey: string;
  runId: string;
  fenceToken: string;
  cancellationGeneration: number;
  issuedAt: string;
  expiresAt: string;
  nonce: string;
  signature: string;
};

const seenNonces = new Map<string, number>();

function unsigned(authority: Omit<ForceAbortAuthority, "signature">): string {
  return JSON.stringify(authority);
}

export function signForceAbortAuthority(input: {
  secret: string;
  tenantId: string;
  sessionKey: string;
  runId: string;
  fenceToken: string;
  cancellationGeneration: number;
  now?: Date;
}): ForceAbortAuthority {
  const now = input.now ?? new Date();
  const claim: Omit<ForceAbortAuthority, "signature"> = {
    version: 1,
    issuer: "aillium-core",
    audience: "openclaw:chat.abort.force",
    tenantId: input.tenantId,
    sessionKey: input.sessionKey,
    runId: input.runId,
    fenceToken: input.fenceToken,
    cancellationGeneration: input.cancellationGeneration,
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 5_000).toISOString(),
    nonce: randomUUID(),
  };
  return {
    ...claim,
    signature: createHmac("sha256", input.secret).update(unsigned(claim)).digest("base64url"),
  };
}

export function verifyForceAbortAuthority(input: {
  authority: ForceAbortAuthority;
  secret: string;
  sessionKey: string;
  runId: string;
  now?: Date;
}): ForceAbortAuthority {
  const { signature, ...claim } = input.authority;
  const expected = createHmac("sha256", input.secret).update(unsigned(claim)).digest();
  const received = Buffer.from(signature, "base64url");
  const now = (input.now ?? new Date()).getTime();
  if (
    !input.secret ||
    received.length !== expected.length ||
    !timingSafeEqual(received, expected) ||
    claim.version !== 1 ||
    claim.issuer !== "aillium-core" ||
    claim.audience !== "openclaw:chat.abort.force" ||
    claim.sessionKey !== input.sessionKey ||
    claim.runId !== input.runId ||
    !claim.tenantId ||
    !/^(0|[1-9]\d*)$/.test(claim.fenceToken) ||
    !Number.isInteger(claim.cancellationGeneration) ||
    claim.cancellationGeneration < 0 ||
    Date.parse(claim.issuedAt) > now + 1_000 ||
    Date.parse(claim.expiresAt) < now ||
    Date.parse(claim.expiresAt) - Date.parse(claim.issuedAt) > 5_000
  ) {
    throw new Error("Invalid Core force-abort authority");
  }
  for (const [nonce, expiry] of seenNonces) {
    if (expiry < now) {
      seenNonces.delete(nonce);
    }
  }
  if (seenNonces.has(claim.nonce)) {
    throw new Error("Replayed Core force-abort authority");
  }
  seenNonces.set(claim.nonce, Date.parse(claim.expiresAt));
  return input.authority;
}

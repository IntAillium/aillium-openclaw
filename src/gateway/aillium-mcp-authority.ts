import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { RuntimeWireEnvelopeV1Schema, type RuntimeWireEnvelopeV1 } from "@aillium/schemas";

export const MCP_AUTHORITY_HEADER = "x-aillium-core-authority";
export const MCP_SIGNATURE_HEADER = "x-aillium-core-signature";
const seenAuthorityNonces = new Map<string, number>();

function canonicalJson(value: unknown): string {
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
}

function identity(envelope: RuntimeWireEnvelopeV1) {
  const payload = envelope.payload as unknown as Record<string, unknown>;
  return {
    tenant_id: envelope.context.tenant_id,
    work_order_id: envelope.context.work_order_id,
    run_id: envelope.context.run_id,
    run_step_id: envelope.context.run_step_id,
    attempt: envelope.context.attempt,
    idempotency_key: envelope.context.idempotency_key,
    fence_token: envelope.context.fence_token,
    executor_id: envelope.context.executor_id,
    lease_id: envelope.context.lease_id,
    lease_epoch: envelope.context.lease_epoch,
    lease_expires_at: envelope.context.lease_expires_at,
    operation_id: payload.operation_id,
    tool_name: payload.tool_name ?? null,
    approval_id: payload.approval_id ?? null,
    deadline_at: payload.deadline_at ?? null,
    cancellation_id: payload.cancellation_id ?? null,
  };
}

export function signMcpRuntimeEnvelope(input: {
  envelope: RuntimeWireEnvelopeV1;
  secret: string;
  issuer: "aillium-core" | "aillium-openclaw";
  audience: "aillium-core" | "connector:mcp";
  now?: Date;
}): Record<string, string> {
  let envelope: RuntimeWireEnvelopeV1;
  try {
    envelope = RuntimeWireEnvelopeV1Schema.parse(input.envelope);
  } catch {
    throw new Error("MCP authority identity does not match the runtime envelope");
  }
  const now = input.now ?? new Date();
  const claim = {
    version: 1,
    alg: "HS256",
    key_id: "runtime-sync-token",
    issuer: input.issuer,
    audience: input.audience,
    signed_at: now.toISOString(),
    expires_at: new Date(now.getTime() + 30_000).toISOString(),
    nonce: randomUUID(),
    envelope_sha256: createHash("sha256").update(canonicalJson(envelope)).digest("hex"),
    identity: identity(envelope),
  };
  const encoded = Buffer.from(JSON.stringify(claim)).toString("base64url");
  return {
    [MCP_AUTHORITY_HEADER]: encoded,
    [MCP_SIGNATURE_HEADER]: createHmac("sha256", input.secret).update(encoded).digest("base64url"),
  };
}

export function verifyMcpRuntimeEnvelope(input: {
  envelope: unknown;
  headers: Record<string, string | string[] | undefined>;
  secret: string;
  issuer: "aillium-core" | "aillium-openclaw";
  audience: "aillium-core" | "connector:mcp";
  now?: Date;
}): RuntimeWireEnvelopeV1 {
  let envelope: RuntimeWireEnvelopeV1;
  try {
    envelope = RuntimeWireEnvelopeV1Schema.parse(input.envelope);
  } catch {
    throw new Error("MCP authority identity does not match the runtime envelope");
  }
  const encodedValue = input.headers[MCP_AUTHORITY_HEADER];
  const signatureValue = input.headers[MCP_SIGNATURE_HEADER];
  const encoded = Array.isArray(encodedValue) ? encodedValue[0] : encodedValue;
  const received = Array.isArray(signatureValue) ? signatureValue[0] : signatureValue;
  if (!encoded || !received || !input.secret) {
    throw new Error("Missing MCP authority signature");
  }
  const expected = createHmac("sha256", input.secret).update(encoded).digest();
  const supplied = Buffer.from(received, "base64url");
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    throw new Error("Invalid MCP authority signature");
  }
  const claim = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as Record<
    string,
    unknown
  >;
  const now = (input.now ?? new Date()).getTime();
  if (
    claim.version !== 1 ||
    claim.alg !== "HS256" ||
    claim.key_id !== "runtime-sync-token" ||
    claim.issuer !== input.issuer ||
    claim.audience !== input.audience ||
    typeof claim.signed_at !== "string" ||
    typeof claim.expires_at !== "string" ||
    Date.parse(claim.signed_at) > now + 5_000 ||
    Date.parse(claim.expires_at) < now
  ) {
    throw new Error("Expired or mis-scoped MCP authority");
  }
  const digest = createHash("sha256").update(canonicalJson(envelope)).digest("hex");
  if (
    claim.envelope_sha256 !== digest ||
    canonicalJson(claim.identity) !== canonicalJson(identity(envelope))
  ) {
    throw new Error("MCP authority identity does not match the runtime envelope");
  }
  if (typeof claim.nonce !== "string" || !claim.nonce) {
    throw new Error("Invalid MCP authority nonce");
  }
  for (const [key, expiry] of seenAuthorityNonces) {
    if (expiry < now) {
      seenAuthorityNonces.delete(key);
    }
  }
  const replayKey = `${input.issuer}:${input.audience}:${claim.nonce}`;
  if (seenAuthorityNonces.has(replayKey)) {
    throw new Error("Replayed MCP authority");
  }
  seenAuthorityNonces.set(replayKey, Date.parse(claim.expires_at));
  return envelope;
}

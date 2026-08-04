import { createHash, createHmac, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import type { GovernedOperationAuthority } from "./aillium-governed-operation-authority.js";

export type GovernedOperationStatus = "accepted" | "running" | "succeeded" | "failed" | "unknown";

export type GovernedOperationIdentity = Pick<
  GovernedOperationAuthority,
  | "tenantId"
  | "taskId"
  | "executionRef"
  | "sessionKey"
  | "operationId"
  | "idempotencyKey"
  | "fenceToken"
  | "cancellationGeneration"
>;

export type GovernedOperationRecord = {
  version: 1;
  identity: GovernedOperationIdentity;
  requestDigest: string;
  runId: string;
  status: GovernedOperationStatus;
  outputText: string | null;
  error: string | null;
  providerIdempotency: "unsupported_fail_closed";
  acceptedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  updatedAt: string;
};

type StoreFile = {
  version: 1;
  records: Record<string, GovernedOperationRecord>;
};

export type ReserveGovernedOperationResult =
  | { kind: "reserved"; record: GovernedOperationRecord }
  | { kind: "existing"; record: GovernedOperationRecord }
  | { kind: "conflict"; record: GovernedOperationRecord; reason: string };

export type GovernedOperationReceipt = {
  version: 1;
  issuer: "aillium-openclaw";
  audience: "aillium-core";
  identity: GovernedOperationIdentity;
  runId: string;
  status: GovernedOperationStatus;
  requestDigest: string;
  resultDigest: string;
  outputText: string | null;
  error: string | null;
  providerIdempotency: "unsupported_fail_closed";
  acceptedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  emittedAt: string;
  signature: string;
};

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

export function digestGovernedOperationRequest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function identityMatches(
  left: GovernedOperationIdentity,
  right: GovernedOperationIdentity,
): boolean {
  return (
    left.tenantId === right.tenantId &&
    left.taskId === right.taskId &&
    left.executionRef === right.executionRef &&
    left.sessionKey === right.sessionKey &&
    left.operationId === right.operationId &&
    left.idempotencyKey === right.idempotencyKey &&
    left.fenceToken === right.fenceToken &&
    left.cancellationGeneration === right.cancellationGeneration
  );
}

function operationKey(identity: GovernedOperationIdentity): string {
  return createHash("sha256").update(`${identity.tenantId}\0${identity.operationId}`).digest("hex");
}

function cloneRecord(record: GovernedOperationRecord): GovernedOperationRecord {
  return structuredClone(record);
}

export class GovernedOperationStore {
  private readonly records = new Map<string, GovernedOperationRecord>();

  constructor(private readonly filePath: string) {
    this.loadAndReconcile();
  }

  reserve(input: {
    identity: GovernedOperationIdentity;
    requestDigest: string;
    now?: Date;
  }): ReserveGovernedOperationResult {
    const key = operationKey(input.identity);
    const existing = this.records.get(key);
    if (existing) {
      if (!identityMatches(existing.identity, input.identity)) {
        return {
          kind: "conflict",
          record: cloneRecord(existing),
          reason: "operation identity conflicts with the durable record",
        };
      }
      if (existing.requestDigest !== input.requestDigest) {
        return {
          kind: "conflict",
          record: cloneRecord(existing),
          reason: "operation request digest conflicts with the durable record",
        };
      }
      return { kind: "existing", record: cloneRecord(existing) };
    }

    const now = (input.now ?? new Date()).toISOString();
    const record: GovernedOperationRecord = {
      version: 1,
      identity: structuredClone(input.identity),
      requestDigest: input.requestDigest,
      runId: input.identity.operationId,
      status: "accepted",
      outputText: null,
      error: null,
      providerIdempotency: "unsupported_fail_closed",
      acceptedAt: now,
      startedAt: null,
      completedAt: null,
      updatedAt: now,
    };
    this.records.set(key, record);
    try {
      this.persist();
    } catch (error) {
      this.records.delete(key);
      throw error;
    }
    return { kind: "reserved", record: cloneRecord(record) };
  }

  get(identity: GovernedOperationIdentity): GovernedOperationRecord | undefined {
    const record = this.records.get(operationKey(identity));
    if (!record || !identityMatches(record.identity, identity)) {
      return undefined;
    }
    return cloneRecord(record);
  }

  transition(input: {
    identity: GovernedOperationIdentity;
    requestDigest: string;
    status: Exclude<GovernedOperationStatus, "accepted">;
    outputText?: string | null;
    error?: string | null;
    now?: Date;
  }): GovernedOperationRecord {
    const key = operationKey(input.identity);
    const record = this.records.get(key);
    if (
      !record ||
      !identityMatches(record.identity, input.identity) ||
      record.requestDigest !== input.requestDigest
    ) {
      throw new Error("governed operation transition lost its exact durable identity");
    }
    if (["succeeded", "failed", "unknown"].includes(record.status)) {
      return cloneRecord(record);
    }
    const previous = cloneRecord(record);
    const now = (input.now ?? new Date()).toISOString();
    record.status = input.status;
    record.updatedAt = now;
    if (input.status === "running" && !record.startedAt) {
      record.startedAt = now;
    }
    if (["succeeded", "failed", "unknown"].includes(input.status)) {
      record.completedAt = now;
    }
    if (input.outputText !== undefined) {
      record.outputText = input.outputText;
    }
    if (input.error !== undefined) {
      record.error = input.error;
    }
    try {
      this.persist();
    } catch (error) {
      this.records.set(key, previous);
      throw error;
    }
    return cloneRecord(record);
  }

  receipt(input: {
    identity: GovernedOperationIdentity;
    secret: string;
    now?: Date;
  }): GovernedOperationReceipt | undefined {
    const record = this.get(input.identity);
    if (!record) {
      return undefined;
    }
    const unsigned: Omit<GovernedOperationReceipt, "signature"> = {
      version: 1,
      issuer: "aillium-openclaw",
      audience: "aillium-core",
      identity: record.identity,
      runId: record.runId,
      status: record.status,
      requestDigest: record.requestDigest,
      resultDigest: digestGovernedOperationRequest({
        outputText: record.outputText,
        error: record.error,
        status: record.status,
      }),
      outputText: record.outputText,
      error: record.error,
      providerIdempotency: record.providerIdempotency,
      acceptedAt: record.acceptedAt,
      startedAt: record.startedAt,
      completedAt: record.completedAt,
      emittedAt: (input.now ?? new Date()).toISOString(),
    };
    return {
      ...unsigned,
      signature: createHmac("sha256", input.secret)
        .update(canonicalJson(unsigned))
        .digest("base64url"),
    };
  }

  private loadAndReconcile(): void {
    if (!fs.existsSync(this.filePath)) {
      return;
    }
    const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as StoreFile;
    if (parsed.version !== 1 || !parsed.records || typeof parsed.records !== "object") {
      throw new Error("invalid governed operation store");
    }
    let reconciled = false;
    const now = new Date().toISOString();
    for (const [key, record] of Object.entries(parsed.records)) {
      if (record.version !== 1 || key !== operationKey(record.identity)) {
        throw new Error("invalid governed operation record identity");
      }
      if (record.status === "accepted" || record.status === "running") {
        record.status = "unknown";
        record.error = "OpenClaw restarted before the exact downstream outcome was durable";
        record.completedAt = now;
        record.updatedAt = now;
        reconciled = true;
      }
      this.records.set(key, record);
    }
    if (reconciled) {
      this.persist();
    }
  }

  private persist(): void {
    const directory = path.dirname(this.filePath);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const snapshot: StoreFile = {
      version: 1,
      records: Object.fromEntries(this.records),
    };
    const temp = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temp, `${JSON.stringify(snapshot)}\n`, { encoding: "utf8", mode: 0o600 });
      fs.renameSync(temp, this.filePath);
      fs.chmodSync(this.filePath, 0o600);
    } finally {
      fs.rmSync(temp, { force: true });
    }
  }
}

let singleton: GovernedOperationStore | undefined;
let singletonPath: string | undefined;

export function resolveGovernedOperationStorePath(): string {
  return path.join(resolveStateDir(process.env), "aillium", "governed-operations.json");
}

export function getGovernedOperationStore(): GovernedOperationStore {
  const filePath = resolveGovernedOperationStorePath();
  if (!singleton || singletonPath !== filePath) {
    singleton = new GovernedOperationStore(filePath);
    singletonPath = filePath;
  }
  return singleton;
}

export function resetGovernedOperationStoreForTests(): void {
  singleton = undefined;
  singletonPath = undefined;
}

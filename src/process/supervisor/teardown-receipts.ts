import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { isProcessTreeAlive } from "../kill-tree.js";
import type { OwnedProcessJournalEntry } from "./orphan-journal.js";

const RECEIPT_VERSION = 1;
const DEFAULT_RECEIPT_TTL_MS = 15 * 60_000;

export type ProcessTeardownReceipt = {
  version: 1;
  ownerId: string;
  runId: string;
  pid: number;
  sessionId: string;
  scopeKey: string;
  startedAtMs: number;
  verifiedAbsentAtMs: number;
  expiresAtMs: number;
  nonce: string;
  signature: string;
};

type ProcessTeardownReceiptStore = {
  version: 1;
  receipts: ProcessTeardownReceipt[];
};

type ReceiptPayload = Omit<ProcessTeardownReceipt, "signature">;

function canonicalReceiptPayload(receipt: ReceiptPayload): string {
  return JSON.stringify([
    receipt.version,
    receipt.ownerId,
    receipt.runId,
    receipt.pid,
    receipt.sessionId,
    receipt.scopeKey,
    receipt.startedAtMs,
    receipt.verifiedAbsentAtMs,
    receipt.expiresAtMs,
    receipt.nonce,
  ]);
}

function signReceipt(payload: ReceiptPayload, key: Buffer): string {
  return crypto
    .createHmac("sha256", key)
    .update(canonicalReceiptPayload(payload))
    .digest("base64url");
}

function receiptHasValidShape(value: unknown): value is ProcessTeardownReceipt {
  if (!value || typeof value !== "object") {
    return false;
  }
  const receipt = value as Partial<ProcessTeardownReceipt>;
  return (
    receipt.version === RECEIPT_VERSION &&
    typeof receipt.ownerId === "string" &&
    typeof receipt.runId === "string" &&
    Number.isInteger(receipt.pid) &&
    Number(receipt.pid) > 0 &&
    typeof receipt.sessionId === "string" &&
    receipt.sessionId.length > 0 &&
    typeof receipt.scopeKey === "string" &&
    receipt.scopeKey.length > 0 &&
    Number.isFinite(receipt.startedAtMs) &&
    Number.isFinite(receipt.verifiedAbsentAtMs) &&
    Number.isFinite(receipt.expiresAtMs) &&
    typeof receipt.nonce === "string" &&
    receipt.nonce.length > 0 &&
    typeof receipt.signature === "string" &&
    receipt.signature.length > 0
  );
}

function receiptSignatureIsValid(receipt: ProcessTeardownReceipt, key: Buffer): boolean {
  const { signature, ...payload } = receipt;
  const expected = Buffer.from(signReceipt(payload, key));
  const actual = Buffer.from(signature);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

async function readSigningKey(keyPath: string): Promise<Buffer> {
  const encoded = (await fs.readFile(keyPath, "utf8")).trim();
  const key = Buffer.from(encoded, "base64url");
  if (key.length !== 32) {
    throw new Error("invalid process teardown receipt signing key");
  }
  return key;
}

async function readOrCreateSigningKey(keyPath: string): Promise<Buffer> {
  try {
    return await readSigningKey(keyPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
  }
  await fs.mkdir(path.dirname(keyPath), { recursive: true, mode: 0o700 });
  const key = crypto.randomBytes(32);
  try {
    await fs.writeFile(keyPath, `${key.toString("base64url")}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    return key;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
      throw err;
    }
    return await readSigningKey(keyPath);
  }
}

async function readReceiptStore(receiptPath: string): Promise<ProcessTeardownReceipt[]> {
  try {
    const parsed = JSON.parse(
      await fs.readFile(receiptPath, "utf8"),
    ) as ProcessTeardownReceiptStore;
    if (parsed.version !== RECEIPT_VERSION || !Array.isArray(parsed.receipts)) {
      return [];
    }
    return parsed.receipts.filter(receiptHasValidShape);
  } catch {
    return [];
  }
}

async function writeReceiptStore(
  receiptPath: string,
  receipts: ProcessTeardownReceipt[],
): Promise<void> {
  await fs.mkdir(path.dirname(receiptPath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${receiptPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(
    temporaryPath,
    `${JSON.stringify({ version: RECEIPT_VERSION, receipts } satisfies ProcessTeardownReceiptStore)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  await fs.rename(temporaryPath, receiptPath);
}

export async function appendVerifiedTeardownReceipts(params: {
  receiptPath: string;
  keyPath: string;
  entries: OwnedProcessJournalEntry[];
  invalidateEntries?: OwnedProcessJournalEntry[];
  nowMs?: number;
  ttlMs?: number;
}): Promise<void> {
  const eligible = params.entries.filter(
    (entry): entry is OwnedProcessJournalEntry & { sessionId: string; scopeKey: string } =>
      Boolean(entry.sessionId?.trim() && entry.scopeKey?.trim()),
  );
  const invalidatedCorrelations = new Set(
    (params.invalidateEntries ?? []).flatMap((entry) =>
      entry.sessionId?.trim() && entry.scopeKey?.trim()
        ? [`${entry.sessionId.trim()}\0${entry.scopeKey.trim()}`]
        : [],
    ),
  );
  if (eligible.length === 0 && invalidatedCorrelations.size === 0) {
    return;
  }
  const key = await readOrCreateSigningKey(params.keyPath);
  const nowMs = params.nowMs ?? Date.now();
  const ttlMs = Math.max(1, params.ttlMs ?? DEFAULT_RECEIPT_TTL_MS);
  const current = (await readReceiptStore(params.receiptPath)).filter(
    (receipt) =>
      receipt.expiresAtMs > nowMs &&
      receiptSignatureIsValid(receipt, key) &&
      !invalidatedCorrelations.has(`${receipt.sessionId}\0${receipt.scopeKey}`),
  );
  const additions = eligible.map((entry): ProcessTeardownReceipt => {
    const payload: ReceiptPayload = {
      version: RECEIPT_VERSION,
      ownerId: entry.ownerId,
      runId: entry.runId,
      pid: entry.pid,
      sessionId: entry.sessionId,
      scopeKey: entry.scopeKey,
      startedAtMs: entry.startedAtMs,
      verifiedAbsentAtMs: nowMs,
      expiresAtMs: nowMs + ttlMs,
      nonce: crypto.randomUUID(),
    };
    return { ...payload, signature: signReceipt(payload, key) };
  });
  await writeReceiptStore(params.receiptPath, [...current, ...additions]);
}

export async function consumeVerifiedTeardownReceipts(params: {
  receiptPath: string;
  keyPath: string;
  sessionId: string;
  scopeKey: string;
  nowMs?: number;
  isTreeAlive?: (pid: number) => boolean;
}): Promise<ProcessTeardownReceipt[]> {
  const normalizedSessionId = params.sessionId.trim();
  const normalizedScopeKey = params.scopeKey.trim();
  if (!normalizedSessionId || !normalizedScopeKey) {
    return [];
  }
  let key: Buffer;
  try {
    key = await readSigningKey(params.keyPath);
  } catch {
    return [];
  }
  const nowMs = params.nowMs ?? Date.now();
  const isTreeAlive = params.isTreeAlive ?? isProcessTreeAlive;
  const current = await readReceiptStore(params.receiptPath);
  const consumable: ProcessTeardownReceipt[] = [];
  const retained: ProcessTeardownReceipt[] = [];
  for (const receipt of current) {
    const cryptographicallyValid = receiptSignatureIsValid(receipt, key);
    const temporallyValid =
      receipt.expiresAtMs > nowMs &&
      receipt.verifiedAbsentAtMs >= receipt.startedAtMs &&
      receipt.verifiedAbsentAtMs <= nowMs;
    if (!cryptographicallyValid || !temporallyValid) {
      continue;
    }
    const exactMatch =
      receipt.sessionId === normalizedSessionId && receipt.scopeKey === normalizedScopeKey;
    if (!exactMatch) {
      retained.push(receipt);
      continue;
    }
    // A live process at the recorded PID/process-group makes the old proof
    // ambiguous after PID reuse. Discard it rather than acknowledging teardown.
    if (isTreeAlive(receipt.pid)) {
      continue;
    }
    consumable.push(receipt);
  }
  await writeReceiptStore(params.receiptPath, retained);
  return consumable;
}

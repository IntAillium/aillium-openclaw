import { Type } from "@sinclair/typebox";
import { ChatSendSessionKeyString, InputProvenanceSchema, NonEmptyString } from "./primitives.js";

export const LogsTailParamsSchema = Type.Object(
  {
    cursor: Type.Optional(Type.Integer({ minimum: 0 })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 5000 })),
    maxBytes: Type.Optional(Type.Integer({ minimum: 1, maximum: 1_000_000 })),
  },
  { additionalProperties: false },
);

export const LogsTailResultSchema = Type.Object(
  {
    file: NonEmptyString,
    cursor: Type.Integer({ minimum: 0 }),
    size: Type.Integer({ minimum: 0 }),
    lines: Type.Array(Type.String()),
    truncated: Type.Optional(Type.Boolean()),
    reset: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

// WebChat/WebSocket-native chat methods
export const ChatHistoryParamsSchema = Type.Object(
  {
    sessionKey: NonEmptyString,
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })),
  },
  { additionalProperties: false },
);

export const GovernedOperationAuthoritySchema = Type.Object(
  {
    version: Type.Literal(1),
    issuer: Type.Literal("aillium-core"),
    audience: Type.Literal("openclaw:governed-operation"),
    tenantId: NonEmptyString,
    taskId: NonEmptyString,
    executionRef: NonEmptyString,
    sessionKey: ChatSendSessionKeyString,
    operationId: NonEmptyString,
    idempotencyKey: NonEmptyString,
    fenceToken: Type.String({ pattern: "^(0|[1-9]\\d*)$" }),
    cancellationGeneration: Type.Integer({ minimum: 0 }),
    issuedAt: NonEmptyString,
    expiresAt: NonEmptyString,
    nonce: NonEmptyString,
    signature: NonEmptyString,
  },
  { additionalProperties: false },
);

export const ChatSendParamsSchema = Type.Object(
  {
    sessionKey: ChatSendSessionKeyString,
    message: Type.String(),
    model: Type.Optional(NonEmptyString),
    authProfileId: Type.Optional(NonEmptyString),
    authProfileSource: Type.Optional(Type.Union([Type.Literal("auto"), Type.Literal("user")])),
    thinking: Type.Optional(Type.String()),
    deliver: Type.Optional(Type.Boolean()),
    attachments: Type.Optional(Type.Array(Type.Unknown())),
    timeoutMs: Type.Optional(Type.Integer({ minimum: 0 })),
    systemInputProvenance: Type.Optional(InputProvenanceSchema),
    systemProvenanceReceipt: Type.Optional(Type.String()),
    idempotencyKey: NonEmptyString,
    governedOperationAuthority: Type.Optional(GovernedOperationAuthoritySchema),
  },
  { additionalProperties: false },
);

export const GovernedOperationResultParamsSchema = Type.Object(
  {
    authority: GovernedOperationAuthoritySchema,
  },
  { additionalProperties: false },
);

export const ChatAbortParamsSchema = Type.Object(
  {
    sessionKey: NonEmptyString,
    runId: Type.Optional(NonEmptyString),
    force: Type.Optional(Type.Boolean()),
    deadlineMs: Type.Optional(Type.Integer({ minimum: 1, maximum: 650 })),
    forceAuthority: Type.Optional(
      Type.Object(
        {
          version: Type.Literal(1),
          issuer: Type.Literal("aillium-core"),
          audience: Type.Literal("openclaw:chat.abort.force"),
          tenantId: NonEmptyString,
          sessionKey: NonEmptyString,
          runId: NonEmptyString,
          fenceToken: Type.String({ pattern: "^(0|[1-9]\\d*)$" }),
          cancellationGeneration: Type.Integer({ minimum: 0 }),
          issuedAt: NonEmptyString,
          expiresAt: NonEmptyString,
          nonce: NonEmptyString,
          signature: NonEmptyString,
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

export const ChatInjectParamsSchema = Type.Object(
  {
    sessionKey: NonEmptyString,
    message: NonEmptyString,
    label: Type.Optional(Type.String({ maxLength: 100 })),
  },
  { additionalProperties: false },
);

export const ChatEventSchema = Type.Object(
  {
    runId: NonEmptyString,
    sessionKey: NonEmptyString,
    seq: Type.Integer({ minimum: 0 }),
    state: Type.Union([
      Type.Literal("delta"),
      Type.Literal("final"),
      Type.Literal("aborted"),
      Type.Literal("error"),
    ]),
    message: Type.Optional(Type.Unknown()),
    errorMessage: Type.Optional(Type.String()),
    usage: Type.Optional(Type.Unknown()),
    stopReason: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

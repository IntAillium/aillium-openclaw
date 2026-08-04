import {
  GOVERNED_OPERATION_SECRET_ENV,
  verifyGovernedOperationAuthority,
  type GovernedOperationAuthority,
} from "../aillium-governed-operation-authority.js";
import {
  getGovernedOperationStore,
  type GovernedOperationIdentity,
} from "../aillium-governed-operation-store.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateGovernedOperationResultParams,
} from "../protocol/index.js";
import type { GatewayRequestHandlers } from "./types.js";

export const ailliumOperationHandlers: GatewayRequestHandlers = {
  "aillium.operation.result": ({ params, respond }) => {
    if (!validateGovernedOperationResultParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid aillium.operation.result params: ${formatValidationErrors(
            validateGovernedOperationResultParams.errors,
          )}`,
        ),
      );
      return;
    }
    const authority = (params as { authority: GovernedOperationAuthority }).authority;
    const secret = process.env[GOVERNED_OPERATION_SECRET_ENV]?.trim() || "";
    try {
      verifyGovernedOperationAuthority({
        authority,
        secret,
        sessionKey: authority.sessionKey,
        operationId: authority.operationId,
      });
    } catch {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "unauthorized"));
      return;
    }
    const identity: GovernedOperationIdentity = {
      tenantId: authority.tenantId,
      taskId: authority.taskId,
      executionRef: authority.executionRef,
      sessionKey: authority.sessionKey,
      operationId: authority.operationId,
      idempotencyKey: authority.idempotencyKey,
      fenceToken: authority.fenceToken,
      cancellationGeneration: authority.cancellationGeneration,
    };
    let receipt;
    try {
      receipt = getGovernedOperationStore().receipt({ identity, secret });
    } catch (error) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, `unable to read governed operation: ${String(error)}`),
      );
      return;
    }
    if (!receipt) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "operation not found or exact identity mismatch"),
      );
      return;
    }
    respond(true, {
      operationId: authority.operationId,
      runId: receipt.runId,
      status: receipt.status,
      receipt,
    });
  },
};

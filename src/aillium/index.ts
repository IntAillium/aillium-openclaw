export type {
  AilliumIntegrationBoundary,
  CapsuleLifecycleEvent,
  CapsuleLifecycleHook,
  ContextLifecycleEvent,
  ContextLifecycleHook,
  ContractAdapter,
  EvidenceCallbackHook,
  JsonPrimitive,
  JsonValue,
  RuntimeRegistrationAdapter,
  RuntimeRegistrationInput,
  RuntimeRegistrationResult,
  StaffRoomContextProvider,
  StaffRoomRetrievalResult,
  TenantSessionMetadata,
  TenantSessionMetadataAdapter,
} from "./contracts.js";

export { createDefaultAilliumBoundary } from "./defaults.js";
export { createLiveAilliumBoundary } from "./live-boundary.js";
export type { AilliumCoreConnectionConfig } from "./live-boundary.js";

export {
  fetchStaffRoomAgentContext,
  getAilliumBoundary,
  isAilliumCoreConfigured,
  registerOperatorRuntimeBestEffort,
  resetAilliumBoundary,
  resolveAgentId,
  resolveAilliumCoreConfig,
  resolveRuntimeSessionKey,
  resolveTenantId,
} from "./boundary-runtime.js";
export type { OperatorRuntimeSyncOptions } from "./boundary-runtime.js";

export { resetStaffRoomCache, wrapContextEngineForAillium } from "./context-engine-forwarding.js";

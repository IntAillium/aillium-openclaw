import { createDefaultAilliumBoundary } from "./defaults.js";
import { createLiveAilliumBoundary, type AilliumCoreConnectionConfig } from "./live-boundary.js";
import type { AilliumIntegrationBoundary } from "./contracts.js";

let cached: AilliumIntegrationBoundary | undefined;

export interface AilliumBoundaryEnv {
  AILLIUM_CORE_URL?: string;
  AILLIUM_RUNTIME_SYNC_TOKEN?: string;
  AILLIUM_RUNTIME_TIMEOUT_MS?: string;
}

/**
 * Resolve the Aillium integration boundary from environment.
 * Returns a live boundary when both AILLIUM_CORE_URL and AILLIUM_RUNTIME_SYNC_TOKEN
 * are set; otherwise returns the no-op default. Result is cached per process.
 *
 * Pass `env` for testing; defaults to `process.env`.
 */
export function resolveAilliumBoundary(env: AilliumBoundaryEnv = process.env): AilliumIntegrationBoundary {
  if (cached) {
    return cached;
  }
  const baseUrl = env.AILLIUM_CORE_URL?.trim();
  const syncToken = env.AILLIUM_RUNTIME_SYNC_TOKEN?.trim();
  const timeoutRaw = env.AILLIUM_RUNTIME_TIMEOUT_MS?.trim();
  if (baseUrl && syncToken) {
    const config: AilliumCoreConnectionConfig = {
      baseUrl,
      syncToken,
      timeoutMs: timeoutRaw ? Number.parseInt(timeoutRaw, 10) : undefined,
    };
    cached = createLiveAilliumBoundary(config);
  } else {
    cached = createDefaultAilliumBoundary();
  }
  return cached;
}

/** Test-only: clear the cached boundary. */
export function __resetAilliumBoundaryForTest(): void {
  cached = undefined;
}

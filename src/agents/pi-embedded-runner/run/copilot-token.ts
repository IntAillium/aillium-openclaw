import { log } from "../logger.js";
import { describeUnknownError } from "../utils.js";

export const COPILOT_REFRESH_MARGIN_MS = 5 * 60 * 1000;
export const COPILOT_REFRESH_RETRY_MS = 60 * 1000;
export const COPILOT_REFRESH_MIN_DELAY_MS = 5 * 1000;

// Structural interface — keeps this module decoupled from the concrete
// authStorage implementation in model-auth.ts.
export interface CopilotAuthStorage {
  setRuntimeApiKey(provider: string, token: string): void;
}

export interface CopilotTokenManagerDeps {
  provider: string;
  authStorage: CopilotAuthStorage;
}

/**
 * Encapsulates the GitHub Copilot API token refresh lifecycle. Owns its own
 * timer + cancellation flag so the embedded runner does not have to thread
 * five intertwined helper closures through its retry loop.
 *
 * Usage:
 *   const manager = new CopilotTokenManager({ provider, authStorage });
 *   manager.setCredentials(githubToken, expiresAt); // schedules refresh
 *   await manager.refresh("auth-error");            // forces refresh
 *   manager.stop();                                 // on teardown
 */
export class CopilotTokenManager {
  private githubToken = "";
  private expiresAt = 0;
  private refreshTimer?: ReturnType<typeof setTimeout>;
  private refreshInFlight?: Promise<void>;
  private cancelled = false;

  constructor(private readonly deps: CopilotTokenManagerDeps) {}

  hasGithubToken(): boolean {
    return this.githubToken.trim().length > 0;
  }

  /**
   * Stores the GitHub token + Copilot expiry and schedules the next refresh.
   * Called after a fresh Copilot token is minted (initial auth or rotation).
   */
  setCredentials(githubToken: string, expiresAt: number): void {
    this.githubToken = githubToken;
    this.expiresAt = expiresAt;
    this.scheduleRefresh();
  }

  /**
   * Force a refresh now. Used both by the scheduled timer and by the
   * auth-error recovery path. Coalesces concurrent refreshes via
   * refreshInFlight.
   */
  async refresh(reason: string): Promise<void> {
    if (this.refreshInFlight) {
      await this.refreshInFlight;
      return;
    }
    const { resolveCopilotApiToken } = await import(
      "../../../providers/github-copilot-token.js"
    );
    this.refreshInFlight = (async () => {
      const githubToken = this.githubToken.trim();
      if (!githubToken) {
        throw new Error("Copilot refresh requires a GitHub token.");
      }
      log.debug(`Refreshing GitHub Copilot token (${reason})...`);
      const copilotToken = await resolveCopilotApiToken({ githubToken });
      this.deps.authStorage.setRuntimeApiKey(
        this.deps.provider,
        copilotToken.token,
      );
      this.expiresAt = copilotToken.expiresAt;
      const remaining = copilotToken.expiresAt - Date.now();
      log.debug(
        `Copilot token refreshed; expires in ${Math.max(0, Math.floor(remaining / 1000))}s.`,
      );
    })()
      .catch((err) => {
        log.warn(`Copilot token refresh failed: ${describeUnknownError(err)}`);
        throw err;
      })
      .finally(() => {
        this.refreshInFlight = undefined;
      });
    await this.refreshInFlight;
  }

  /**
   * Schedules the next refresh based on the current expiry. Safe to call
   * repeatedly; clears any existing timer first.
   */
  scheduleRefresh(): void {
    if (this.cancelled) {
      return;
    }
    if (!this.hasGithubToken()) {
      log.warn("Skipping Copilot refresh scheduling; GitHub token missing.");
      return;
    }
    this.clearTimer();
    const now = Date.now();
    const refreshAt = this.expiresAt - COPILOT_REFRESH_MARGIN_MS;
    const delayMs = Math.max(COPILOT_REFRESH_MIN_DELAY_MS, refreshAt - now);
    const timer = setTimeout(() => {
      if (this.cancelled) {
        return;
      }
      this.refresh("scheduled")
        .then(() => this.scheduleRefresh())
        .catch(() => {
          if (this.cancelled) {
            return;
          }
          const retryTimer = setTimeout(() => {
            if (this.cancelled) {
              return;
            }
            this.refresh("scheduled-retry")
              .then(() => this.scheduleRefresh())
              .catch(() => undefined);
          }, COPILOT_REFRESH_RETRY_MS);
          this.refreshTimer = retryTimer;
          if (this.cancelled) {
            clearTimeout(retryTimer);
            this.refreshTimer = undefined;
          }
        });
    }, delayMs);
    this.refreshTimer = timer;
    if (this.cancelled) {
      clearTimeout(timer);
      this.refreshTimer = undefined;
    }
  }

  /** Cancels any pending refresh and prevents new ones from being scheduled. */
  stop(): void {
    this.cancelled = true;
    this.clearTimer();
  }

  private clearTimer(): void {
    if (this.refreshTimer === undefined) {
      return;
    }
    clearTimeout(this.refreshTimer);
    this.refreshTimer = undefined;
  }
}

import type { Express } from "express";
import express from "express";
import { browserMutationGuardMiddleware } from "./csrf.js";
import { isAuthorizedBrowserRequest } from "./http-auth.js";

/**
 * Attach the request cancellation signal on runtimes that do not expose one.
 *
 * Node 24.18+ provides an inherited, getter-only `IncomingMessage.signal`.
 * Assigning to it throws before Express reaches a route and turns every
 * request into an HTML 500 response. Prefer the runtime signal when present
 * and only define the compatibility property for older Node versions.
 */
export function attachBrowserRequestSignal(request: object, signal: AbortSignal): void {
  if ("signal" in request) {
    return;
  }
  Object.defineProperty(request, "signal", {
    configurable: true,
    enumerable: false,
    value: signal,
  });
}

export function installBrowserCommonMiddleware(app: Express) {
  app.use((req, res, next) => {
    const ctrl = new AbortController();
    const abort = () => ctrl.abort(new Error("request aborted"));
    req.once("aborted", abort);
    res.once("close", () => {
      if (!res.writableEnded) {
        abort();
      }
    });
    // Make the signal available to browser route handlers (best-effort).
    attachBrowserRequestSignal(req, ctrl.signal);
    next();
  });
  app.use(express.json({ limit: "1mb" }));
  app.use(browserMutationGuardMiddleware());
}

export function installBrowserAuthMiddleware(
  app: Express,
  auth: { token?: string; password?: string },
) {
  if (!auth.token && !auth.password) {
    return;
  }
  app.use((req, res, next) => {
    if (isAuthorizedBrowserRequest(req, auth)) {
      return next();
    }
    res.status(401).send("Unauthorized");
  });
}

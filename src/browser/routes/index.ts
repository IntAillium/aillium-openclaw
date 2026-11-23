import { activeOperatorLease, withBrowserProfileLock } from "../operator-control.js";
import type { BrowserRouteContext } from "../server-context.js";
import { registerBrowserAgentRoutes } from "./agent.js";
import { registerBrowserAilliumRoutes } from "./aillium.js";
import { registerBrowserBasicRoutes } from "./basic.js";
import { registerBrowserTabRoutes } from "./tabs.js";
import type { BrowserRouteRegistrar } from "./types.js";

export function registerBrowserRoutes(app: BrowserRouteRegistrar, ctx: BrowserRouteContext) {
  const guarded: BrowserRouteRegistrar = {
    get: (path, handler) => app.get(path, handler),
    post: (path, handler) =>
      app.post(path, async (req, res) => {
        let profile: string;
        try {
          profile = ctx.forProfile(
            typeof req.query.profile === "string" ? req.query.profile : undefined,
          ).profile.name;
        } catch {
          await handler(req, res);
          return;
        }
        await withBrowserProfileLock(profile, async () => {
          if (path !== "/screenshot" && activeOperatorLease(profile)) {
            res.status(409).json({
              error: "Browser is under operator control. Wait until the operator finishes.",
            });
            return;
          }
          await handler(req, res);
        });
      }),
    delete: (path, handler) =>
      app.delete(path, async (req, res) => {
        const profile =
          req.params.name ||
          ctx.forProfile(typeof req.query.profile === "string" ? req.query.profile : undefined)
            .profile.name;
        await withBrowserProfileLock(profile, async () => {
          if (activeOperatorLease(profile)) {
            res.status(409).json({ error: "Browser is under operator control." });
            return;
          }
          await handler(req, res);
        });
      }),
  };
  registerBrowserBasicRoutes(guarded, ctx);
  registerBrowserTabRoutes(guarded, ctx);
  registerBrowserAgentRoutes(guarded, ctx);
  registerBrowserAilliumRoutes(guarded, ctx);
}

import type { BrowserRouteContext } from "../server-context.js";
import { registerBrowserAgentRoutes } from "./agent.js";
import { registerBrowserAilliumRoutes } from "./aillium.js";
import { registerBrowserBasicRoutes } from "./basic.js";
import { registerBrowserTabRoutes } from "./tabs.js";
import type { BrowserRouteRegistrar } from "./types.js";

export function registerBrowserRoutes(app: BrowserRouteRegistrar, ctx: BrowserRouteContext) {
  registerBrowserBasicRoutes(app, ctx);
  registerBrowserTabRoutes(app, ctx);
  registerBrowserAgentRoutes(app, ctx);
  registerBrowserAilliumRoutes(app, ctx);
}

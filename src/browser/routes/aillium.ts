import { createSubsystemLogger } from "../../logging/subsystem.js";
import { getBrowserProfileCapabilities } from "../profile-capabilities.js";
import { getAilliumOverlayStatus, normalizeOverlayState } from "../pw-aillium-overlay.js";
import type { BrowserRouteContext } from "../server-context.js";
import { getPwAiModule, readBody, resolveProfileContext } from "./agent.shared.js";
import type { BrowserRouteRegistrar } from "./types.js";
import { jsonError } from "./utils.js";

const log = createSubsystemLogger("browser").child("aillium");

/** True when the caller only wants to change a browser that shows Aillium in charge, and it does not. */
export function skipsInactiveOverlay(onlyIfActive: unknown, current: string): boolean {
  return onlyIfActive === true && current !== "control" && current !== "decision";
}

/**
 * Aillium's browser overlay: shows on the page whether Aillium is in control,
 * waiting for a decision, or has let go. Never launches a browser just to show it.
 */
export function registerBrowserAilliumRoutes(app: BrowserRouteRegistrar, ctx: BrowserRouteContext) {
  app.post("/aillium/overlay", async (req, res) => {
    const profileCtx = resolveProfileContext(req, res, ctx);
    if (!profileCtx) {
      return;
    }
    const body = readBody(req);
    const state = normalizeOverlayState(body.state);
    if (!state) {
      return jsonError(res, 400, "state must be control, decision, released or off");
    }
    const message = typeof body.message === "string" ? body.message : null;
    // "onlyIfActive" hands back a browser only when it shows Aillium in charge,
    // so a run that never touched the browser leaves its pages alone.
    const current = getAilliumOverlayStatus(profileCtx.profile.cdpUrl).state;
    if (skipsInactiveOverlay(body.onlyIfActive, current)) {
      return res.json({ ok: true, applied: false, previous: current, reason: "not in control" });
    }
    if (getBrowserProfileCapabilities(profileCtx.profile).usesChromeMcp) {
      return res.json({ ok: true, applied: false, reason: "not supported for this profile" });
    }
    const pw = await getPwAiModule();
    if (!pw) {
      return res.json({ ok: true, applied: false, reason: "Playwright is not available" });
    }
    try {
      if (!(await profileCtx.isReachable(1_500))) {
        return res.json({ ok: true, applied: false, reason: "browser is not running" });
      }
      const status = await pw.setAilliumOverlayViaPlaywright({
        cdpUrl: profileCtx.profile.cdpUrl,
        state,
        message,
      });
      log.info(
        `[aillium] browser overlay ${profileCtx.profile.name}: ${status.state}${status.message ? ` (${status.message})` : ""} on ${status.pages} page(s)`,
      );
      res.json({ ok: true, applied: true, ...status });
    } catch (err) {
      jsonError(res, 500, `Could not update the browser overlay: ${String(err)}`);
    }
  });
}

import { randomUUID } from "node:crypto";
import { z } from "zod";
import { withCdpSocket } from "./cdp.helpers.js";
import { normalizeCdpWsUrl } from "./cdp.js";
import type { BrowserRouteContext } from "./server-context.js";

const identity = { owner: z.string().min(1).max(512), profile: z.string().min(1).max(128) };
const lease = { ...identity, leaseId: z.string().uuid() };
export const operatorControlSchema = z.discriminatedUnion("action", [
  z
    .object({ ...identity, action: z.literal("acquire"), targetId: z.string().min(1).max(256) })
    .strict(),
  z.object({ ...lease, action: z.literal("frame") }).strict(),
  z.object({ ...lease, action: z.literal("release") }).strict(),
  z
    .object({
      ...lease,
      action: z.literal("input"),
      frameId: z.string().uuid(),
      input: z.discriminatedUnion("type", [
        z
          .object({
            type: z.literal("click"),
            x: z.number().min(0).max(1),
            y: z.number().min(0).max(1),
          })
          .strict(),
        z
          .object({
            type: z.literal("scroll"),
            deltaX: z.number().min(-2000).max(2000),
            deltaY: z.number().min(-2000).max(2000),
          })
          .strict(),
        z.object({ type: z.literal("text"), text: z.string().min(1).max(4096) }).strict(),
        z
          .object({
            type: z.literal("key"),
            key: z.enum([
              "Enter",
              "Tab",
              "Backspace",
              "Delete",
              "Escape",
              "ArrowLeft",
              "ArrowRight",
              "ArrowUp",
              "ArrowDown",
              "Home",
              "End",
            ]),
            shift: z.boolean().optional(),
          })
          .strict(),
      ]),
    })
    .strict(),
]);
type ControlRequest = z.infer<typeof operatorControlSchema>;
type Lease = {
  id: string;
  owner: string;
  targetId: string;
  expiresAt: number;
  frameId?: string;
  width?: number;
  height?: number;
};
const leases = new Map<string, Lease>();
const queues = new Map<string, Promise<unknown>>();
const TTL = 45_000;
export class OperatorControlError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
export function activeOperatorLease(profile: string): Lease | undefined {
  const current = leases.get(profile);
  if (current && current.expiresAt <= Date.now()) {
    leases.delete(profile);
    return undefined;
  }
  return current;
}
// One queue also drains an agent action already running when takeover is requested.
export async function withBrowserProfileLock<T>(profile: string, fn: () => Promise<T>): Promise<T> {
  const previous = queues.get(profile) ?? Promise.resolve();
  const pending = previous.catch(() => undefined).then(fn);
  queues.set(profile, pending);
  try {
    return await pending;
  } finally {
    if (queues.get(profile) === pending) {
      queues.delete(profile);
    }
  }
}

export async function runOperatorControl(ctx: BrowserRouteContext, request: ControlRequest) {
  return withBrowserProfileLock(request.profile, async () => {
    let current = activeOperatorLease(request.profile);
    if (request.action === "acquire") {
      if (current) {
        throw new OperatorControlError(409, "This browser is already controlled by an operator.");
      }
      const profile = ctx.forProfile(request.profile);
      if (profile.profile.driver === "existing-session") {
        throw new OperatorControlError(
          409,
          "Use a managed browser profile for interactive control.",
        );
      }
      const tabs = await profile.listTabs();
      if (!tabs.some((tab) => tab.targetId === request.targetId && tab.type !== "browser")) {
        throw new OperatorControlError(409, "The displayed browser tab is no longer available.");
      }
      current = {
        id: randomUUID(),
        owner: request.owner,
        targetId: request.targetId,
        expiresAt: Date.now() + TTL,
      };
      leases.set(request.profile, current);
    } else if (!current || current.id !== request.leaseId || current.owner !== request.owner) {
      throw new OperatorControlError(
        409,
        "Browser control expired or belongs to another operator. Take control again.",
      );
    }
    if (request.action === "release") {
      leases.delete(request.profile);
      return { available: true, released: true };
    }
    const held = current;
    try {
      const profile = ctx.forProfile(request.profile);
      // Exact lookup: never fall back to a different tab after the target closes.
      const tab = (await profile.listTabs()).find((item) => item.targetId === held.targetId);
      if (!tab?.wsUrl) {
        throw new OperatorControlError(
          409,
          "The controlled tab closed or does not support direct input.",
        );
      }
      return await withCdpSocket(
        normalizeCdpWsUrl(tab.wsUrl, profile.profile.cdpUrl),
        async (rawSend) => {
          const send = async (method: string, params?: Record<string, unknown>) => {
            let timer: ReturnType<typeof setTimeout> | undefined;
            try {
              return await Promise.race([
                rawSend(method, params),
                new Promise<never>((_, reject) => {
                  timer = setTimeout(
                    () => reject(new OperatorControlError(504, "Browser input timed out.")),
                    10_000,
                  );
                }),
              ]);
            } finally {
              if (timer) {
                clearTimeout(timer);
              }
            }
          };
          // Wake a background renderer before requesting a frame or input.
          await send("Page.bringToFront");
          const metrics = (await send("Page.getLayoutMetrics")) as {
            cssLayoutViewport?: { clientWidth: number; clientHeight: number };
          };
          const width = metrics.cssLayoutViewport?.clientWidth;
          const height = metrics.cssLayoutViewport?.clientHeight;
          if (!width || !height) {
            throw new OperatorControlError(409, "Browser viewport is unavailable.");
          }
          if (request.action === "input") {
            if (
              request.frameId !== held.frameId ||
              held.width !== width ||
              held.height !== height
            ) {
              throw new OperatorControlError(
                409,
                "The browser frame changed. Wait for a fresh frame and try again.",
              );
            }
            const input = request.input;
            if (input.type === "click") {
              const point = {
                x: Math.min(width - 1, input.x * width),
                y: Math.min(height - 1, input.y * height),
                button: "left",
                clickCount: 1,
              };
              await send("Input.dispatchMouseEvent", { ...point, type: "mousePressed" });
              await send("Input.dispatchMouseEvent", { ...point, type: "mouseReleased" });
            } else if (input.type === "scroll") {
              await send("Input.dispatchMouseEvent", {
                type: "mouseWheel",
                x: width / 2,
                y: height / 2,
                deltaX: input.deltaX,
                deltaY: input.deltaY,
              });
            } else if (input.type === "text") {
              await send("Input.insertText", { text: input.text });
            } else {
              const codes: Record<string, number> = {
                Enter: 13,
                Tab: 9,
                Backspace: 8,
                Delete: 46,
                Escape: 27,
                ArrowLeft: 37,
                ArrowUp: 38,
                ArrowRight: 39,
                ArrowDown: 40,
                Home: 36,
                End: 35,
              };
              const key = {
                key: input.key,
                code: input.key,
                windowsVirtualKeyCode: codes[input.key],
                modifiers: input.shift ? 8 : 0,
              };
              await send("Input.dispatchKeyEvent", {
                ...key,
                type: input.key === "Enter" ? "keyDown" : "rawKeyDown",
                ...(input.key === "Enter" ? { text: "\r", unmodifiedText: "\r" } : {}),
              });
              await send("Input.dispatchKeyEvent", { ...key, type: "keyUp" });
            }
          }
          const shot = (await send("Page.captureScreenshot", {
            format: "jpeg",
            quality: 80,
            fromSurface: true,
            captureBeyondViewport: false,
          })) as { data?: string };
          if (!shot.data) {
            throw new OperatorControlError(502, "Browser did not return a frame.");
          }
          held.frameId = randomUUID();
          held.width = width;
          held.height = height;
          held.expiresAt = Date.now() + TTL;
          return {
            available: true,
            leaseId: held.id,
            frameId: held.frameId,
            targetId: held.targetId,
            width,
            height,
            expiresAt: held.expiresAt,
            dataUrl: `data:image/jpeg;base64,${shot.data}`,
            url: tab.url,
            capturedAt: new Date().toISOString(),
          };
        },
      );
    } catch (error) {
      // A rejected input can be retried with a fresh frame; transport failures
      // release the lease so a disconnected operator cannot strand the agent.
      if (!(error instanceof OperatorControlError) || error.status !== 409) {
        leases.delete(request.profile);
      }
      if (request.action === "acquire") {
        leases.delete(request.profile);
      }
      throw error;
    }
  });
}

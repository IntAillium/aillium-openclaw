import { describe, expect, it, vi } from "vitest";
import type { GatewayClient } from "../gateway/client.js";
import { NodeInvocationRuntime } from "./invocation-runtime.js";
import type { NodeInvokeRequestPayload, SkillBinsProvider } from "./invoke.js";

describe("NodeInvocationRuntime", () => {
  it("aborts only the requested invocation and acknowledges after it drains", async () => {
    const signals = new Map<string, AbortSignal>();
    const completions = new Map<string, () => void>();
    const request = vi.fn(async () => ({}));
    const client = { request } as unknown as GatewayClient;
    const skillBins = {} as SkillBinsProvider;
    const runtime = new NodeInvocationRuntime(
      client,
      skillBins,
      async (frame: NodeInvokeRequestPayload, _client, _skillBins, signal) => {
        signals.set(frame.id, signal);
        await new Promise<void>((resolve) => {
          completions.set(frame.id, resolve);
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
      },
    );

    expect(
      runtime.handleRequest({ id: "invoke-1", nodeId: "node-1", command: "browser.proxy" }),
    ).toBe(true);
    expect(
      runtime.handleRequest({ id: "invoke-2", nodeId: "node-1", command: "browser.proxy" }),
    ).toBe(true);

    await runtime.handleCancel({ nodeId: "node-1", invocationId: "invoke-1" });

    expect(signals.get("invoke-1")?.aborted).toBe(true);
    expect(signals.get("invoke-2")?.aborted).toBe(false);
    expect(request).toHaveBeenCalledWith("node.invoke.cancel.result", {
      nodeId: "node-1",
      invocationId: "invoke-1",
      acknowledged: true,
      completed: true,
    });

    completions.get("invoke-2")?.();
  });
});

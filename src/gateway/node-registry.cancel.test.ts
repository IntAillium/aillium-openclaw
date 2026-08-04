import { describe, expect, it, vi } from "vitest";
import { NodeRegistry } from "./node-registry.js";
import type { GatewayWsClient } from "./server/ws-types.js";

function registerNode(registry: NodeRegistry) {
  const send = vi.fn();
  const client = {
    connId: "node-connection",
    connect: {
      device: { id: "node-1" },
      client: { id: "node-host", platform: "linux", mode: "node" },
      caps: ["browser"],
    },
    socket: { send },
  } as unknown as GatewayWsClient;
  registry.register(client, {});
  return send;
}

function sentEvents(send: ReturnType<typeof vi.fn>) {
  return send.mock.calls.map(([raw]) => JSON.parse(String(raw)) as Record<string, unknown>);
}

describe("NodeRegistry invocation cancellation", () => {
  it("cancels one owned invocation and waits for the matching node acknowledgement", async () => {
    const registry = new NodeRegistry();
    const send = registerNode(registry);
    const first = registry.invoke({
      nodeId: "node-1",
      command: "browser.proxy",
      invocationId: "invoke-1",
      ownerConnId: "caller-1",
      timeoutMs: 5_000,
    });
    const second = registry.invoke({
      nodeId: "node-1",
      command: "browser.proxy",
      invocationId: "invoke-2",
      ownerConnId: "caller-1",
      timeoutMs: 5_000,
    });

    const cancellation = registry.cancelInvoke({
      nodeId: "node-1",
      invocationId: "invoke-1",
      ownerConnId: "caller-1",
    });
    expect(sentEvents(send).at(-1)).toMatchObject({
      event: "node.invoke.cancel",
      payload: { nodeId: "node-1", invocationId: "invoke-1" },
    });

    expect(
      registry.handleInvokeCancelResult({
        nodeId: "node-1",
        invocationId: "invoke-1",
        acknowledged: true,
        completed: true,
      }),
    ).toBe(true);
    await expect(cancellation).resolves.toEqual({ acknowledged: true, completed: true });

    registry.handleInvokeResult({ id: "invoke-1", nodeId: "node-1", ok: false });
    registry.handleInvokeResult({ id: "invoke-2", nodeId: "node-1", ok: true });
    await expect(first).resolves.toMatchObject({ ok: false });
    await expect(second).resolves.toMatchObject({ ok: true });
  });

  it("rejects cross-connection cancellation without touching either invocation", async () => {
    const registry = new NodeRegistry();
    const send = registerNode(registry);
    const first = registry.invoke({
      nodeId: "node-1",
      command: "browser.proxy",
      invocationId: "invoke-1",
      ownerConnId: "caller-1",
    });
    const second = registry.invoke({
      nodeId: "node-1",
      command: "browser.proxy",
      invocationId: "invoke-2",
      ownerConnId: "caller-2",
    });
    const before = send.mock.calls.length;

    await expect(
      registry.cancelInvoke({
        nodeId: "node-1",
        invocationId: "invoke-2",
        ownerConnId: "caller-1",
      }),
    ).resolves.toMatchObject({
      acknowledged: false,
      completed: false,
      error: { code: "FORBIDDEN" },
    });
    expect(send).toHaveBeenCalledTimes(before);

    registry.handleInvokeResult({ id: "invoke-1", nodeId: "node-1", ok: true });
    registry.handleInvokeResult({ id: "invoke-2", nodeId: "node-1", ok: true });
    await Promise.all([first, second]);
  });
});

import type { GatewayClient } from "../gateway/client.js";
import {
  coerceNodeInvokePayload,
  handleInvoke,
  type NodeInvokeRequestPayload,
  type SkillBinsProvider,
} from "./invoke.js";

export type NodeInvokeCancelPayload = {
  nodeId: string;
  invocationId: string;
};

type InvokeHandler = (
  frame: NodeInvokeRequestPayload,
  client: GatewayClient,
  skillBins: SkillBinsProvider,
  abortSignal: AbortSignal,
) => Promise<void>;

type ActiveInvocation = {
  controller: AbortController;
  completion: Promise<void>;
};

const CANCEL_COMPLETION_WAIT_MS = 1_000;

export function coerceNodeInvokeCancelPayload(payload: unknown): NodeInvokeCancelPayload | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const raw = payload as Record<string, unknown>;
  const nodeId = typeof raw.nodeId === "string" ? raw.nodeId.trim() : "";
  const invocationId = typeof raw.invocationId === "string" ? raw.invocationId.trim() : "";
  return nodeId && invocationId ? { nodeId, invocationId } : null;
}

export class NodeInvocationRuntime {
  private readonly active = new Map<string, ActiveInvocation>();

  constructor(
    private readonly client: GatewayClient,
    private readonly skillBins: SkillBinsProvider,
    private readonly invokeHandler: InvokeHandler = handleInvoke,
  ) {}

  handleRequest(payload: unknown): boolean {
    const frame = coerceNodeInvokePayload(payload);
    if (!frame || this.active.has(frame.id)) {
      return false;
    }
    const controller = new AbortController();
    const completion = this.invokeHandler(
      frame,
      this.client,
      this.skillBins,
      controller.signal,
    ).finally(() => {
      const current = this.active.get(frame.id);
      if (current?.controller === controller) {
        this.active.delete(frame.id);
      }
    });
    // Keep the completion observed even if a transport failure escapes the invoke handler.
    void completion.catch(() => undefined);
    this.active.set(frame.id, { controller, completion });
    return true;
  }

  async handleCancel(payload: unknown): Promise<boolean> {
    const cancellation = coerceNodeInvokeCancelPayload(payload);
    if (!cancellation) {
      return false;
    }
    const active = this.active.get(cancellation.invocationId);
    if (!active) {
      await this.sendCancellationResult(cancellation, false, true);
      return true;
    }
    active.controller.abort(new Error("node invocation cancelled by caller"));
    const completed = await this.waitForCompletion(active.completion);
    await this.sendCancellationResult(cancellation, true, completed);
    return true;
  }

  private async waitForCompletion(completion: Promise<void>): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        completion.then(
          () => true,
          () => true,
        ),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), CANCEL_COMPLETION_WAIT_MS);
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }

  private async sendCancellationResult(
    cancellation: NodeInvokeCancelPayload,
    acknowledged: boolean,
    completed: boolean,
  ): Promise<void> {
    try {
      await this.client.request("node.invoke.cancel.result", {
        nodeId: cancellation.nodeId,
        invocationId: cancellation.invocationId,
        acknowledged,
        completed,
      });
    } catch {
      // Cancellation acknowledgements are best-effort if the gateway connection disappears.
    }
  }
}

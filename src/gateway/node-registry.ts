import { randomUUID } from "node:crypto";
import type { GatewayWsClient } from "./server/ws-types.js";

export type NodeSession = {
  nodeId: string;
  connId: string;
  client: GatewayWsClient;
  displayName?: string;
  platform?: string;
  version?: string;
  coreVersion?: string;
  uiVersion?: string;
  deviceFamily?: string;
  modelIdentifier?: string;
  remoteIp?: string;
  caps: string[];
  commands: string[];
  permissions?: Record<string, boolean>;
  pathEnv?: string;
  connectedAtMs: number;
};

type PendingInvoke = {
  nodeId: string;
  command: string;
  ownerConnId?: string;
  resolve: (value: NodeInvokeResult) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

type PendingInvokeCancel = {
  nodeId: string;
  resolve: (value: NodeInvokeCancellationResult) => void;
  timer: ReturnType<typeof setTimeout>;
};

export type NodeInvokeResult = {
  ok: boolean;
  payload?: unknown;
  payloadJSON?: string | null;
  error?: { code?: string; message?: string } | null;
};

export type NodeInvokeCancellationResult = {
  acknowledged: boolean;
  completed: boolean;
  error?: { code: string; message: string };
};

export class NodeRegistry {
  private nodesById = new Map<string, NodeSession>();
  private nodesByConn = new Map<string, string>();
  private pendingInvokes = new Map<string, PendingInvoke>();
  private pendingInvokeCancels = new Map<string, PendingInvokeCancel>();

  register(client: GatewayWsClient, opts: { remoteIp?: string | undefined }) {
    const connect = client.connect;
    const nodeId = connect.device?.id ?? connect.client.id;
    const caps = Array.isArray(connect.caps) ? connect.caps : [];
    const commands = Array.isArray((connect as { commands?: string[] }).commands)
      ? ((connect as { commands?: string[] }).commands ?? [])
      : [];
    const permissions =
      typeof (connect as { permissions?: Record<string, boolean> }).permissions === "object"
        ? ((connect as { permissions?: Record<string, boolean> }).permissions ?? undefined)
        : undefined;
    const pathEnv =
      typeof (connect as { pathEnv?: string }).pathEnv === "string"
        ? (connect as { pathEnv?: string }).pathEnv
        : undefined;
    const session: NodeSession = {
      nodeId,
      connId: client.connId,
      client,
      displayName: connect.client.displayName,
      platform: connect.client.platform,
      version: connect.client.version,
      coreVersion: (connect as { coreVersion?: string }).coreVersion,
      uiVersion: (connect as { uiVersion?: string }).uiVersion,
      deviceFamily: connect.client.deviceFamily,
      modelIdentifier: connect.client.modelIdentifier,
      remoteIp: opts.remoteIp,
      caps,
      commands,
      permissions,
      pathEnv,
      connectedAtMs: Date.now(),
    };
    this.nodesById.set(nodeId, session);
    this.nodesByConn.set(client.connId, nodeId);
    return session;
  }

  unregister(connId: string): string | null {
    const nodeId = this.nodesByConn.get(connId);
    if (!nodeId) {
      return null;
    }
    this.nodesByConn.delete(connId);
    this.nodesById.delete(nodeId);
    for (const [id, pending] of this.pendingInvokes.entries()) {
      if (pending.nodeId !== nodeId) {
        continue;
      }
      clearTimeout(pending.timer);
      pending.reject(new Error(`node disconnected (${pending.command})`));
      this.pendingInvokes.delete(id);
    }
    for (const [key, pending] of this.pendingInvokeCancels.entries()) {
      if (pending.nodeId !== nodeId) {
        continue;
      }
      clearTimeout(pending.timer);
      pending.resolve({
        acknowledged: false,
        completed: false,
        error: { code: "NOT_CONNECTED", message: "node disconnected during cancellation" },
      });
      this.pendingInvokeCancels.delete(key);
    }
    return nodeId;
  }

  listConnected(): NodeSession[] {
    return [...this.nodesById.values()];
  }

  get(nodeId: string): NodeSession | undefined {
    return this.nodesById.get(nodeId);
  }

  async invoke(params: {
    nodeId: string;
    command: string;
    params?: unknown;
    timeoutMs?: number;
    idempotencyKey?: string;
    invocationId?: string;
    ownerConnId?: string;
  }): Promise<NodeInvokeResult> {
    const node = this.nodesById.get(params.nodeId);
    if (!node) {
      return {
        ok: false,
        error: { code: "NOT_CONNECTED", message: "node not connected" },
      };
    }
    const requestId = params.invocationId?.trim() || randomUUID();
    if (this.pendingInvokes.has(requestId)) {
      return {
        ok: false,
        error: { code: "CONFLICT", message: "node invocation already active" },
      };
    }
    const payload = {
      id: requestId,
      nodeId: params.nodeId,
      command: params.command,
      paramsJSON:
        "params" in params && params.params !== undefined ? JSON.stringify(params.params) : null,
      timeoutMs: params.timeoutMs,
      idempotencyKey: params.idempotencyKey,
    };
    const timeoutMs = typeof params.timeoutMs === "number" ? params.timeoutMs : 30_000;
    return await new Promise<NodeInvokeResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingInvokes.delete(requestId);
        resolve({
          ok: false,
          error: { code: "TIMEOUT", message: "node invoke timed out" },
        });
      }, timeoutMs);
      this.pendingInvokes.set(requestId, {
        nodeId: params.nodeId,
        command: params.command,
        ownerConnId: params.ownerConnId,
        resolve,
        reject,
        timer,
      });
      const ok = this.sendEventToSession(node, "node.invoke.request", payload);
      if (!ok) {
        clearTimeout(timer);
        this.pendingInvokes.delete(requestId);
        resolve({
          ok: false,
          error: { code: "UNAVAILABLE", message: "failed to send invoke to node" },
        });
      }
    });
  }

  async cancelInvoke(params: {
    nodeId: string;
    invocationId: string;
    ownerConnId?: string;
    timeoutMs?: number;
  }): Promise<NodeInvokeCancellationResult> {
    const invocationId = params.invocationId.trim();
    const pendingInvoke = this.pendingInvokes.get(invocationId);
    if (!pendingInvoke || pendingInvoke.nodeId !== params.nodeId) {
      return {
        acknowledged: false,
        completed: true,
        error: { code: "NOT_FOUND", message: "node invocation is no longer active" },
      };
    }
    if (
      pendingInvoke.ownerConnId &&
      (!params.ownerConnId || pendingInvoke.ownerConnId !== params.ownerConnId)
    ) {
      return {
        acknowledged: false,
        completed: false,
        error: { code: "FORBIDDEN", message: "node invocation belongs to another connection" },
      };
    }
    const node = this.nodesById.get(params.nodeId);
    if (!node) {
      return {
        acknowledged: false,
        completed: false,
        error: { code: "NOT_CONNECTED", message: "node not connected" },
      };
    }
    const key = `${params.nodeId}:${invocationId}`;
    if (this.pendingInvokeCancels.has(key)) {
      return {
        acknowledged: false,
        completed: false,
        error: { code: "CONFLICT", message: "node invocation cancellation already pending" },
      };
    }
    const timeoutMs = Math.max(1, Math.min(params.timeoutMs ?? 1_500, 5_000));
    return await new Promise<NodeInvokeCancellationResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingInvokeCancels.delete(key);
        resolve({
          acknowledged: false,
          completed: false,
          error: { code: "TIMEOUT", message: "node invocation cancellation timed out" },
        });
      }, timeoutMs);
      this.pendingInvokeCancels.set(key, { nodeId: params.nodeId, resolve, timer });
      const sent = this.sendEventToSession(node, "node.invoke.cancel", {
        nodeId: params.nodeId,
        invocationId,
      });
      if (!sent) {
        clearTimeout(timer);
        this.pendingInvokeCancels.delete(key);
        resolve({
          acknowledged: false,
          completed: false,
          error: { code: "UNAVAILABLE", message: "failed to send cancellation to node" },
        });
      }
    });
  }

  cancelInvokesByOwner(ownerConnId: string): number {
    let sent = 0;
    for (const [invocationId, pending] of this.pendingInvokes.entries()) {
      if (pending.ownerConnId !== ownerConnId) {
        continue;
      }
      if (
        this.sendEvent(pending.nodeId, "node.invoke.cancel", {
          nodeId: pending.nodeId,
          invocationId,
        })
      ) {
        sent += 1;
      }
    }
    return sent;
  }

  handleInvokeResult(params: {
    id: string;
    nodeId: string;
    ok: boolean;
    payload?: unknown;
    payloadJSON?: string | null;
    error?: { code?: string; message?: string } | null;
  }): boolean {
    const pending = this.pendingInvokes.get(params.id);
    if (!pending) {
      return false;
    }
    if (pending.nodeId !== params.nodeId) {
      return false;
    }
    clearTimeout(pending.timer);
    this.pendingInvokes.delete(params.id);
    pending.resolve({
      ok: params.ok,
      payload: params.payload,
      payloadJSON: params.payloadJSON ?? null,
      error: params.error ?? null,
    });
    return true;
  }

  handleInvokeCancelResult(params: {
    invocationId: string;
    nodeId: string;
    acknowledged: boolean;
    completed: boolean;
  }): boolean {
    const key = `${params.nodeId}:${params.invocationId}`;
    const pending = this.pendingInvokeCancels.get(key);
    if (!pending || pending.nodeId !== params.nodeId) {
      return false;
    }
    clearTimeout(pending.timer);
    this.pendingInvokeCancels.delete(key);
    pending.resolve({
      acknowledged: params.acknowledged,
      completed: params.completed,
    });
    return true;
  }

  sendEvent(nodeId: string, event: string, payload?: unknown): boolean {
    const node = this.nodesById.get(nodeId);
    if (!node) {
      return false;
    }
    return this.sendEventToSession(node, event, payload);
  }

  private sendEventInternal(node: NodeSession, event: string, payload: unknown): boolean {
    try {
      node.client.socket.send(
        JSON.stringify({
          type: "event",
          event,
          payload,
        }),
      );
      return true;
    } catch {
      return false;
    }
  }

  private sendEventToSession(node: NodeSession, event: string, payload: unknown): boolean {
    return this.sendEventInternal(node, event, payload);
  }
}

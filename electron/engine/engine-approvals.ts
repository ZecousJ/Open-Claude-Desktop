import { codeExecutionSettings } from "../../shared/code-session-permissions";
import { taskConnectionRequest } from "../../shared/task-connection-hold";
import { randomUUID } from "node:crypto";
import { chatExecutionEnabled } from "../../shared/chat-execution";
import { modeAllowed } from "../../shared/client-policy";
import { allowedMcpServers } from "../../shared/client-policy-rules";
import type { Approval } from "../../shared/types";
import { sessionWideGrant } from "../../shared/approval-grants";
import { SshToolGrantStore, sshServerKey } from "../ssh/tool-grants";
import { coworkFolderRequest } from "../../shared/cowork-folder-request";
import {
  mcpToolApproval,
  withOfferedPersist,
  withToolApproval,
} from "../../shared/mcp-tool-approval";
import {
  allowedByList,
  allowedEntryFor,
  approvalResponse,
} from "../../shared/approval-response";
import { passthroughMethods } from "./mcp-servers";
import type { Engine } from "./engine";

export function request(this: Engine, msg: any) {
  const conversationId = this.routes.get(msg.params?.threadId);
  if (
    !conversationId ||
    this.store.conversation(conversationId).threadId !== msg.params?.threadId
  ) {
    this.rpc?.reject(msg.id, "Unknown or inactive conversation branch");
    return;
  }
  const conversation = this.store.conversation(conversationId);
  const executionApproval = [
    "item/commandExecution/requestApproval",
    "item/fileChange/requestApproval",
    "item/permissions/requestApproval",
  ].includes(msg.method);
  if (
    executionApproval &&
    conversation.mode === "chat" &&
    !chatExecutionEnabled(this.store.settings, "chat")
  ) {
    this.rpc?.respond(
      msg.id,
      msg.method === "item/permissions/requestApproval"
        ? { permissions: {}, scope: "turn" }
        : { decision: "decline" },
    );
    return;
  }
  const sessionSettings = codeExecutionSettings(
    this.store.settings,
    conversation,
  );
  // On every platform.
  if (
    msg.method === "item/fileChange/requestApproval" &&
    sessionSettings.autoAcceptEdits &&
    modeAllowed(this.policy(), "acceptEdits") &&
    !sessionSettings.codePlanMode &&
    this.store.conversation(conversationId).mode === "code"
  ) {
    this.rpc?.respond(msg.id, { decision: "accept" });
    return;
  }
  if (msg.method === "item/tool/call") {
    void this.answerDynamicTool(msg, conversationId);
    return;
  }
  const supported = [
    "item/commandExecution/requestApproval",
    "item/fileChange/requestApproval",
    "item/permissions/requestApproval",
    "item/tool/requestUserInput",
    "tool/requestUserInput",
    "mcpServer/elicitation/request",
  ];
  if (!supported.includes(msg.method)) {
    this.rpc?.reject(msg.id, `Unsupported client request: ${msg.method}`);
    return;
  }
  const approval = {
    id: this.approvalId(msg.id),
    conversationId,
    method: msg.method,
    params: this.offeredParams(msg),
  };
  const sshTool = this.sshToolApproval(approval);
  if (
    sshTool &&
    !sessionSettings.codePlanMode &&
    this.policy().approvalsAlwaysAllow &&
    new SshToolGrantStore(this.store.root).allows(
      sshTool.endpointKey,
      sshTool.server,
      sshTool.toolName,
      sshTool.serverKey,
      sshTool.hostKey,
    )
  ) {
    this.rpc?.respond(msg.id, approvalResponse(approval, "once"));
    return;
  }
  // A routine's run does not ask again for what the person told it to
  // always allow (unless the administrator turned that off).
  const taskId = this.store.conversation(conversationId).scheduledTaskId;
  if (
    taskId &&
    this.routineApprovals?.isUnattended?.(
      this.store.conversation(conversationId),
    ) &&
    this.routineApprovals.holdForConnection
  ) {
    const hold = taskConnectionRequest(
      approval,
      this.store.settings.mcpServers ?? {},
    );
    if (hold) {
      this.routineApprovals.holdForConnection(taskId, hold);
      this.rpc?.respond(msg.id, { action: "cancel" });
      void this.interrupt(conversationId).catch(() => {});
      return;
    }
  }
  if (
    taskId &&
    this.routineApprovals &&
    this.policy().approvalsAlwaysAllow &&
    !(this.environment.kind === "ssh" && mcpToolApproval(approval))
  ) {
    const conversation = this.store.conversation(conversationId);
    if (
      allowedByList(
        this.routineApprovals.allowed(taskId),
        approval,
        conversation,
      )
    ) {
      this.rpc?.respond(msg.id, approvalResponse(approval, "once"));
      return;
    }
  }
  this.ownApprovals.push(approval);
  this.emit({ type: "approval", approval });
}

/**
 * What a window is shown of a request: a connector tool's approval offers
 * "Always allow" (persist "always") only for a connector the person
 * configured, with a known tool, while the administrator allows it.
 */
export function offeredParams(this: Engine, msg: any): any {
  if (msg.method !== "mcpServer/elicitation/request" || !msg.params)
    return msg.params;
  const server = this.store.settings.mcpServers?.[msg.params.serverName];
  // The phones decode JSON into unordered maps: the form's field order
  // (the schema's property order) travels beside it.
  const properties = msg.params.requestedSchema?.properties;
  const withOrder =
    properties && typeof properties === "object" && !Array.isArray(properties)
      ? { ...msg.params, claudexFieldOrder: Object.keys(properties) }
      : msg.params;
  return withOfferedPersist(withOrder, {
    configured:
      (this.environment.kind !== "ssh" ||
        Boolean(this.launcher?.sshToolBinding)) &&
      Boolean(server && typeof server === "object" && !Array.isArray(server)),
    alwaysAllowed: this.policy().approvalsAlwaysAllow !== false,
  });
}

export function sshToolApproval(this: Engine, approval: Approval) {
  if (
    this.environment.kind !== "ssh" ||
    this.store.conversation(approval.conversationId).mode !== "code"
  )
    return;
  const host = this.launcher?.sshHost;
  const binding = this.launcher?.sshToolBinding;
  const info = mcpToolApproval(approval);
  const server =
    info &&
    allowedMcpServers(this.store.settings.mcpServers, this.policy())[
      info.server
    ];
  if (
    !host ||
    !binding ||
    !info?.tool ||
    !server ||
    typeof server !== "object" ||
    Array.isArray(server) ||
    (server as Record<string, unknown>).enabled === false
  )
    return;
  return {
    ...binding,
    server: info.server,
    toolName: info.tool,
    hostLabel: host.label,
    serverLabel: info.connector ?? info.server,
    toolLabel: info.title ?? info.tool,
    serverKey: sshServerKey(server as Record<string, unknown>),
    grantedAt: Date.now(),
  };
}

export function rememberToolApproval(
  this: Engine,
  approval: Approval,
  result: any,
) {
  if (result?.action !== "accept" || result?._meta?.persist !== "always")
    return;
  if (this.environment.kind === "ssh") {
    const grant = this.sshToolApproval(approval);
    if (grant && mcpToolApproval(approval)?.persist.always)
      new SshToolGrantStore(this.store.root).grant(grant);
    return;
  }
  const info = mcpToolApproval(approval);
  const servers = this.store.settings.mcpServers;
  const server = info ? servers[info.server] : undefined;
  if (
    !info?.tool ||
    !info.persist.always ||
    !server ||
    typeof server !== "object" ||
    Array.isArray(server)
  )
    return;
  const current = this.startedMcp === this.runtimeKey();
  servers[info.server] = withToolApproval(
    server as Record<string, unknown>,
    info.tool,
    "approve",
  );
  this.store.flush();
  if (current) this.startedMcp = this.runtimeKey();
  this.onMcpServersRemembered?.();
}

/** A dynamic tool call (S1): an extension answers it, never the window. */
export async function answerDynamicTool(
  this: Engine,
  msg: any,
  conversationId: string,
) {
  const rpc = this.rpc;
  const params = msg.params ?? {};
  const conversation = this.store.conversation(conversationId);
  const result = await this.extensions.handleDynamicTool({
    conversation,
    turn: conversation.turns.find((turn) => turn.id === params.turnId),
    threadId: params.threadId,
    turnId: typeof params.turnId === "string" ? params.turnId : "",
    callId: typeof params.callId === "string" ? params.callId : "",
    namespace: typeof params.namespace === "string" ? params.namespace : null,
    tool: typeof params.tool === "string" ? params.tool : "",
    arguments: params.arguments,
    changed: () => this.changed(conversation),
  });
  // The agent may have restarted while the handler ran.
  if (this.rpc === rpc) rpc?.respond(msg.id, result);
}

/**
 * Asks the window an MCP-elicitation-shaped question of the app's own (the
 * Workflow tool's "Run workflow?"); resolves with the answer, or undefined
 * when the question went away (the turn stopped, the agent restarted).
 */
export function requestAppApproval(
  this: Engine,
  conversationId: string,
  params: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<any> {
  const other = this.elsewhereFor(conversationId);
  if (other) return other.requestAppApproval(conversationId, params, signal);
  const id = `app:${randomUUID()}`;
  const approval: Approval = {
    id,
    conversationId,
    method: "mcpServer/elicitation/request",
    params,
  };
  return new Promise((resolve) => {
    const settle = (result: any) => {
      signal?.removeEventListener("abort", abort);
      resolve(result);
    };
    const abort = () => {
      if (!this.appApprovals.has(id)) return;
      this.appApprovals.delete(id);
      this.ownApprovals = this.ownApprovals.filter((a) => a.id !== id);
      this.emit({ type: "approval-resolved", id });
      settle(undefined);
    };
    signal?.addEventListener("abort", abort, { once: true });
    this.appApprovals.set(id, settle);
    this.ownApprovals.push(approval);
    this.emit({ type: "approval", approval });
  });
}

export function approve(this: Engine, id: string | number, result: any): void {
  const own = this.appApprovals.get(id);
  if (own) {
    this.appApprovals.delete(id);
    this.ownApprovals = this.ownApprovals.filter((a) => a.id !== id);
    this.emit({ type: "approval-resolved", id });
    own(result);
    return;
  }
  const a = this.ownApprovals.find((a) => a.id === id);
  if (!a) {
    // Another engine's request (R9): request ids are per engine.
    const peer = (this.peers?.all() ?? []).find(
      (other) => other !== this && other.ownApprovals.some((v) => v.id === id),
    );
    if (peer) return peer.approve(id, result);
    throw new Error("This request is no longer valid.");
  }
  // The administrator can turn "Always allow" off; the card hides it, and a
  // session-wide grant sent anyway is refused here.
  if (!this.policy().approvalsAlwaysAllow && sessionWideGrant(result))
    throw new Error(
      "Your administrator requires approving each request. Choose Allow once or Deny.",
    );
  // "Always allow" in a routine's run is kept for the routine's later runs.
  if (
    sessionWideGrant(result) &&
    this.routineApprovals &&
    !(this.environment.kind === "ssh" && mcpToolApproval(a))
  ) {
    const conversation = this.store.conversation(a.conversationId);
    const entry = allowedEntryFor(a, conversation);
    if (
      conversation.scheduledTaskId &&
      entry &&
      !coworkFolderRequest(a, conversation)
    )
      try {
        this.routineApprovals.allow(conversation.scheduledTaskId, entry);
      } catch (error) {
        console.error(
          "Always allowed:",
          error instanceof Error ? error.message : String(error),
        );
      }
  }
  this.rememberToolApproval(a, result);
  this.rpc?.respond(
    this.requestIdOf(id),
    this.environment.kind === "ssh" && mcpToolApproval(a)
      ? { ...result, _meta: null }
      : result,
  );
  this.ownApprovals = this.ownApprovals.filter((a) => a.id !== id);
  if (typeof id === "string") this.requestIds.delete(id);
  this.emit({ type: "approval-resolved", id });
}

// E0 engine seams: /compact and steering pass through to the app-server.

/** Sends one of the `passthroughMethods`, and nothing else, to Codex. */
export function forward(this: Engine, method: string, params: object) {
  if (!passthroughMethods.includes(method))
    throw new Error(`${method} is not available to the window.`);
  if (!this.rpc) throw new Error("The Codex engine is not connected.");
  return this.rpc.call(method, params);
}

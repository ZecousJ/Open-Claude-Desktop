import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { approvalResponse } from "../../../shared/approval-response";
import {
  mcpElicitation,
  mcpElicitationResponse,
} from "../../../shared/mcp-elicitation";
import { mcpToolApproval } from "../../../shared/mcp-tool-approval";
import type {
  OfficialCodeApprovalControl,
  OfficialCodeApprovalReply,
} from "../../../shared/official-code-approval";
import type { Approval, Conversation, Settings } from "../../../shared/types";
import { fileWritePermission, toolPermission } from "../native/command-permission";
import { registeredCodeAppToolName } from "../native/code-tool-transcript";

const identities = new WeakMap<
  Approval,
  { requestId: string; toolUseId?: string }
>();
const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

function controlIdentity(approval: Approval, toolUseId?: string) {
  const existing = identities.get(approval);
  if (existing) return existing;
  const identity = { requestId: randomUUID(), toolUseId };
  identities.set(approval, identity);
  return identity;
}

function controlFor(
  conversation: Conversation,
  approval: Approval,
  mcpServers: Settings["mcpServers"],
  commands = false,
): OfficialCodeApprovalControl | undefined {
  if (approval.conversationId !== conversation.id) return;
  if (commands && approval.method === "item/commandExecution/requestApproval") {
    const permission = toolPermission(approval, conversation, mcpServers);
    if (!permission) return;
    const identity = controlIdentity(approval, permission.cliToolUseId);
    return {
      type: "control_request",
      request_id: identity.requestId,
      request: {
        subtype: "can_use_tool",
        tool_use_id: identity.toolUseId ?? identity.requestId,
        tool_name: permission.toolName,
        input: permission.input,
        suppress_always_allow_rule: true,
        requires_user_interaction: true,
      },
    };
  }
  if (approval.method === "item/fileChange/requestApproval") {
    const write = fileWritePermission(approval, conversation);
    if (!write) return;
    const identity = controlIdentity(approval, write.cliToolUseId);
    return {
      type: "control_request",
      request_id: identity.requestId,
      request: {
        subtype: "can_use_tool",
        tool_use_id: identity.toolUseId ?? identity.requestId,
        tool_name: write.toolName,
        input: write.input,
        suppress_always_allow_rule: true,
        requires_user_interaction: true,
      },
    };
  }
  const request = officialMcpApprovalRequest(conversation, approval, mcpServers);
  if (!request) return;
  const identity = controlIdentity(
    approval,
    request.subtype === "can_use_tool" ? request.tool_use_id : undefined,
  );
  return {
    type: "control_request",
    request_id: identity.requestId,
    request:
      request.subtype === "can_use_tool"
        ? { ...request, tool_use_id: identity.toolUseId ?? identity.requestId }
        : request,
  };
}

export function officialMcpApprovalRequest(
  conversation: Conversation,
  approval: Approval,
  mcpServers?: Settings["mcpServers"],
) {
  if (
    approval.conversationId !== conversation.id ||
    approval.method !== "mcpServer/elicitation/request"
  )
    return;
  const params: unknown = approval.params;
  if (
    !isObject(params) ||
    !conversation.threadId ||
    params.threadId !== conversation.threadId
  )
    return;
  const turn = conversation.turns.find(
    (turn) => turn.id === params.turnId && turn.status === "inProgress",
  );
  if (!turn) return;
  const tool = mcpToolApproval(approval);
  if (!tool) {
    const elicitation = mcpElicitation(approval);
    if (!elicitation) return;
    const base = {
      subtype: "elicitation" as const,
      mcp_server_name: elicitation.serverName,
      message: elicitation.message,
    };
    return elicitation.mode === "form"
      ? {
          ...base,
          mode: "form" as const,
          requested_schema: elicitation.requestedSchema,
          property_order: elicitation.fieldNames,
        }
      : {
          ...base,
          mode: "url" as const,
          url: elicitation.url,
          elicitation_id: elicitation.elicitationId,
        };
  }
  if (!tool.server || !tool.tool || !isObject(params._meta)) return;
  const input = params._meta.tool_params;
  if (!isObject(input)) return;
  const items = turn.items.filter(
    (item) =>
      item.type === "mcpToolCall" &&
      item.status === "inProgress" &&
      item.server === tool.server &&
      item.tool === tool.tool &&
      isDeepStrictEqual(item.arguments ?? item.input, input),
  );
  if (!items.length) return;
  const description = params._meta.tool_description;
  return {
    subtype: "can_use_tool" as const,
    tool_use_id:
      items.length === 1 ? `${turn.id}:tool:${items[0].id}` : undefined,
    tool_name: (items.length === 1 && registeredCodeAppToolName(items[0], mcpServers)) ||
      `mcp__${tool.server}__${tool.tool}`,
    input,
    ...(tool.title ? { title: tool.title } : {}),
    ...(typeof description === "string" ? { description } : {}),
    suppress_always_allow_rule: true as const,
    requires_user_interaction: true as const,
  };
}

export function officialCodeApprovalControls(
  conversation: Conversation,
  approvals: readonly Approval[],
  mcpServers: Settings["mcpServers"],
  commands = false,
) {
  if (conversation.mode !== "code" || conversation.archived) return [];
  return approvals.flatMap((approval) => {
    const control = controlFor(conversation, approval, mcpServers, commands);
    return control ? [control] : [];
  });
}

export function officialCodeApprovalResult(
  conversation: Conversation,
  approvals: readonly Approval[],
  reply: OfficialCodeApprovalReply,
  mcpServers: Settings["mcpServers"],
  commands = false,
) {
  const approval = approvals.find(
    (approval) => identities.get(approval)?.requestId === reply.request_id,
  );
  const control = approval && controlFor(conversation, approval, mcpServers, commands);
  if (!approval || !control) return { kind: "stale" } as const;
  return officialApprovalResponse(approval, control.request, reply.response);
}

export function officialApprovalResponse(
  approval: Approval,
  request: OfficialCodeApprovalControl["request"],
  choice: OfficialCodeApprovalReply["response"],
) {
  if (request.subtype === "elicitation") {
    const response = mcpElicitationResponse(approval, choice);
    return response
      ? ({ kind: "ready", id: approval.id, response } as const)
      : ({ kind: "invalid" } as const);
  }
  if (
    !("behavior" in choice) ||
    choice.toolUseID !== request.tool_use_id ||
    (choice.tool_name !== undefined &&
      choice.tool_name !== request.tool_name) ||
    (choice.toolName !== undefined && choice.toolName !== request.tool_name) ||
    (choice.behavior === "allow" &&
      (choice.updatedPermissions !== undefined ||
        !isDeepStrictEqual(choice.updatedInput, request.input)))
  )
    return { kind: "invalid" } as const;
  return {
    kind: "ready",
    id: approval.id,
    response: approvalResponse(
      approval,
      choice.behavior === "allow" ? "once" : "deny",
    ),
  } as const;
}

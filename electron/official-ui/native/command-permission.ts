/** Tool permission shape shared by the official Code and Cowork consumers. */
import { z } from "zod";
import type { Approval, Conversation, Settings } from "../../../shared/types";
import { approvalItem, approvalKind } from "../../../shared/approval-response";
import { mcpElicitation } from "../../../shared/mcp-elicitation";
import { mcpToolApproval } from "../../../shared/mcp-tool-approval";
import { codeFileChangeProjections } from "./code-transcript";
import { registeredCodeAppToolName } from "./code-tool-transcript";
const publicId = (id: string) => `local_${id}`;

/** Official formatSessionForEvent fields used by the local Code renderer. */
export interface ToolPermission {
  requestId: string;
  sessionId: string;
  toolName: string;
  input: Record<string, unknown>;
  toolUseId?: string;
  title?: string;
  cliToolUseId?: string;
  description?: string;
  decisionReason?: string;
  suppressAlwaysAllowRule?: true;
  suggestions?: [CodeToolPermissionSuggestion];
  alwaysAllowEndsWithSession?: true;
}

export interface CodeToolPermissionSuggestion {
  type: "addRules";
  behavior: "allow";
  destination: "session" | "userSettings";
  rules: { toolName: string; ruleContent: string }[];
}

const fileApprovalParams = z.object({
  threadId: z.string().min(1),
  turnId: z.string().min(1),
  itemId: z.string().min(1),
  grantRoot: z.null().optional(),
});

export function fileWritePermission(
  approval: Approval,
  c: Conversation,
  mode: "code" | "cowork" = "code",
) {
  if (
    approvalKind(approval) !== "fileChange" ||
    approval.conversationId !== c.id ||
    c.mode !== mode ||
    c.archived
  )
    return;
  const parsed = fileApprovalParams.safeParse(approval.params);
  if (!parsed.success || parsed.data.threadId !== c.threadId) return;
  const { turnId, itemId } = parsed.data;
  const turn = c.turns.at(-1);
  if (
    turn?.id !== turnId ||
    turn.status !== "inProgress" ||
    c.turns.filter((row) => row.id === turnId).length !== 1
  ) return;
  const items = turn.items.filter((item) => item.id === itemId);
  const item = items.length === 1 ? items[0] : undefined;
  if (
    item?.type !== "fileChange" ||
    item.status !== "inProgress" ||
    (item.lifecycleStatus && item.lifecycleStatus !== "inProgress") ||
    !item.changes?.length
  )
    return;
  const writes = codeFileChangeProjections(turnId, item).map(
    ({ tool }) => tool,
  );
  if (
    writes.length !== item.changes.length ||
    item.changes.some(({ path }) => !path)
  )
    return;
  if (writes.length === 1) {
    const [write] = writes;
    return {
      toolName: write.name,
      input: write.input,
      cliToolUseId: write.id,
      filePath: item.changes[0].path,
    };
  }
  return {
    toolName: "apply_patch" as const,
    input: {
      files: item.changes.map(({ path, diff }, index) => ({
        path,
        ...(writes[index].name === "Write" ? { content: diff } : { diff }),
      })),
    },
    cliToolUseId: `${turnId}:patch:${itemId}`,
  };
}

export function codeElicitationOffer(approval: Approval, c: Conversation) {
  if (
    approval.conversationId !== c.id ||
    c.archived ||
    !c.threadId ||
    approval.params?.threadId !== c.threadId ||
    !c.turns.some(
      (turn) =>
        turn.status === "inProgress" && turn.id === approval.params?.turnId,
    )
  )
    return;
  const elicitation = mcpElicitation(approval);
  if (!elicitation) return;
  return {
    sessionId: publicId(c.id),
    toolName: elicitation.serverName,
    input: {},
    isElicitation: true as const,
    requiresUserInteraction: true as const,
    suppressAlwaysAllowRule: true as const,
    ...(elicitation.mode === "form"
      ? {
          elicitationForm: {
            message: elicitation.message,
            requestedSchema: structuredClone(elicitation.requestedSchema),
            fieldNames: elicitation.fieldNames,
          },
        }
      : {
          elicitationLink: {
            message: elicitation.message,
            href: elicitation.url,
            host: new URL(elicitation.url).host,
          },
        }),
  };
}

export function toolPermission(
  approval: Approval,
  c: Conversation,
  mcpServers?: Settings["mcpServers"],
): ToolPermission | undefined {
  if (approval.conversationId !== c.id) return undefined;
  const mcp = mcpToolApproval(approval);
  if (mcp) {
    const input = approval.params?._meta?.tool_params;
    if (
      !mcp.server ||
      !mcp.tool ||
      !input ||
      typeof input !== "object" ||
      Array.isArray(input)
    )
      return undefined;
    const turn = c.turns.find((t) => t.id === approval.params?.turnId);
    const items =
      turn?.items.filter(
        (item) =>
          item.type === "mcpToolCall" &&
          item.server === mcp.server &&
          item.tool === mcp.tool &&
          ["inProgress", "running"].includes(
            item.status ?? item.lifecycleStatus ?? "",
          ),
      ) ?? [];
    const cliToolUseId =
      turn && items.length === 1 ? `${turn.id}:tool:${items[0].id}` : undefined;
    return {
      requestId: String(approval.id),
      sessionId: publicId(c.id),
      toolName:
        (items.length === 1 &&
          registeredCodeAppToolName(items[0], mcpServers)) ||
        `mcp__${mcp.server}__${mcp.tool}`,
      title: mcp.title ?? mcp.tool,
      input: structuredClone(input),
      toolUseId: cliToolUseId ?? `mcp-permission:${approval.id}`,
      ...(cliToolUseId ? { cliToolUseId } : {}),
      suppressAlwaysAllowRule: true,
    };
  }
  if (approvalKind(approval) !== "command") return undefined;
  // Do not present a plain command approval if the agent also requested a
  // network grant or broader permissions the card cannot describe yet.
  if (
    approval.params?.networkApprovalContext ||
    approval.params?.additionalPermissions ||
    approval.params?.proposedNetworkPolicyAmendments
  )
    return undefined;
  const item = approvalItem(approval, c);
  const command =
    typeof approval.params?.command === "string"
      ? approval.params.command
      : item?.command;
  if (!command) return undefined;
  const turn =
    item &&
    c.turns.find((entry) =>
      entry.items.some((entryItem) => entryItem.id === item.id),
    );
  return {
    requestId: String(approval.id),
    sessionId: publicId(c.id),
    toolName: "Bash",
    input: { command },
    ...(turn && item ? { cliToolUseId: `${turn.id}:tool:${item.id}` } : {}),
    suppressAlwaysAllowRule: true,
  };
}

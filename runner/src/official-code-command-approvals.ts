import { codeApprovalIsStopping } from "../../electron/engine/code-interrupt-scope";
import type { Engine } from "../../electron/engine/engine";
import { isOwnedCloudCodeSession } from "../../electron/official-ui/api/cloud-code-history";
import {
  createCodeCommandPermissionHost,
  type CodeCommandPermissionHost,
} from "../../electron/official-ui/code-command-permission-host";
import {
  codeCommandRequestPrefix,
  officialCodeApprovalSuggestions,
  type OfficialCodeApprovalControl,
  type OfficialCodeApprovalReply,
} from "../../shared/official-code-approval";
import type { Conversation } from "../../shared/types";
import type { WebAppContext } from "./web-app-context";

const hosts = new WeakMap<
  WebAppContext,
  {
    identity: unknown;
    store: WebAppContext["store"];
    engines: WeakMap<Engine, CodeCommandPermissionHost>;
  }
>();

function commandHost(ctx: WebAppContext, id: string) {
  const account = ctx.activeAccount;
  const identity = ctx.officialSessionIdentity();
  const store = ctx.store;
  const current = () =>
    !ctx.closedFlag &&
    !ctx.signedOut &&
    ctx.activeAccount?.id === account?.id &&
    ctx.officialSessionIdentity() === identity &&
    ctx.store === store;
  if (!account || identity == null || !current()) return;
  const owned = (sessionId: string) => {
    const rows = store.conversations.filter((row) => row.id === sessionId);
    const row = rows[0];
    return rows.length === 1 &&
      row &&
      !row.archived &&
      isOwnedCloudCodeSession(row, account.id)
      ? row
      : undefined;
  };
  const conversation = owned(id);
  const engine = conversation && ctx.engines?.running(id);
  if (!conversation || !engine) return;
  let entry = hosts.get(ctx);
  if (!entry || entry.identity !== identity || entry.store !== store) {
    entry = { identity, store, engines: new WeakMap() };
    hosts.set(ctx, entry);
  }
  let host = entry.engines.get(engine);
  if (!host) {
    const ownsEnvironment = (row: Conversation) => {
      return (
        engine.environment.kind !== "ssh" &&
        ctx.engines.running(row.id) === engine &&
        engine.owns(row)
      );
    };
    host = createCodeCommandPermissionHost({
      current,
      ownsEnvironment,
      surface: "web",
      allowPersistent: () => engine.policy().approvalsAlwaysAllow,
      runtime: () => (engine.rpc?.connected ? engine.rpc : undefined),
      approvals: () => engine.ownApprovals,
      conversation: owned,
      canRespond: (approval) => !codeApprovalIsStopping(owned(approval.conversationId), approval.params),
      respondExact(approval, result) {
        if (
          !current() ||
          !engine.rpc?.connected ||
          !engine.ownApprovals.includes(approval)
        )
          throw Error("The command request is no longer current.");
        engine.approve(approval.id, result);
      },
    });
    entry.engines.set(engine, host);
  }
  return { host, engine };
}

export function officialCodeCommandControls(
  ctx: WebAppContext,
  id: string,
): OfficialCodeApprovalControl[] {
  const scope = commandHost(ctx, id);
  if (!scope) return [];
  return scope.engine.ownApprovals.flatMap((approval) => {
    if (approval.conversationId !== id) return [];
    const request = scope.host.project(approval.id, id);
    if (!request?.cliToolUseId) return [];
    const suggestions = officialCodeApprovalSuggestions.safeParse(request.suggestions);
    return [
      {
        type: "control_request",
        request_id: request.requestId,
        request: {
          subtype: "can_use_tool",
          tool_use_id: request.cliToolUseId,
          tool_name: request.toolName,
          input: request.input,
          ...(request.title ? { title: request.title } : {}),
          ...(request.description ? { description: request.description } : {}),
          suppress_always_allow_rule: request.suppressAlwaysAllowRule === true,
          ...(suggestions.success ? { permission_suggestions: suggestions.data } : {}),
          requires_user_interaction: true,
        },
      },
    ];
  });
}

export function respondOfficialCodeCommand(
  ctx: WebAppContext,
  id: string,
  reply: OfficialCodeApprovalReply,
) {
  if (!reply.request_id.startsWith(codeCommandRequestPrefix)) return;
  const scope = commandHost(ctx, id);
  if (!scope) return "unconfirmed" as const;
  const choice = reply.response;
  if (!("behavior" in choice)) return "invalid" as const;
  const toolNames = [choice.tool_name, choice.toolName].filter(
    (name): name is string => name !== undefined,
  );
  if (toolNames.some((name) =>
    !["Bash", "Write", "Edit", "MultiEdit", "apply_patch"].includes(name),
  )) return "invalid" as const;
  try {
    scope.host.respond(
      reply.request_id,
      choice.behavior === "allow" ? (choice.updatedPermissions ? "always" : "once") : "deny",
      choice.behavior === "allow" ? choice.updatedInput : undefined,
      {
        sessionId: `local_${id}`,
        toolUseId: choice.toolUseID,
        toolNames,
      },
      choice.behavior === "allow" ? choice.updatedPermissions : undefined,
    );
    return "confirmed" as const;
  } catch {
    return "unconfirmed" as const;
  }
}

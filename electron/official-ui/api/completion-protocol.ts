import { organizationUuid, type AdapterContext } from "./context";
/** Installed frontend transport only. This is not an engine tool policy. */
export function completionProtocolDescriptor(ctx: AdapterContext) {
  const account = ctx.account();
  if (
    !account ||
    typeof account.id !== "string" ||
    account.id.length === 0 ||
    ctx.isCurrent?.() === false ||
    ctx.completionProtocol !== "text-chat-v1"
  )
    return undefined;
  return {
    version: 1,
    account_uuid: account.id,
    organization_uuid: organizationUuid(account.id),
    protocol: "text-chat-v1",
    surface: "chat",
    completion_path: "/chat_conversations/:id/completion",
    automatic_client_tools: "unsupported",
  } as const;
}

import {
  cloudCodeSessionKey,
  isOwnedCloudCoworkSession,
} from "../../electron/official-ui/api/cloud-code-history";
import { organizationUuid } from "../../electron/official-ui/api/context";
import type { OfficialUiReadResponse } from "../../shared/official-ui-web";
import type { CallFrame, Dispatcher } from "./dispatcher";
import type { WebAppContext } from "./web-app-context";

const json = (status: number, body: unknown): OfficialUiReadResponse => ({
  status,
  contentType: "application/json",
  body: Buffer.from(JSON.stringify(body)),
});

export async function deleteOfficialCoworkSession(
  dispatcher: Dispatcher,
  frame: CallFrame,
  ctx: WebAppContext,
  key: string,
  request: Record<string, unknown>,
  activationCurrent: () => boolean,
): Promise<OfficialUiReadResponse> {
  const account = ctx.activeAccount;
  if (!account || !activationCurrent())
    return json(409, { error: "The account activation changed." });
  if (
    typeof request.codeOrganizationId !== "string" ||
    request.codeOrganizationId.toLowerCase() !== organizationUuid(account.id)
  )
    return json(404, { error: "Organization not found." });
  if (
    !(request.body instanceof Uint8Array) ||
    request.body.byteLength > 1024 ||
    typeof request.contentType !== "string" ||
    !/^application\/json(?:\s*;.*)?$/i.test(request.contentType)
  )
    return json(400, { error: "Invalid Cowork deletion request." });
  try {
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(request.body));
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length)
      throw Error();
  } catch {
    return json(400, { error: "Invalid Cowork deletion request." });
  }
  const store = ctx.store;
  const identity = ctx.officialSessionIdentity();
  const matches = store.conversations.filter(
    (conversation) =>
      !conversation.archived &&
      isOwnedCloudCoworkSession(conversation, account.id) &&
      cloudCodeSessionKey(conversation, account.id) === key,
  );
  if (matches.length !== 1)
    return json(404, { error: "Cowork session not found." });
  const conversation = matches[0];
  const activation = () =>
    activationCurrent() && ctx.activeAccount?.id === account.id &&
    ctx.store === store && ctx.officialSessionIdentity() === identity;
  const current = () =>
    activation() && store.conversations.includes(conversation) &&
    !conversation.archived && isOwnedCloudCoworkSession(conversation, account.id) &&
    cloudCodeSessionKey(conversation, account.id) === key;
  try {
    if (!current()) throw Error();
    if (conversation.chatDeviceBinding) {
      await ctx.chatDeviceController.deleteCowork(conversation, current, async (unchanged) => {
        await store.persistConversationDeletion(conversation, unchanged);
        if (!activation()) throw Error();
      });
    } else {
      await dispatcher.run(
        { ...frame, method: "deleteConversation", args: [conversation.id] },
        { context: ctx, identity, coworkDelete: { conversationId: conversation.id, current } },
      );
    }
    if (!activation() || store.conversations.some((row) => row.id === conversation.id)) throw Error();
    return json(200, {});
  } catch {
    return json(409, { error: "The Cowork deletion could not be confirmed. Refresh before retrying." });
  }
}

/** Original Chat rI PUT transport. Selecting a stored version never generates a turn. */
import type http from "node:http";
import type { Conversation, Turn } from "../../../shared/types";
import { organizationUuid, reply, type AdapterContext } from "./context";
import {
  assistantMessageId,
  leafMessageId,
  resolveConversationId,
} from "./conversations";
import {
  replyVersions,
  promptVersions,
  responseGroup,
  type ChatLeafTarget,
} from "../../../shared/branches";
import { readBoundedJson, RequestBodyError } from "./request-body";

export async function selectStoredChatLeaf(
  ctx: AdapterContext,
  id: string,
  assistantId: string,
  current: () => boolean,
): Promise<Conversation | "unavailable" | undefined> {
  if (!current()) return undefined;
  const conversation = await ctx.loadConversation(id);
  if (!current()) return undefined;
  if (conversation?.id !== id || conversation.mode !== "chat")
    return "unavailable";
  const owner = ctx.account()?.id;
  const authors = conversation.sessionAuthors;
  if (authors && (authors.ownerAccountUuid !== owner || authors.viewerAccountUuid !== owner))
    return "unavailable";
  const has = (turn: Turn) => assistantMessageId(turn) === assistantId;
  const active = conversation.turns.at(-1);
  const activeLeaf = active && has(active) ? active : undefined;
  const branches = activeLeaf ? [] : (conversation.savedBranches ?? []).filter(
    (branch) => branch.turns.some(has),
  );
  const branch = branches.length === 1 ? branches[0] : undefined;
  const leaf = activeLeaf ?? branch?.turns.at(-1);
  if (!leaf || !has(leaf) || (branch && conversation.turns.some(has))) return undefined;
  const target: ChatLeafTarget = {
    conversationCreatedAt: conversation.createdAt,
    turnId: leaf.id,
    turnCreatedAt: leaf.createdAt,
    branchId: branch?.id ?? null,
  };
  let saved: Conversation | undefined;
  if (ctx.isCloudConversation?.(id)) {
    // Older desktop cloud bridges expose only the group selectors.
    if (branch) {
      const split = conversation.turns.findIndex(
        (turn, index) => branch.turns[index] && branch.turns[index].id !== turn.id,
      );
      if (split === -1) return undefined;
      const ours = conversation.turns[split], theirs = branch.turns[split];
      const reply = responseGroup(ours) === responseGroup(theirs);
      const selected = (reply ? replyVersions : promptVersions)(conversation, ours)
        .find((version) => version.turnId === theirs.id);
      if (selected?.branchId !== branch.id || !current()) return undefined;
      await ctx.call(reply ? "selectReplyVersion" : "selectPromptVersion", id, ours.id, theirs.id);
    }
    if (!current()) return undefined;
    saved = await ctx.loadConversation(id);
  } else {
    if (!current()) return undefined;
    const call = ctx.allowChatLeafSelection ? ctx.call : ctx.localCall ?? ctx.call;
    saved = await call("selectChatLeaf", id, target) as Conversation | undefined;
  }
  if (
    current() && saved?.id === id && saved.mode === "chat" &&
    saved.createdAt === target.conversationCreatedAt && leafMessageId(saved) === assistantId
  ) return saved;
  return undefined;
}

export async function restConversationLeafRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  p: string,
  ctx: AdapterContext,
): Promise<boolean> {
  const match =
    /^\/api\/organizations\/([^/]+)\/chat_conversations\/([^/]+)\/current_leaf_message_uuid$/.exec(
      p,
    );
  if (!match) return false;
  const fail = (status: number, message: string) =>
    reply(
      res,
      { type: "error", error: { type: "invalid_request_error", message } },
      status,
    );
  if (req.method !== "PUT")
    return fail(405, "Use PUT to select a stored version.");
  if (!ctx.allowChatLeafSelection && (ctx.readOnly || typeof ctx.localCall !== "function"))
    return fail(403, "Stored version selection is unavailable on this host.");
  let owner: string | undefined, activation: unknown;
  try {
    owner = ctx.account()?.id;
    activation = ctx.sessionIdentity?.();
  } catch {
    return fail(409, "The account activation changed.");
  }
  if (!owner) return fail(401, "Sign in to select a stored version.");
  const current = () => {
    try {
      return (
        activation != null &&
        activation !== "" &&
        ctx.account()?.id === owner &&
        ctx.sessionIdentity?.() === activation &&
        ctx.isCurrent?.() === true
      );
    } catch {
      return false;
    }
  };
  if (!current()) return fail(409, "The account activation changed.");
  if (match[1] !== organizationUuid(owner))
    return fail(404, "The conversation is unavailable.");
  let pageId: string;
  try {
    pageId = decodeURIComponent(match[2]);
  } catch {
    return fail(400, "Invalid conversation identity.");
  }
  if (!pageId || pageId.length > 512)
    return fail(400, "Invalid conversation identity.");
  let body: Record<string, unknown>;
  try {
    body = await readBoundedJson(req, 4096);
  } catch (error) {
    return fail(
      error instanceof RequestBodyError ? error.status : 400,
      "Invalid version selection request.",
    );
  }
  if (!current()) return fail(409, "The account activation changed.");
  if (
    Object.keys(body).length !== 1 ||
    typeof body.current_leaf_message_uuid !== "string" ||
    !body.current_leaf_message_uuid ||
    body.current_leaf_message_uuid.length > 512
  )
    return fail(400, "Choose one stored assistant message.");
  const target = body.current_leaf_message_uuid,
    id = resolveConversationId(pageId);
  try {
    const saved = await selectStoredChatLeaf(ctx, id, target, current);
    if (!current())
      return fail(
        409,
        "The account activation changed. Reload before retrying.",
      );
    if (saved === "unavailable")
      return fail(404, "The Chat conversation is unavailable.");
    if (!saved)
      return fail(
        409,
        "The selected version could not be confirmed. Reopen the conversation.",
      );
    return reply(res, {
      uuid: pageId,
      updated_at: new Date(saved.updatedAt ?? 0).toISOString(),
      current_leaf_message_uuid: leafMessageId(saved),
    });
  } catch {
    return fail(
      409,
      "The selected version could not be confirmed. Reopen the conversation before retrying.",
    );
  }
}

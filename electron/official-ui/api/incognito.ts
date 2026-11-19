/** Explicit exit of the official temporary chat, scoped to its account and id. */
import type http from "node:http";
import { z } from "zod";
import { empty, organizationUuid, reply, type AdapterContext } from "./context";
import { ScopedMap } from "./scope";
import { beginIncognitoUploadDiscard, forgetIncognitoFiles, forgetIncognitoUploadDraft, flushFileRegistry, incognitoConversationDrafts } from "./files";
import { forgetTemporaryTurnIds, messageIndex, pendingSends } from "./conversations";
import { incognitoDraftId } from "../../workspace/incognito-upload";
import { forgetTemporaryCompletion } from "./rest-completion";
import { readBoundedJson } from "./request-body";

// Shared with first-send and Stop: exit must not race a pending creation.
export const creatingConversations = new ScopedMap<string, Promise<unknown>>(
  "creating-conversations",
);

export async function discardIncognitoRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  url: URL,
  ctx: AdapterContext,
  resolve: (id: string) => string,
) {
  const match =
    /^\/api\/organizations\/([^/]+)\/chat_conversations\/([^/]+)\/discard_incognito$/.exec(
      pathname,
    );
  if (!match) return false;
  if (req.method !== "POST")
    return reply(res, { error: "Method not allowed" }, 405);
  const owner = ctx.account()?.id,
    activation = ctx.sessionIdentity?.();
  const current = () =>
    !!owner &&
    activation != null &&
    ctx.account()?.id === owner &&
    ctx.sessionIdentity?.() === activation &&
    ctx.isCurrent?.() === true;
  if (!owner || match[1] !== organizationUuid(owner))
    return reply(res, { error: "Conversation not found" }, 404);
  if (ctx.readOnly && !ctx.allowIncognitoDiscard)
    return reply(
      res,
      {
        error:
          "Temporary chat changes are unavailable in this read-only interface",
      },
      501,
    );
  if (url.search || url.hash || !/^[a-f0-9-]{36}$/i.test(match[2]))
    return reply(res, { error: "Invalid temporary conversation" }, 400);
  const conflict = () =>
    reply(
      res,
      { error: "The account changed. Refresh before continuing." },
      409,
    );
  if (!current()) return conflict();
  let draftId: string | undefined;
  if (req.headers?.["content-type"]) {
    try {
      ({ draftId } = z.object({ draftId: incognitoDraftId }).strict().parse(await readBoundedJson(req, 256)));
    } catch {
      return reply(res, { error: "Invalid temporary attachment draft." }, 400);
    }
  }
  const pending = creatingConversations.get(match[2]);
  if (pending) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        pending,
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(Error("The conversation is still starting.")),
            30000,
          );
        }),
      ]);
    } catch {
      return reply(
        res,
        {
          error:
            "The conversation is still starting. Try again after it settles.",
        },
        409,
      );
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  if (!current()) return conflict();
  const id = resolve(match[2]);
  const conversation = await ctx.loadConversation(id);
  if (!current()) return conflict();
  if (
    conversation && (conversation.id !== id || !conversation.incognito || conversation.mode !== "chat")
  )
    return reply(res, { error: "Only temporary chats can be discarded" }, 409);
  const buckets = [...new Set([draftId, incognitoDraftId.safeParse(id).data, ...incognitoConversationDrafts(id, draftId)].filter(id => id !== undefined))];
  const finish = beginIncognitoUploadDiscard(buckets);
  let confirmed = false;
  try {
    if (conversation || draftId) await ctx.call("discardIncognito", id, ...(draftId ? [draftId] : []));
    if (!current()) return conflict();
    if (conversation) {
      const remaining = (await ctx.snapshot?.(true))?.conversations ?? await ctx.listConversations();
      if (!current()) return conflict();
      if (remaining.some((c) => c.id === id))
        return reply(res, { error: "The temporary chat could not be closed" }, 409);
      forgetIncognitoFiles(conversation, remaining);
      forgetTemporaryTurnIds([...(conversation.turns ?? []), ...(conversation.savedBranches ?? []).flatMap(branch => branch.turns)]);
    }
    for (const bucket of buckets) forgetIncognitoUploadDraft(bucket);
    forgetTemporaryCompletion(id);
    messageIndex.delete(id);
    pendingSends.delete(id);
    flushFileRegistry();
    confirmed = true;
    return empty(res);
  } finally {
    finish(confirmed);
  }
}

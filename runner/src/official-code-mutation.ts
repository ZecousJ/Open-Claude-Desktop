import { z } from "zod";
import { beginCodeSessionLifecycle } from "../../electron/conversations/code-lifecycle-guard";
import {
  cloudCodeSession,
  cloudCodeSessionKey,
  isOwnedCloudCodeSession,
} from "../../electron/official-ui/api/cloud-code-history";
import { organizationUuid } from "../../electron/official-ui/api/context";
import {
  officialCodeMutationMaxBytes,
  officialCodeSessionTitle,
  type OfficialCodeMutation,
} from "../../shared/official-code-history";
import type { OfficialUiReadResponse } from "../../shared/official-ui-web";
import type { Conversation } from "../../shared/types";
import {
  forgetOfficialCodeInputs,
  holdOfficialCodeInputsOnRestore,
  officialCodeInputInProgress,
} from "./official-code-followup";
import { readCodeQueue } from "./official-code-queue";
import { closeOfficialCodeTerminals, hasOfficialCodeTerminal } from "./official-code-terminals";
import type { WebAppContext } from "./web-app-context";

const pinnedTag = z.tuple([z.literal("ui:pinned")]);
const metadata = z.strictObject({
  title: officialCodeSessionTitle.optional(),
  add_tags: pinnedTag.optional(),
  remove_tags: pinnedTag.optional(),
}).refine(({ title, add_tags, remove_tags }) =>
  (title !== undefined || add_tags || remove_tags) && !(add_tags && remove_tags),
);
const empty = z.object({}).strict();

function json(status: number, body: unknown): OfficialUiReadResponse {
  return {
    status,
    contentType: "application/json",
    body: Buffer.from(JSON.stringify(body)),
  };
}

const fail = (status: number, message: string) =>
  json(status, { error: { message } });

function codeIdle(store: WebAppContext["store"], conversation: Conversation) {
  return !conversation.turns.some((turn) => turn.status === "inProgress") &&
    !officialCodeInputInProgress(conversation) &&
    store.hasConfirmedCodeStops(conversation);
}

function pendingCodeInput(
  store: WebAppContext["store"],
  owner: string,
  conversation: Conversation,
  includeHeld: boolean,
) {
  return conversation.officialCodeQueuedTurns?.some(input => input.queueState !== "cancelled") ||
    readCodeQueue(store.root, owner, conversation).some(input =>
      (includeHeld || input.state === "queued") &&
      !store.hasConfirmedOfficialCodeEvent(conversation, input.eventId),
    );
}

function publishCodeMutation(ctx: WebAppContext, conversation: Conversation) {
  ctx.push({ type: "conversation", conversation: structuredClone(conversation) });
  ctx.push({ type: "resync" });
}

export async function autoArchiveOfficialCodeSession(
  ctx: WebAppContext,
  owner: string,
  conversation: Conversation,
  current: () => boolean,
): Promise<void> {
  const store = ctx.store;
  const available = () => current() && !conversation.archived &&
    codeIdle(store, conversation) &&
    !hasOfficialCodeTerminal(ctx, conversation.id) &&
    !conversation.turns.some(turn => turn.items.some(item =>
      "status" in item && (item.status === "inProgress" || item.status === "running"))) &&
    !pendingCodeInput(store, owner, conversation, true);
  if (!available()) return;
  const release = beginCodeSessionLifecycle(conversation);
  try {
    if (await store.commitOfficialCodeMutation(
      conversation, { archived: true, keepAwake: undefined }, available,
    )) publishCodeMutation(ctx, conversation);
  } finally {
    release();
  }
}

export async function mutateOfficialCodeSession(
  ctx: WebAppContext,
  route: OfficialCodeMutation,
  request: Record<string, unknown>,
  activationCurrent: () => boolean,
): Promise<OfficialUiReadResponse> {
  const account = ctx.activeAccount;
  if (!account || !activationCurrent())
    return fail(409, "A current authenticated capability lease is required.");
  if (
    typeof request.codeOrganizationId !== "string" ||
    request.codeOrganizationId.toLowerCase() !== organizationUuid(account.id)
  )
    return fail(404, "Organization not found.");

  const { body, contentType } = request;
  if (
    body instanceof Uint8Array &&
    body.byteLength > officialCodeMutationMaxBytes
  )
    return fail(413, "The Code session update is too large.");
  let value: unknown;
  try {
    if (
      !(body instanceof Uint8Array) ||
      typeof contentType !== "string" ||
      !/^application\/json(?:\s*;|$)/i.test(contentType)
    )
      throw Error();
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch {
    return fail(400, "Invalid Code session update.");
  }
  const input =
    route.kind === "metadata" ? metadata.safeParse(value) : undefined;
  if (input ? !input.success : !empty.safeParse(value).success)
    return fail(400, "Invalid Code session update.");

  const store = ctx.store;
  const owner = account.id;
  const matches = store.conversations.filter(
    (row) =>
      isOwnedCloudCodeSession(row, owner) &&
      cloudCodeSessionKey(row, owner) === route.key,
  );
  if (matches.length !== 1) return fail(404, "Code session not found.");
  const [conversation] = matches;
  const { createdAt } = conversation;
  const current = () =>
    activationCurrent() &&
    ctx.activeAccount?.id === owner &&
    ctx.store === store &&
    conversation.createdAt === createdAt &&
    store.conversations.includes(conversation) &&
    isOwnedCloudCodeSession(conversation, owner);
  const savingStop = () => !store.hasConfirmedCodeStops(conversation);
  const reply = () =>
    json(200, {
      session: cloudCodeSession(
        conversation, owner, undefined, savingStop(),
        (providerId, model) => current() &&
          ctx.engineFor(conversation.id).codeUltracodeAvailable(providerId, model),
      ),
    });
  if (input?.success) {
    const data = input.data;
    const patch = {
      ...(data.title === undefined ? {} : { title: data.title, titleSetByUser: true }),
      ...(data.add_tags ? { pinned: true } : data.remove_tags ? { pinned: false } : {}),
    };
    try {
      if (
        await store.commitOfficialCodeMutation(conversation, patch, current)
      ) {
        publishCodeMutation(ctx, conversation);
      }
      return reply();
    } catch {
      return fail(
        409,
        "The Code session save could not be confirmed. Reopen the account before retrying.",
      );
    }
  }

  const idle = () => codeIdle(store, conversation);
  if (!idle())
    return fail(
      409,
      "Stop the running Code task before changing this session.",
    );
  if (route.kind === "unarchive" && conversation.worktree?.state === "deleted")
    return fail(
      409,
      "The Code workspace must be restored on its original host.",
    );

  let release: (() => void) | undefined;
  try {
    release = beginCodeSessionLifecycle(conversation);
    if (
      route.kind === "archive" &&
      !conversation.archived &&
      pendingCodeInput(store, owner, conversation, false)
    )
      return fail(
        409,
        "Cancel queued Code inputs before archiving this session.",
      );
    if (route.kind === "unarchive" && conversation.archived)
      holdOfficialCodeInputsOnRestore(ctx, owner, conversation);
    const patch =
      route.kind === "delete"
        ? null
        : route.kind === "archive"
          ? { archived: true, keepAwake: undefined }
          : { archived: false, ...(conversation.archived ? { codeAutoArchiveExempt: true } : {}) };
    const changed = await store.commitOfficialCodeMutation(
      conversation,
      patch,
      () => current() && idle(),
    );
    if (route.kind === "delete" || route.kind === "archive")
      await closeOfficialCodeTerminals(ctx, conversation.id);
    if (route.kind === "delete") {
      ctx.push({ type: "resync" });
      try {
        forgetOfficialCodeInputs(ctx, owner, conversation);
        ctx.replyFeedback.deleteConversation(conversation.id);
      } catch {
        ctx.log(
          "claudex-runner: deleted Code session auxiliary data needs cleanup",
        );
      }
      return json(200, {});
    }
    if (changed) publishCodeMutation(ctx, conversation);
    return reply();
  } catch {
    return fail(
      409,
      "The Code session change could not be confirmed. Reopen the account before retrying.",
    );
  } finally {
    release?.();
  }
}

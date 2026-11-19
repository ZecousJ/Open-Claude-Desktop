import type http from "node:http";
import { isEditablePrivateChatProject } from "../../../shared/project-access";
import { officialUiCoworkProjectMove } from "../../../shared/official-ui-web";
import { cloudCodeSessionKey, isOwnedCloudCoworkSession } from "./cloud-code-history";
import { empty, organizationUuid, reply, type AdapterContext } from "./context";
import { readBoundedJson, RequestBodyError } from "./request-body";

export async function projectMoveRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  path: string,
  url: URL,
  ctx: AdapterContext,
  resolve: (id: string) => string,
): Promise<boolean> {
  const cowork = officialUiCoworkProjectMove(req.method ?? "", path);
  if (!cowork && (req.method !== "POST" || !path.endsWith("/chat_conversations/move_many")))
    return false;
  let owner: string | undefined,
    activation: unknown,
    stateDirectory: string | undefined;
  const current = () => {
    try {
      return (
        !!owner &&
        activation != null &&
        activation !== "" &&
        ctx.stateDirectory?.() === stateDirectory &&
        ctx.account()?.id === owner &&
        ctx.sessionIdentity?.() === activation &&
        ctx.isCurrent?.() === true
      );
    } catch {
      return false;
    }
  };
  const unconfirmed = () =>
    reply(res, { error: "Couldn’t confirm the project change. Refresh the session before retrying." }, 503);
  const missing = () =>
    reply(res, { error: cowork ? "Cowork session not found." : "Conversation not found" }, 404);
  const conflict = () =>
    cowork ? unconfirmed() : reply(
      res,
      {
        error: {
          type: "conflict_error",
          message:
            "The account, project or conversation changed. Earlier moves may already have completed; refresh their status before retrying.",
        },
      },
      409,
    );
  try {
    owner = ctx.account()?.id;
    activation = ctx.sessionIdentity?.();
    stateDirectory = ctx.stateDirectory?.();
  } catch {
    return conflict();
  }
  if (
    !owner || (cowork
      ? cowork.organizationId !== organizationUuid(owner)
      : path !== `/api/organizations/${organizationUuid(owner)}/chat_conversations/move_many`)
  )
    return missing();
  const accountId = owner;
  if (!current()) return conflict();
  if (cowork && (!ctx.officialCoworkHistory || !ctx.allowConversationProjectMove))
    return reply(res, { error: "Cowork project changes are unavailable on this host." }, 501);
  if (ctx.readOnly && !ctx.allowConversationProjectMove)
    return reply(
      res,
      { error: "Project changes are unavailable in this read-only interface" },
      501,
    );
  if (url.search || url.hash)
    return reply(res, { error: "Unexpected move query" }, 400);
  let body;
  try {
    body = await readBoundedJson(req, 256 * 1024);
  } catch (error) {
    return reply(
      res,
      { error: "Invalid project move" },
      error instanceof RequestBodyError ? error.status : 400,
    );
  }
  if (!current()) return conflict();
  if (
    Object.keys(body).some(
      (k) => k !== "project_uuid" && (cowork || k !== "conversation_uuids"),
    ) ||
    !("project_uuid" in body)
  )
    return reply(res, { error: "Invalid project move" }, 400);
  const { project_uuid: projectId } = body;
  if (projectId !== null && (typeof projectId !== "string" || !projectId.trim()))
    return reply(res, { error: "Invalid project move" }, 400);
  let ids = body.conversation_uuids;
  let coworkCreatedAt: number | undefined;
  if (cowork) {
    try {
      const sessions = (await ctx.listConversations()).filter((c) =>
        cloudCodeSessionKey(c, accountId) === cowork.key);
      if (!current()) return conflict();
      if (sessions.length !== 1 || !isOwnedCloudCoworkSession(sessions[0], accountId))
        return missing();
      coworkCreatedAt = sessions[0].createdAt;
      ids = [sessions[0].id];
    } catch {
      return unconfirmed();
    }
  }
  if (
    !Array.isArray(ids) ||
    ids.length > 1000 ||
    ids.some((id) => typeof id !== "string" || !id.trim() || id.length > 200) ||
    new Set(ids).size !== ids.length
  )
    return reply(res, { error: "Invalid project move" }, 400);
  let resolved: string[];
  const resolveId = cowork ? (id: string) => id : resolve;
  try {
    resolved = ids.map(resolveId);
  } catch {
    return conflict();
  }
  if (
    resolved.some(
      (id) => typeof id !== "string" || !id.trim() || id.length > 200,
    ) ||
    new Set(resolved).size !== resolved.length
  )
    return reply(
      res,
      { error: "Duplicate or invalid conversation aliases" },
      400,
    );
  let destinationCreatedAt: number | undefined;
  const matchingDestination = (
    projects: Awaited<ReturnType<AdapterContext["snapshot"]>>["projects"],
  ) => {
    const matches = projects?.filter((p) => p.id === projectId) ?? [];
    return matches.length === 1 && isEditablePrivateChatProject(matches[0])
      ? matches[0]
      : undefined;
  };
  if (projectId !== null) {
    try {
      const snapshot = await ctx.snapshot(true);
      if (!current()) return conflict();
      const destination = matchingDestination(snapshot.projects);
      if (!destination) return reply(res, { error: "Project not found" }, 404);
      destinationCreatedAt = destination.createdAt;
    } catch {
      if (!current()) return conflict();
      return reply(res, { error: "Project could not be verified" }, 503);
    }
  }
  // Project snapshots are serialized: createdAt identifies the selected incarnation.
  // Dispatch runs in the same continuation as the final checks, with no extra
  // await after checking the current alias/account/project.
  const verifyTarget = async (
    conversationId: string,
    pageId: string,
    dispatch?: () => Promise<unknown>,
  ): Promise<{ valid: boolean; result?: unknown }> => {
    let snapshot;
    try {
      snapshot = projectId === null ? undefined : await ctx.snapshot(true);
    } catch {
      return { valid: false };
    }
    const destination =
      projectId === null ? undefined : matchingDestination(snapshot!.projects);
    if (
      !current() ||
      (projectId !== null &&
        (!destination || destination.createdAt !== destinationCreatedAt))
    )
      return { valid: false };
    try {
      if (resolveId(pageId) !== conversationId) return { valid: false };
    } catch {
      return { valid: false };
    }
    return { valid: true, result: await dispatch?.() };
  };
  const moved: string[] = [],
    failed: string[] = [];
  for (let i = 0; i < ids.length; i++) {
    if (!current()) return conflict();
    try {
      if (resolveId(ids[i]) !== resolved[i]) return conflict();
    } catch {
      return conflict();
    }
    try {
      const conversation = await ctx.loadConversation(resolved[i]);
      if (!current()) return conflict();
      if (
        !conversation ||
        conversation.id !== resolved[i] ||
        (conversation.mode !== "chat" && conversation.mode !== "cowork") ||
        (cowork && (conversation.createdAt !== coworkCreatedAt || !isOwnedCloudCoworkSession(conversation, accountId)))
      ) {
        if (cowork) return missing();
        failed.push(ids[i]);
        continue;
      }
      // The versioned envelope fails closed on older scalar-only handlers.
      // Carry immutable preconditions across the routed IPC boundary. A fresh
      // project read can yield while this conversation is replaced or moved.
      const guard = {
        conversationId: conversation.id,
        mode: conversation.mode,
        createdAt: conversation.createdAt ?? null,
        sourceProjectId: conversation.projectId ?? null,
        destinationCreatedAt: destinationCreatedAt ?? null,
      };
      const verified = await verifyTarget(resolved[i], ids[i], () =>
        ctx.call("updateConversation", resolved[i], {
          projectId: { version: 1, target: projectId, expected: guard },
        }),
      );
      if (!verified.valid || !current()) return conflict();
      const result = verified.result;
      if (!(await verifyTarget(resolved[i], ids[i])).valid || !current())
        return conflict();
      try {
        if (resolveId(ids[i]) !== resolved[i]) return conflict();
      } catch {
        return conflict();
      }
      // Preserve the existing mutation's confirmation boundary. Do not infer
      // cloud durability or silently retry a rejected/ambiguous operation.
      if (
        !result ||
        typeof result !== "object" ||
        !("id" in result) ||
        result.id !== resolved[i] ||
        !("mode" in result) ||
        result.mode !== conversation.mode ||
        (("projectId" in result ? result.projectId : undefined) ?? null) !== projectId
      ) {
        failed.push(ids[i]);
        continue;
      }
      moved.push(ids[i]);
    } catch {
      if (!current()) return conflict();
      // Original consumer expects UUIDs, not error objects. A failed entry is
      // unconfirmed, not proof that no write occurred. Never re-dispatch it.
      failed.push(ids[i]);
    }
  }
  return cowork
    ? failed.length ? unconfirmed() : empty(res)
    : reply(res, { moved, failed });
}

/**
 * Share session / Copy link (official consumers: shared-m-1 NV for
 * `POST …/chat_conversations/<id>/share`, zk for `…/latest`, fB for
 * `…/share_access`, Xs for `DELETE …/share/<snapshot>`), on Claudex hosted
 * sharing (shared/sharing-api.ts): a share is a snapshot at a public link
 * ("public") or for invited addresses only ("invite_only").
 */
import type http from "node:http";
import type {
  HostedShare,
  ShareAccess,
  SharingStatus,
} from "../../../shared/sharing-api";
import { SnapshotError } from "../../conversations/conversation-snapshot";
import { empty, reply, organizationUuid, type AdapterContext } from "./context";
import { assistantMessageId, resolveConversationId } from "./conversations";
import {
  readBoundedBytes,
  readBoundedJson,
  RequestBodyError,
} from "./request-body";

const visibilityOf = (share: HostedShare) =>
  share.access === "invited" ? "invite_only" : "public";

const grantId = (shareId: string, email: string) =>
  organizationUuid(`share:${shareId}:${email.toLowerCase()}`);

/** The share row the page keeps (snapshot uuid, freshness, address). */
export function shareRow(share: HostedShare, conversationId: string) {
  return {
    uuid: share.id,
    conversation_uuid: conversationId,
    name: share.title,
    snapshot_name: share.title,
    created_at: new Date(share.createdAt).toISOString(),
    updated_at: new Date(share.snapshotAt).toISOString(),
    up_to_date: !share.stale,
    visibility: visibilityOf(share),
    url:
      share.inviteUrl && share.access === "invited"
        ? share.inviteUrl
        : share.url,
    share_url: share.url,
    status: share.status,
  };
}

export async function sharingRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  p: string,
  ctx: AdapterContext,
): Promise<boolean> {
  const method = req.method ?? "GET";
  const conversation =
    /^\/api\/organizations\/([^/]+)\/chat_conversations\/([^/]+)\/(latest|share_access|share|shares|access_requests)$/.exec(
      p,
    );
  const stop = /^\/api\/organizations\/([^/]+)\/share\/([^/]+)$/.exec(p);
  const grant =
    /^\/api\/organizations\/([^/]+)\/chat_snapshots\/([A-Za-z0-9_-]{1,64})\/grants\/([^/]+)$/.exec(
      p,
    );
  const address = /^\/api\/__claudex\/share-url\/([^/]+)$/.exec(p);
  const inventory = /^\/api\/organizations\/([^/]+)\/shares$/.exec(p);
  if (!conversation && !stop && !grant && !address && !inventory) return false;
  const error = (status: number, message: string) =>
    reply(
      res,
      { type: "error", error: { type: "share_unconfirmed", message } },
      status,
    );
  const owner = ctx.account()?.id,
    identity = ctx.sessionIdentity?.();
  const canWrite = !ctx.readOnly || ctx.allowConversationSharing === true;
  const host =
    owner && (!ctx.readOnly || ctx.allowConversationSharing)
      ? ctx.artifactPublishing?.()
      : undefined;
  const current = () =>
    ctx.account()?.id === owner &&
    ctx.sessionIdentity?.() === identity &&
    ctx.isCurrent?.() !== false &&
    (!host || (!host.closed && ctx.artifactPublishing?.() === host));
  const checked = async <T>(operation: () => Promise<T>) => {
    if (!current()) throw new Error("retired");
    const result = await operation();
    if (!current()) throw new Error("retired");
    return result;
  };
  const checkedCall = async (name: string, ...args: unknown[]) => {
    return checked(() => ctx.call(name, ...args));
  };
  const list = async (): Promise<HostedShare[]> =>
    host
      ? checked(() => host.list("conversation", true))
      : ctx.readOnly
        ? []
        : ((await checkedCall("hostedShares")) as HostedShare[]);
  if (conversation) {
    const operation = conversation[3],
      mutation = operation === "share";
    if (method !== (mutation ? "POST" : "GET"))
      return error(405, "Unsupported sharing method.");
    if (!owner) return error(401, "Sign in to continue.");
    if (conversation[1] !== organizationUuid(owner))
      return error(404, "Conversation not found.");
    if (mutation && !canWrite)
      return error(501, "Sharing is unavailable in this read-only host.");
    if (!current()) return error(409, "The account changed. Reload sharing.");
    const id = resolveConversationId(conversation[2]);
    try {
      const owned = await ctx.loadConversation(id);
      if (!current()) return error(409, "The account changed. Reload sharing.");
      if (!owned || owned.id !== id)
        return error(404, "Conversation not found.");
      const currentShare = async () =>
        host
          ? checked(() => host.conversationShare(id, true))
          : ctx.readOnly
            ? null
            : ((await checkedCall(
                "conversationShare",
                id,
              )) as HostedShare | null);
      if (operation === "latest") {
        const end = new URL(req.url ?? p, "http://localhost").searchParams.get(
          "last_message_uuid",
        );
        const shareableEnd =
          end === null ||
          owned.turns.some(
            (turn) =>
              turn.status !== "inProgress" && assistantMessageId(turn) === end,
          );
        const status = host
          ? await checked(() => host.status())
          : ctx.readOnly
            ? null
            : ((await checkedCall("sharingStatus")) as SharingStatus | null);
        const share = await currentShare();
        const live = share?.status === "active" ? share : null;
        return reply(res, {
          shareable:
            status?.conversations === true &&
            !status.blocked &&
            !owned.incognito &&
            shareableEnd,
          org_audience_disabled_by_admin: true,
          visibility: live ? visibilityOf(live) : undefined,
          snapshot: live
            ? {
                uuid: live.id,
                up_to_date: !live.stale,
                visibility: visibilityOf(live),
                url: live.url,
              }
            : null,
        });
      }
      if (operation === "share_access") {
        const share = await currentShare();
        if (!share)
          return reply(
            res,
            {
              type: "error",
              error: { type: "not_found_error", message: "Not shared" },
            },
            404,
          );
        return reply(res, {
          visibility: visibilityOf(share),
          people: (share.invites ?? []).map((email) => ({
            email,
            display: email,
            kind: "email",
            grant_id: grantId(share.id, email),
            role: "view",
          })),
          groups: [],
        });
      }
      if (operation === "shares") {
        const share = await currentShare();
        return reply(res, share ? [shareRow(share, conversation[2])] : []);
      }
      if (operation === "access_requests") return reply(res, { requests: [] });
      const body = await readBoundedJson(req, 64 * 1024);
      if (!current()) return error(409, "The account changed. Reload sharing.");
      if (
        (body.visibility !== undefined &&
          body.visibility !== "public" &&
          body.visibility !== "private" &&
          body.visibility !== "invite_only") ||
        (body.update_only !== undefined &&
          typeof body.update_only !== "boolean") ||
        (body.account_uuids !== undefined &&
          (!Array.isArray(body.account_uuids) ||
            body.account_uuids.length !== 0)) ||
        (body.group_uuids !== undefined &&
          (!Array.isArray(body.group_uuids) ||
            body.group_uuids.length !== 0)) ||
        (body.emails !== undefined &&
          (!Array.isArray(body.emails) ||
            body.emails.length > 100 ||
            body.emails.some(
              (email) =>
                typeof email !== "string" ||
                email.length > 254 ||
                !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email),
            ))) ||
        (body.last_message_uuid !== undefined &&
          (typeof body.last_message_uuid !== "string" ||
            !body.last_message_uuid ||
            body.last_message_uuid.length > 256))
      )
        return error(400, "Invalid sharing options.");
      const fresh = await ctx.loadConversation(id);
      if (!current()) return error(409, "The account changed. Reload sharing.");
      if (!fresh || fresh.id !== id)
        return error(404, "Conversation not found.");
      if (fresh.incognito || (fresh.mode && fresh.mode !== "chat"))
        return error(409, "This conversation can't be shared.");
      let selected = fresh;
      if (body.last_message_uuid !== undefined) {
        const index = fresh.turns.findIndex(
          (turn) =>
            turn.status !== "inProgress" &&
            assistantMessageId(turn) === body.last_message_uuid,
        );
        if (index < 0 || (!host && index !== fresh.turns.length - 1))
          return error(409, "This reply can't be shared.");
        selected = { ...fresh, turns: fresh.turns.slice(0, index + 1) };
      }
      const emails = (body.emails ?? []) as string[];
      let existing = host ? await currentShare() : null;
      if (body.update_only && existing?.status !== "active")
        return reply(
          res,
          {
            type: "error",
            error: {
              type: "share_not_live",
              message: "This share no longer exists.",
            },
          },
          404,
        );
      const access: ShareAccess =
        body.visibility === "public"
          ? "link"
          : body.visibility === "invite_only" || body.visibility === "private"
            ? "invited"
            : (existing?.access ?? (emails.length ? "invited" : "link"));
      if (
        host &&
        existing?.status === "active" &&
        access === "invited" &&
        existing.access !== "invited"
      ) {
        const restricted = await checked(() =>
          host.setShareAccess(id, "invited", true),
        );
        if (restricted?.id !== existing.id || restricted.access !== "invited")
          return error(
            503,
            "The requested sharing access could not be confirmed. Reload sharing.",
          );
        existing = restricted;
      }
      let share = body.update_only
        ? existing
        : host
          ? await checked(() =>
              host.publishConversationSnapshot(selected, access),
            )
          : ((await checkedCall(
              "shareConversation",
              id,
              access,
            )) as HostedShare | null);
      if (
        !share ||
        share.kind !== "conversation" ||
        share.sourceKey !== id ||
        share.status !== "active"
      )
        return error(
          503,
          "The shared link could not be confirmed. Reload sharing before trying again.",
        );
      if ((share.access ?? "link") !== access) {
        share = host
          ? await checked(() => host.setShareAccess(id, access, true))
          : ((await checkedCall(
              "setShareAccess",
              id,
              access,
            )) as HostedShare | null);
        if (!share)
          return error(
            409,
            "No active link was returned after changing access. Reload sharing.",
          );
      }
      const confirmed = (value: HostedShare) =>
        value.kind === "conversation" &&
        value.sourceKey === id &&
        value.status === "active" &&
        (value.access ?? "link") === access;
      if (!confirmed(share))
        return error(
          503,
          "The requested sharing access could not be confirmed. Reload sharing.",
        );
      const invited: string[] = [];
      for (const email of emails) {
        const shareId = share.id;
        const result = (
          host
            ? await checked(() => host.options.service.invite(shareId, email))
            : await checkedCall("inviteToShare", id, email)
        ) as {
          share?: HostedShare;
        } | null;
        if (host && result?.share) host.store(result.share);
        share = result?.share
          ? host
            ? host.present(result.share, id)
            : result.share
          : null;
        invited.push(email);
        if (
          !share ||
          !confirmed(share) ||
          invited.some(
            (address) =>
              !share!.invites?.some(
                (value) => value.toLowerCase() === address.toLowerCase(),
              ),
          )
        )
          return error(
            503,
            "The invitation outcome could not be confirmed. Reload sharing.",
          );
      }
      if (
        share.kind !== "conversation" ||
        share.sourceKey !== id ||
        share.status !== "active" ||
        (share.access ?? "link") !== access ||
        emails.some(
          (email) =>
            !share!.invites?.some(
              (invited) => invited.toLowerCase() === email.toLowerCase(),
            ),
        )
      )
        return error(
          503,
          "The requested sharing access could not be confirmed. Reload sharing.",
        );
      return reply(res, shareRow(share, conversation[2]));
    } catch (cause) {
      if (!current())
        return error(
          409,
          "The account changed. The sharing outcome could not be confirmed.",
        );
      if (cause instanceof RequestBodyError)
        return error(cause.status, cause.message);
      if (cause instanceof SnapshotError)
        return error(cause.reason === "too-large" ? 413 : 409, cause.message);
      return error(
        503,
        "Sharing could not be confirmed. Reload sharing before trying again.",
      );
    }
  }
  // Stop exactly the snapshot requested, never every link from its conversation.
  if (stop) {
    const error = (status: number, message: string) =>
      reply(
        res,
        { type: "error", error: { type: "share_revoke_unconfirmed", message } },
        status,
      );
    if (method !== "DELETE")
      return error(405, "Use DELETE to stop this shared link.");
    if (!canWrite)
      return error(
        501,
        "Stopping shared links is unavailable in this read-only host.",
      );
    const owner = ctx.account()?.id,
      identity = ctx.sessionIdentity?.();
    if (!owner) return error(401, "Sign in to continue.");
    if (stop[1] !== organizationUuid(owner))
      return error(404, "Shared link not found.");
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(stop[2]) || (req.url ?? p).includes("?"))
      return error(400, "Invalid shared link request.");
    const current = () =>
      ctx.account()?.id === owner &&
      ctx.sessionIdentity?.() === identity &&
      ctx.isCurrent?.() !== false;
    try {
      if (!current())
        return error(409, "The account changed. Reload shared links.");
      const bytes = await readBoundedBytes(req, 256);
      if (bytes.length) {
        let body: unknown;
        try {
          body = JSON.parse(bytes.toString("utf8"));
        } catch {
          return error(400, "Invalid shared link request.");
        }
        if (
          !body ||
          typeof body !== "object" ||
          Array.isArray(body) ||
          Object.keys(body).length !== 1 ||
          (body as { snapshotUuid?: unknown }).snapshotUuid !== stop[2]
        )
          return error(
            400,
            "The snapshot must match the requested shared link.",
          );
      }
      if (!current())
        return error(409, "The account changed. Reload shared links.");
      const shares = await list();
      if (!current())
        return error(409, "The account changed. Reload shared links.");
      if (!Array.isArray(shares))
        return error(
          503,
          "Shared links could not be verified. Revocation was not dispatched.",
        );
      const matches = shares.filter(
        (share: HostedShare) =>
          share?.kind === "conversation" && share.id === stop[2],
      );
      // Empty can also mean the underlying status lookup failed. It is not proof
      // this public link was removed; preserve the UI's current link on uncertainty.
      if (matches.length !== 1)
        return error(
          409,
          "This shared link could not be verified. It has not been confirmed revoked.",
        );
      if (host) await checked(() => host.revoke(stop[2]));
      else await ctx.call("revokeShare", stop[2]);
      if (!current())
        return error(
          409,
          "The account changed. The revocation outcome could not be confirmed.",
        );
      return empty(res);
    } catch (cause) {
      if (!current())
        return error(
          409,
          "The account changed. The revocation outcome could not be confirmed.",
        );
      if (cause instanceof RequestBodyError)
        return error(cause.status, cause.message);
      return error(
        503,
        "The shared link could not be confirmed revoked. Keep the link and try again.",
      );
    }
  }
  if (grant) {
    if (method !== "DELETE")
      return error(405, "Use DELETE to remove this invitation.");
    if (!owner || grant[1] !== organizationUuid(owner))
      return error(404, "Invitation not found.");
    if (!canWrite || !host)
      return error(501, "Invitation removal is unavailable.");
    try {
      const share = (await list()).find(
        (row) => row.id === grant[2] && row.status === "active",
      );
      const email = share?.invites?.find(
        (value) => grantId(grant[2], value) === grant[3],
      );
      if (!share || !email) return error(404, "Invitation not found.");
      const updated = await checked(() =>
        host.options.service.uninvite(share.id, email),
      );
      host.store(updated);
      return empty(res);
    } catch {
      return error(
        current() ? 503 : 409,
        "The invitation removal could not be confirmed. Reload sharing.",
      );
    }
  }
  // The public address of a share the page links to.
  if (address || inventory) {
    if (method !== "GET") return error(405, "Use GET to read shared links.");
    if (!owner) return error(401, "Sign in to continue.");
    if (inventory && inventory[1] !== organizationUuid(owner))
      return error(404, "Shared links not found.");
    try {
      const shares = await list();
      if (!Array.isArray(shares))
        return error(503, "Shared links could not be verified.");
      if (inventory)
        return reply(
          res,
          shares
            .filter((s) => s.kind === "conversation")
            .map((s) => shareRow(s, s.sourceKey)),
        );
      const share = shares.find(
        (s) =>
          s.kind === "conversation" && s.id === decodeURIComponent(address![1]),
      );
      if (!share || share.status !== "active")
        return reply(
          res,
          { error: { type: "not_found_error", message: "No active share" } },
          404,
        );
      res.writeHead(200, {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(
        share.access === "invited" && share.inviteUrl
          ? share.inviteUrl
          : share.url,
      );
      return true;
    } catch {
      return error(
        current() ? 503 : 409,
        "Shared links could not be verified. Reload sharing.",
      );
    }
  }
  return false;
}

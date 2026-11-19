import type http from "node:http";
import { z } from "zod";
import { officialResearchShareTarget } from "../../../shared/official-ui-web";
import { researchReportArtifactPrefix } from "./research-report-artifact";
import { versionKeyOf } from "../../artifacts/hosted-shares-support";
import {
  chatArtifactPublicationInput,
  chatPublicationPrefix,
  conversationSnippets,
} from "./artifacts";
import { empty, organizationUuid, reply, type AdapterContext } from "./context";
import { resolveConversationId } from "./conversations";
import { readBoundedJson, RequestBodyError } from "./request-body";

export async function artifactPublishingStatus(ctx: AdapterContext) {
  if ((ctx.readOnly && !ctx.allowArtifactPublishing) || ctx.isCurrent?.() === false) return undefined;
  const host = ctx.artifactPublishing?.();
  if (!host || host.closed) return undefined;
  const status = await host.status().catch(() => null);
  if (
    !status ||
    host.closed ||
    ctx.artifactPublishing?.() !== host ||
    ctx.isCurrent?.() === false
  )
    return;
  return {
    can_publish: status.artifacts && !status.blocked,
    ...(status.usagePolicyUrl
      ? { usage_policy_url: status.usagePolicyUrl }
      : {}),
  };
}

const researchShareRequest = z.object({
  artifact_identifier: z.string().max(100).startsWith(researchReportArtifactPrefix),
  version_uuid: z.string().uuid(),
}).strict();

export async function artifactPublishingRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  ctx: AdapterContext,
) {
  const path =
    /^\/api\/organizations\/([^/]+)\/(publish_artifact|published_artifacts)(?:\/([A-Za-z0-9_-]{1,64})(\/open)?)?$/.exec(
      url.pathname,
    );
  const researchShare = officialResearchShareTarget(url.pathname);
  if (!path && !researchShare) return false;
  const [, organization = researchShare?.organizationId, operation, shareId, openPath] = path ?? [];
  const list =
    operation === "published_artifacts" && !shareId && req.method === "GET";
  const publish =
    operation === "publish_artifact" && !shareId && req.method === "POST";
  const revoke =
    operation === "published_artifacts" &&
    !!shareId &&
    !openPath &&
    req.method === "DELETE";
  const open =
    operation === "published_artifacts" && !!openPath && req.method === "POST";
  const fail = (
    status: number,
    message: string,
    type = "invalid_request_error",
  ) => reply(res, { type: "error", error: { type, message } }, status);
  if (!list && !publish && !revoke && !open && !(researchShare && req.method === "POST"))
    return fail(405, "Unsupported publication method.");
  if (
    url.search &&
    (!list || !/^\?include_deleted_artifacts=(?:true|false)$/.test(url.search))
  )
    return fail(400, "Unsupported publication query.");
  const owner = ctx.account()?.id;
  if (!owner || organization !== organizationUuid(owner))
    return fail(404, "Artifact not found.", "not_found_error");
  const identity = ctx.sessionIdentity?.();
  const host = ctx.readOnly && !ctx.allowArtifactPublishing ? undefined : ctx.artifactPublishing?.();
  const current = () =>
    ctx.isCurrent?.() !== false &&
    ctx.account()?.id === owner &&
    ctx.sessionIdentity?.() === identity &&
    ctx.artifactPublishing?.() === host &&
    !host?.closed;
  const retired = () => fail(409, "The account changed. Reopen the artifact.");
  if (!host)
    return list
      ? reply(res, [])
      : fail(
          403,
          "Artifact publication is unavailable.",
          "feature_not_available",
        );
  if (!current()) return retired();
  try {
    if (researchShare) {
      const input = researchShareRequest.safeParse(await readBoundedJson(req, 1024));
      if (!input.success) return fail(400, "Choose a saved Research report version.");
      if (!current()) return retired();
      const id = resolveConversationId(researchShare.conversationId);
      const conversation = await ctx.loadConversation(id);
      if (!current()) return retired();
      const version = conversation?.id === id &&
        conversationSnippets(owner, conversation, undefined, true).find(report =>
          report.artifact_identifier === input.data.artifact_identifier && report.uuid === input.data.version_uuid);
      if (!version) return fail(404, "Research report version not found.", "not_found_error");
      // The original client supports continuing through its version-scoped publication flow.
      return reply(res, { outcome: "use_classic" });
    }
    if (publish) {
      const body = await readBoundedJson(req, 12 * 1024 * 1024);
      if (!current()) return retired();
      if (
        typeof body.conversation_uuid !== "string" ||
        typeof body.artifact_version_uuid !== "string" ||
        typeof body.artifact_identifier !== "string" ||
        typeof body.message_uuid !== "string"
      )
        return fail(400, "Choose a saved artifact version.");
      const id = resolveConversationId(body.conversation_uuid);
      const conversation = await ctx.loadConversation(id);
      if (!current()) return retired();
      const row =
        conversation?.id === id &&
        conversationSnippets(owner, conversation, undefined, true).find(
          (candidate) =>
            candidate.uuid === body.artifact_version_uuid &&
            candidate.artifact_identifier === body.artifact_identifier &&
            candidate.message_uuid === body.message_uuid,
        );
      const input = row && chatArtifactPublicationInput(row);
      if (!input)
        return fail(404, "Artifact version not found.", "not_found_error");
      if (
        body.content !== input.content &&
        body.content !== input.content.trimStart()
      )
        return fail(409, "This artifact changed. Reopen it before publishing.");
      if (host.unpublished.size && host.unpublished.has(versionKeyOf(input)))
        return fail(409, "This artifact version was previously unpublished.");
      const status = await host.status();
      if (!current()) return retired();
      if (!status?.artifacts || status.blocked)
        return fail(
          403,
          "Artifact publication is unavailable.",
          "feature_not_available",
        );
      const share = await host.publishArtifact(input);
      if (!current()) return retired();
      if (share.status !== "active")
        return fail(409, "This artifact is unavailable for publication.");
      return reply(res, { published_artifact_uuid: share.id, url: share.url });
    }

    const status = await host.status();
    if (!current()) return retired();
    if (!status)
      return list
        ? reply(res, [])
        : fail(
            403,
            "Artifact publication is unavailable.",
            "feature_not_available",
          );
    const entries = (await host.publishedArtifactVersions()).flatMap(
      ({ share, versionId }) => {
        if (!share.sourceKey.startsWith(`["${chatPublicationPrefix}",`))
          return [];
        const [, conversationId, artifactId] = JSON.parse(
          share.sourceKey,
        ) as string[];
        return [{ share, versionId, conversationId, artifactId }];
      },
    );
    if (!current()) return retired();
    if (revoke || open) {
      const entry = entries.find(({ share }) => share.id === shareId);
      if (!entry)
        return fail(404, "Published artifact not found.", "not_found_error");
      if (open) {
        if (entry.share.status !== "active")
          return fail(404, "Published artifact not found.", "not_found_error");
        if (!ctx.localCall)
          return fail(
            501,
            "Opening a hosted link is unavailable on this host.",
          );
        await ctx.localCall("openShare", entry.share.id);
      } else await host.unpublishArtifact(entry.share.sourceKey);
      return current() ? empty(res) : retired();
    }
    const includeDisabled =
      url.searchParams.get("include_deleted_artifacts") === "true";
    return reply(
      res,
      entries
        .filter(({ share }) => share.status === "active" || includeDisabled)
        .map(({ share, versionId, conversationId, artifactId }) => ({
          published_artifact_uuid: share.id,
          artifact_version_uuid: versionId,
          artifact_uuid: artifactId,
          chat_conversation_uuid: conversationId,
          title: share.title,
          created_at: new Date(share.createdAt).toISOString(),
          ...(share.status === "active"
            ? { url: share.url }
            : { deleted: true }),
        })),
    );
  } catch (error) {
    if (!current()) return retired();
    if (error instanceof RequestBodyError)
      return fail(error.status, error.message);
    ctx.log("[official-ui] artifact publication failed", error);
    return fail(
      503,
      "The artifact publication could not be confirmed. Try again.",
    );
  }
}

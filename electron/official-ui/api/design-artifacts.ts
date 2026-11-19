import { randomUUID } from "node:crypto";
import {
  blankArtifactCreateInFlightCode,
  blankArtifactCreateUnconfirmedCode,
} from "../../../shared/blank-artifacts";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  isOwnedDesign,
  officialDesignArtifactTarget,
  officialDesignCreateBody,
  officialDesignCreateMaxBytes,
  officialDesignType,
} from "../../../shared/official-design-artifacts";
import { organizationUuid, reply, type AdapterContext } from "./context";
import { readBoundedJson, RequestBodyError } from "./request-body";

type DesignContext = Pick<
  AdapterContext,
  | "account"
  | "sessionIdentity"
  | "isCurrent"
  | "designArtifacts"
  | "listConversations"
  | "log"
>;

export async function designArtifactsRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: DesignContext,
): Promise<boolean> {
  const target = officialDesignArtifactTarget(
    req.method ?? "GET",
    url.pathname + url.search,
  );
  if (!target) return false;
  const fail = (
    status: number,
    type: string,
    message: string,
    headers?: Record<string, string>,
  ) => reply(res, { type: "error", error: { type, message } }, status, headers);
  const retired = () =>
    fail(409, "invalid_request_error", "The account changed. Reopen Design.");
  if (ctx.isCurrent?.() === false) return retired();
  const owner = ctx.account()?.id;
  if (!owner) return fail(401, "authentication_error", "Sign in to continue.");
  if (!target.query)
    return fail(
      400,
      "invalid_request_error",
      "Invalid Design query parameters.",
    );
  const organization = organizationUuid(owner);
  if (target.query.org !== organization)
    return fail(404, "not_found_error", "Organization not found.");
  const identity = ctx.sessionIdentity?.();
  const current = () =>
    ctx.isCurrent?.() !== false &&
    ctx.account()?.id === owner &&
    ctx.sessionIdentity?.() === identity;

  try {
    if (target.kind === "types")
      return reply(res, {
        types: ctx.designArtifacts ? [officialDesignType] : [],
      });
    if (target.kind === "list") {
      const { limit, rel, type } = target.query;
      if (
        rel === "shared" ||
        type === "none" ||
        (type && !type.includes(officialDesignType.slug))
      )
        return reply(res, { frames: [] });
      const conversations = await ctx.listConversations();
      if (!current()) return retired();
      const frames = conversations
        .filter((conversation) =>
          isOwnedDesign(conversation, owner, organization),
        )
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, limit)
        .map((conversation) => ({
          slug: conversation.blankArtifact.id,
          rel: "mine",
          title: conversation.title,
          type_slug: officialDesignType.slug,
          type_title: officialDesignType.title,
          created_at: new Date(
            conversation.blankArtifact.createdAt,
          ).toISOString(),
          updatedAt: new Date(conversation.updatedAt).toISOString(),
        }));
      return reply(res, { frames });
    }
    const host = ctx.designArtifacts;
    if (!host)
      return fail(
        501,
        "feature_not_available",
        "Design creation is unavailable on this host.",
      );
    if (
      !/^application\/json(?:\s*;|$)/i.test(req.headers["content-type"] ?? "")
    )
      return fail(
        400,
        "invalid_request_error",
        "Design creation requires JSON.",
      );
    const input = officialDesignCreateBody.safeParse(
      await readBoundedJson(req, officialDesignCreateMaxBytes),
    );
    if (!current()) return retired();
    if (!input.success)
      return fail(
        400,
        "invalid_request_error",
        "Invalid Design creation options.",
      );
    const { slug } = await host.create({
      requestId: target.query.idempotency_key ?? randomUUID(),
      title: input.data.title ?? "Untitled",
      ...(target.query.idempotency_key && { retryInFlight: true }),
    });
    return current() ? reply(res, { slug }) : retired();
  } catch (error) {
    if (!current()) return retired();
    if (error instanceof RequestBodyError)
      return fail(error.status, "invalid_request_error", error.message);
    if (
      target.kind === "create" &&
      target.query.idempotency_key &&
      error &&
      typeof error === "object" &&
      "code" in error
    ) {
      if (error.code === blankArtifactCreateInFlightCode) {
        return fail(409, "api_error", "This Design is still being created.", {
          "Retry-After": "1",
          "X-Frame-Refusal": "create_in_flight",
        });
      }
      if (error.code === blankArtifactCreateUnconfirmedCode) {
        return fail(
          503,
          "api_error",
          "The Design save could not be confirmed; retry with the same idempotency_key.",
          { "Retry-After": "1" },
        );
      }
    }
    ctx.log("[official-ui] Design request failed", error);
    return fail(
      503,
      "api_error",
      "The Design request could not be confirmed. Try again.",
    );
  }
}

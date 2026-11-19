import { materializeSideQuestionAttachments } from "./side-question-attachments";
import type http from "node:http";
import {
  sideQuestionContext,
  sideQuestionInputSchema,
} from "./side-question-context";
import { streamSideQuestion } from "./side-question-gateway";
import { organizationUuid, reply, type AdapterContext } from "./context";
import { resolveConversationId } from "./conversations";
import { readBoundedJson, RequestBodyError } from "./request-body";
import { publicSideQuestionError } from "../../../shared/side-question-errors.mjs";

const path =
  /^\/api\/organizations\/([^/]+)\/chat_conversations\/([^/]+)\/side_question$/;

export async function nativeSideQuestionRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  p: string,
  ctx: AdapterContext,
): Promise<boolean> {
  const match = path.exec(p);
  if (!match) return false;
  const fail = (status: number, message: string) =>
    reply(
      res,
      { type: "error", error: { type: "invalid_request_error", message } },
      status,
    );
  if (req.method !== "POST")
    return fail(405, "Use POST to ask a side question.");
  if (new URL(req.url ?? p, "http://localhost").search)
    return fail(400, "Side-question query parameters are unsupported.");
  if (!ctx.sideQuestionGateway || ctx.readOnly)
    return fail(501, "Side questions are unavailable on this host.");
  const owner = ctx.account()?.id,
    identity = ctx.sessionIdentity?.();
  const current = () => {
    try {
      return (
        !!owner &&
        identity != null &&
        ctx.isCurrent?.() === true &&
        ctx.account()?.id === owner &&
        ctx.sessionIdentity?.() === identity
      );
    } catch {
      return false;
    }
  };
  if (!current()) return fail(409, "The account activation changed.");
  if (match[1] !== organizationUuid(owner!))
    return fail(404, "The conversation is unavailable.");
  let input;
  try {
    input = sideQuestionInputSchema.parse(
      await readBoundedJson(req, 3 * 1024 * 1024),
    );
  } catch (error) {
    return fail(
      error instanceof RequestBodyError ? error.status : 400,
      "Invalid side-question request.",
    );
  }
  if (!current()) return fail(409, "The account activation changed.");
  const id = resolveConversationId(match[2]);
  try {
    const conversation = await ctx.loadConversation(id);
    if (!current()) return fail(409, "The account activation changed.");
    if (!conversation || conversation.id !== id)
      return fail(404, "The conversation is unavailable.");
    const messages = sideQuestionContext(conversation, input);
    const model = input.model ?? conversation.model;
    const provider = ctx
      .settings()
      .providers.find((candidate) => candidate.id === conversation.providerId);
    if (
      !provider ||
      (provider.model !== model && !provider.models.includes(model))
    )
      return fail(400, "The selected side-question model is unavailable.");
    const catalog = await ctx.modelCatalog();
    if (!current()) return fail(409, "The account activation changed.");
    const entry = catalog?.items.find((item) => item.id === model);
    if (catalog && !entry)
      return fail(400, "The selected side-question model is unavailable.");
    let reasoning: { effort: string } | undefined;
    if (input.thinking_mode === "standard" || input.thinking_mode === "off") {
      if (!catalog)
        return fail(
          501,
          "This model cannot verify standard thinking for side questions.",
        );
      if (entry?.efforts?.length) {
        if (!entry.efforts.includes("none"))
          return fail(
            501,
            "This model cannot select standard thinking for side questions.",
          );
        reasoning = { effort: "none" };
      }
    }
    const controller = new AbortController();
    const abort = () => controller.abort();
    req.once("aborted", abort);
    res.once("close", abort);
    let gatewayCurrent = () => true;
    const interval = setInterval(() => {
      try {
        if (!current() || !gatewayCurrent()) abort();
      } catch {
        abort();
      }
    }, 1000);
    interval.unref();
    try {
      const gateway = await ctx.sideQuestionGateway(
        conversation,
        model,
        controller.signal,
      );
      if (!current() || controller.signal.aborted)
        throw Error("The account activation changed.");
      if (
        (conversation.projectId ||
          conversation.sessionInstructions ||
          ctx.settings().instructions) &&
        (!gateway.instructions || !gateway.verifyContext)
      )
        throw Error("The side-question instructions are unavailable.");
      const latest = await ctx.loadConversation(id);
      if (
        !current() ||
        controller.signal.aborted ||
        !latest ||
        JSON.stringify(sideQuestionContext(latest, input)) !==
          JSON.stringify(messages)
      )
        throw Error("The side-question source changed. Try again.");
      const prepared = await materializeSideQuestionAttachments(
        ctx,
        id,
        messages,
        current,
        controller.signal,
      );
      gatewayCurrent = () => gateway.current();
      const guarded = {
        ...gateway,
        current: () => current() && gateway.current(),
        open: async () => {
          const target = await gateway.open();
          try {
            await prepared.verify();
            const fresh = await ctx.loadConversation(id);
            if (
              !current() ||
              controller.signal.aborted ||
              !fresh ||
              JSON.stringify(sideQuestionContext(fresh, input)) !==
                JSON.stringify(messages)
            )
              throw Error("The side-question source changed. Try again.");
            gateway.verifyContext?.(fresh);
            return target;
          } catch (error) {
            await gateway.close(target.path).catch(() => {});
            throw error;
          }
        },
      };
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-store",
      });
      await streamSideQuestion(guarded, {
        model,
        messages: prepared.messages,
        reasoning,
        instructions: gateway.instructions,
        signal: controller.signal,
        onDelta: (delta) => {
          if (!current() || controller.signal.aborted || res.destroyed)
            throw Error("The side-question account changed.");
          res.write(
            `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: delta } })}\n\n`,
          );
        },
      });
      if (!controller.signal.aborted && !res.destroyed)
        res.end('event: message_stop\ndata: {"type":"message_stop"}\n\n');
    } catch (error) {
      if (!controller.signal.aborted && !res.destroyed) {
        if (!res.headersSent)
          return fail(
            409,
            publicSideQuestionError(error),
          );
        res.end(
          `event: error\ndata: ${JSON.stringify({ type: "error", error: { type: "api_error", message: "The side question could not be completed." } })}\n\n`,
        );
      }
    } finally {
      clearInterval(interval);
      req.removeListener("aborted", abort);
      res.removeListener("close", abort);
    }
    return true;
  } catch (error) {
    return fail(
      409,
      publicSideQuestionError(error),
    );
  }
}

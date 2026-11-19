/** Native HTTP SSE over the same strict completion transaction/receipts as the runner. */
import http from "node:http";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  openOfficialCompletion,
  completionPath,
} from "../../../shared/official-completion-stream";
import {
  officialUiRequestLimit,
  type OfficialUiReadRequest,
  type OfficialUiReadResponse,
} from "../../../shared/official-ui-web";
import {nativeCompletionInlineSchema} from "./completion-attachments";
import {builtInAttachmentBytes} from "../../../shared/client-policy";
import { withNativeCompletionAttachments } from "./native-completion-attachments";
import { createRestCompletionRoute } from "./rest-completion";
import { readBoundedBytes, RequestBodyError } from "./request-body";
import { organizationUuid, reply, type AdapterContext } from "./context";
import { resolveConversationId } from "./conversations";
import { bindAdapterScope } from "./scope";
/** New bounded native envelope, preserving 12 original 2 MiB UTF-8 text
 * attachments even with worst-case JSON escaping, plus the existing 1 MiB
 * non-attachment envelope. The former native readBody had no total limit. */
export const nativeCompletionRequestMaxBytes = 12 * builtInAttachmentBytes.text * 6 + 1024 * 1024;
class NativeCompletionLeaseError extends Error {}
const uuid = "[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}";
const stopPath = new RegExp(`^/api/organizations/(${uuid})/chat_conversations/(${uuid})/stop_response$`, "i");
class BatchResponse extends Writable {
  status = 200;
  headers: Record<string, string> = {};
  chunks: Buffer[] = [];
  size = 0;
  writeHead(status: number, headers: Record<string, string> = {}) {
    this.status = status;
    this.headers = headers;
    return this;
  }
  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    done: (error?: Error | null) => void,
  ) {
    if (chunk.length > 256 * 1024 - this.size) {
      done(Error("Native completion batch is too large."));
      return;
    }
    this.size += chunk.length;
    this.chunks.push(Buffer.from(chunk));
    done();
  }
}
export function createNativeRestCompletionRoute(
  ctx: AdapterContext,
  options: { pollMs?: number; deadlineMs?: number } = {},
) {
  const route = createRestCompletionRoute(withNativeCompletionAttachments(ctx), {maxRequestBytes:nativeCompletionRequestMaxBytes,inlineAttachmentsSchema:nativeCompletionInlineSchema,nativeWebSearch:true});
  const invoke = async (
    request: OfficialUiReadRequest,
  ): Promise<OfficialUiReadResponse> => {
    const url = new URL(request.path, "http://localhost");
    const req = Readable.from(
      request.body ? [Buffer.from(request.body)] : [],
    ) as http.IncomingMessage;
    req.method = request.method;
    req.url = request.path;
    req.headers = request.contentType
      ? { "content-type": request.contentType }
      : {};
    const res = new BatchResponse();
    const finished = new Promise<void>((resolve, reject) => {
      res.once("finish", resolve);
      res.once("error", reject);
    });
    void finished.catch(() => {});
    try {
      const handled = await route(
        req,
        res as unknown as http.ServerResponse,
        url.pathname,
        url,
      );
      if (!handled) throw Error("Unexpected native completion route.");
      await finished;
      return {
        status: res.status,
        contentType: res.headers["Content-Type"] ?? "application/json",
        body: Buffer.concat(res.chunks),
      };
    } catch (error) {
      res.destroy();
      throw error;
    }
  };
  return async (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    p: string,
    url: URL,
  ): Promise<boolean> => {
    if (req.method !== "POST") return route(req, res, p, url);
    const completion = completionPath.exec(p);
    const target = completion ?? stopPath.exec(p);
    if (!target)
      return route(req, res, p, url);
    const [, organization, pageId] = target;
    const conversationId = resolveConversationId(pageId);
    const cloud = ctx.isCloudConversation?.(conversationId) === true;
    if (!completion && !cloud) return route(req, res, p, url);
    if (url.search)
      return reply(
        res,
        { error: { message: "Completion query parameters are unsupported." } },
        400,
      );
    const owner = ctx.account()?.id,
      identity = ctx.sessionIdentity?.();
    const personalOrganization = owner && organizationUuid(owner);
    const checkLease = () => {
      if (
        ctx.isCurrent?.() === false ||
        !owner ||
        ctx.account()?.id !== owner ||
        ctx.sessionIdentity?.() !== identity
      )
        throw new NativeCompletionLeaseError(
          "The account changed while opening completion. Reopen the conversation.",
        );
    };
    const boundInvoke = bindAdapterScope(
      async (request: OfficialUiReadRequest) => {
        checkLease();
        const result = await invoke(request);
        checkLease();
        return result;
      },
    );
    const controller = new AbortController();
    const abort = () => controller.abort();
    req.once("aborted", abort);
    res.once("close", abort);
    try {
      checkLease();
      let requestBatch = boundInvoke;
      if (cloud) {
        const rows = await ctx.listConversations();
        checkLease();
        const current = rows.find(c => c.id === conversationId && c.mode === "chat" &&
          (!c.sessionAuthors || c.sessionAuthors.ownerAccountUuid === owner));
        if (current?.projectOrganizationId) {
          if (organization !== personalOrganization && organization !== current.projectOrganizationId)
            return reply(res, { error: { message: "Conversation not found." } }, 404);
          const forward = ctx.captureOfficialOrganizationProjectChat?.();
          if (!forward) return reply(res, { error: { message: "The shared project chat is unavailable. Try again when it reconnects." } }, 503);
          requestBatch = async (request) => {
            checkLease();
            if (!ctx.isCloudConversation?.(conversationId) || resolveConversationId(pageId) !== conversationId)
              throw new NativeCompletionLeaseError("The shared project chat changed. Reopen the conversation.");
            const path = request.path.replace(`/chat_conversations/${pageId}/`, `/chat_conversations/${conversationId}/`);
            const answer = await forward({ ...request, path }, controller.signal);
            checkLease();
            if (!answer) throw Error("The shared project chat is unavailable.");
            return answer;
          };
        } else if (!completion) return route(req, res, p, url);
      }
      const bodyLimit = requestBatch === boundInvoke ? nativeCompletionRequestMaxBytes : officialUiRequestLimit("POST", p);
      const body = await readBoundedBytes(req, completion ? bodyLimit : 4096);
      checkLease();
      if (req.aborted || res.destroyed) {
        abort();
        return true;
      }
      const request = {
        method: "POST" as const,
        path: p,
        body,
        contentType: String(req.headers["content-type"] ?? ""),
      };
      if (!completion) {
        const answer = await requestBatch(request);
        if (controller.signal.aborted) return true;
        res.writeHead(answer.status, { "Content-Type": answer.contentType, "Cache-Control": "no-store" });
        res.end(answer.body);
        return true;
      }
      const response = await openOfficialCompletion(
        request,
        controller.signal,
        requestBatch,
        requestBatch,
        (listener) => ctx.onEvent(bindAdapterScope(listener)),
        options,
      );
      if (controller.signal.aborted) return true;
      checkLease();
      res.writeHead(
        response.status,
        Object.fromEntries(response.headers.entries()),
      );
      if (response.body)
        await pipeline(Readable.fromWeb(response.body as any), res);
      else res.end();
    } catch (error) {
      if (!controller.signal.aborted && !res.destroyed) {
        if (!res.headersSent)
          reply(
            res,
            {
              error: {
                message:
                  error instanceof RequestBodyError ||
                  error instanceof NativeCompletionLeaseError
                    ? error.message
                    : "The completion stream could not be opened. Check the conversation before retrying.",
              },
            },
            error instanceof RequestBodyError
              ? error.status
              : error instanceof NativeCompletionLeaseError
                ? 409
                : 503,
          );
        else res.destroy();
      }
    } finally {
      abort();
      req.removeListener("aborted", abort);
      res.removeListener("close", abort);
    }
    return true;
  };
}

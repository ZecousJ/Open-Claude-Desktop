import { upstreamModel } from "../../shared/tool-search-mode";
import {
  toolStartFromResponse,
  type ToolStartEvent,
} from "../../shared/tool-start";
import {
  generatedImageFromResponse,
  type GeneratedImageEvent,
} from "../../server/image-observer";
import http from "node:http";
import { randomUUID, randomBytes, timingSafeEqual } from "node:crypto";
import type { Protocol, Provider, UsageRecord } from "../../shared/types";
import type { RequestLimiter } from "../../server/request-limiter";
import {
  agentPromptFromResponse,
  type AgentPromptEvent,
} from "../../server/agent-prompt-observer";
import {
  describeStreamRefusal,
  describeSub2ApiRefusal,
  type GatewayRefusal,
} from "../../server/sub2api-errors";
import { claudexHeaders } from "../../shared/claudex-contract";
import { routeForModel } from "../../shared/provider-routes";
import {
  augmentToolSchemas,
  toolDescriptionFromResponse,
} from "../../server/tool-descriptions";
import {
  augmentWebSearchRequest,
  webSourcesFromResponse,
} from "../../server/web-source-observer";
import {
  defaultRequestOptions,
  type GatewayRequestOptions,
  type ToolDescriptionEvent,
  type WebSourcesEvent,
} from "../../shared/gateway-signals";
import { claudexClientInfo } from "../sub2api/http";
import { isDrawingModel } from "../../shared/model-catalog-api";
import { withoutEmptyImageCalls } from "../../server/drawing-turn";
import { endpoint, toChat, streamChatResponse } from "./gateway-chat";
import * as gatewayImages from "./gateway-images";
import { installMethods } from "./install-methods";
import {
  maxRefusalBodyChars,
  Json,
  readSSE,
  redact,
  sseFrame,
  readBody,
} from "./gateway-support";
/**
 * The Codex thread a request belongs to, as the `session_id` header the
 * Claudex service records with its usage (usage_logs.session_id), so a
 * session's usage report can ask what the session used. Codex itself names
 * its thread this way, and its prompt cache key (which the service otherwise
 * keeps a session on one account by) is the same id.
 */
export function sessionHeader(
  threadId: string | undefined,
): Record<string, string> {
  return threadId && /^[\w.:-]{1,255}$/.test(threadId)
    ? { session_id: threadId }
    : {};
}
/**
 * The product a thread's requests count under in the service's usage by
 * product (backend usage/products.go): Code, Cowork or Chat.
 */
export function productHeader(
  product: "code" | "cowork" | "chat" | undefined,
): Record<string, string> {
  return product ? { "x-claudex-product": product } : {};
}
/** Largest request body accepted from Codex. */
const maxRequestBytes = 32 * 1024 * 1024;
/** Upstream model requests are cancelled after this long. */
const upstreamTimeoutMs = 10 * 60_000;
/**
 * Ledger counters from Responses or Chat Completions usage. Usage is known
 * only when the provider reported both input and output tokens.
 */
function usageCounters(usage: Json | undefined) {
  const count = (value: unknown) =>
    typeof value === "number" && Number.isInteger(value) && value >= 0
      ? value
      : 0;
  const input = usage?.input_tokens ?? usage?.prompt_tokens;
  const output = usage?.output_tokens ?? usage?.completion_tokens;
  return {
    usageKnown: typeof input === "number" && typeof output === "number",
    inputTokens: count(input),
    outputTokens: count(output),
    cachedTokens: count(
      usage?.input_tokens_details?.cached_tokens ??
        usage?.prompt_tokens_details?.cached_tokens,
    ),
    reasoningTokens: count(
      usage?.output_tokens_details?.reasoning_tokens ??
        usage?.completion_tokens_details?.reasoning_tokens,
    ),
  };
}
/** Side readers of the model's stream (S1): each is told what it found. */
export interface GatewayObservers {
  /** A shell command's description from the model's function call (R7). */
  onToolDescription?: (event: ToolDescriptionEvent) => void;
  /** Web search sources and citations (R45). */
  onWebSources?: (event: WebSourcesEvent) => void;
  /** A picture the built-in image tool made (server/image-observer.ts). */
  onGeneratedImage?: (event: GeneratedImageEvent) => void;
  /** A file write the model has begun (shared/tool-start.ts). */
  onToolStart?: (event: ToolStartEvent) => void;
}
/**
 * Loopback endpoint that Codex treats as its Responses API. It holds the
 * upstream key, enforces the account's model list and limits, translates to
 * Chat Completions when needed, and records request metadata.
 */
export class Gateway {
  token = randomBytes(32).toString("hex");
  url = "";
  private server?: http.Server;
  private threadRequests = new Map<string, Set<AbortController>>();
  /** Each thread's product, as the main process told it (bounded). */
  private threadProducts = new Map<string, "code" | "cowork" | "chat">();
  setThreadProduct(threadId: string, product: "code" | "cowork" | "chat") {
    this.threadProducts.delete(threadId);
    this.threadProducts.set(threadId, product);
    if (this.threadProducts.size > 5000)
      this.threadProducts.delete(this.threadProducts.keys().next().value!);
  }
  constructor(
    public getProvider: () => {
      provider: Provider;
      apiKey: string;
      /** The key of a vault entry: another service group's device key (MG). */
      keyFor?: (keyId: string) => string;
    },
    private recordUsage?: (record: UsageRecord) => void,
    private limiter?: RequestLimiter,
    private onAgentPrompt?: (event: AgentPromptEvent) => void,
    /** A Sub2API refusal (limit, balance, plan or key), already in plain English. */
    public onRefusal?: (refusal: GatewayRefusal) => void,
    private observers: GatewayObservers = {},
  ) {}
  /** How requests are rewritten; the main process updates it (requestOptions). */
  requestOptions: GatewayRequestOptions = defaultRequestOptions;
  setRequestOptions(options: GatewayRequestOptions) {
    this.requestOptions = {
      describeTools: options.describeTools,
      xSearchModels: [...options.xSearchModels],
      ...(options.imageModel ? { imageModel: options.imageModel } : {}),
    };
  }
  /** Reports what one stream event says to the observers; never throws. */
  observe(event: Json, threadId: string | undefined) {
    try {
      const description = toolDescriptionFromResponse(event, threadId);
      if (description) this.observers.onToolDescription?.(description);
      const sources = webSourcesFromResponse(event, threadId);
      if (sources) this.observers.onWebSources?.(sources);
      const image = generatedImageFromResponse(event, threadId);
      if (image) this.observers.onGeneratedImage?.(image);
      const started = toolStartFromResponse(event, threadId);
      if (started) this.observers.onToolStart?.(started);
    } catch {
      /* Observation never affects the forwarded response. */
    }
  }
  /**
   * The request as sent upstream: shell tools asked for a description (R7)
   * and, on the Responses protocol, search sources requested and grok's X
   * search added (R45). The request from Codex is not changed.
   */
  private rewrite(request: Json, protocol: Protocol) {
    const options = this.requestOptions;
    const sent = withoutEmptyImageCalls(request);
    let rewritten = options.describeTools ? augmentToolSchemas(sent) : sent;
    if (protocol === "responses")
      rewritten = augmentWebSearchRequest(rewritten, {
        xSearch:
          typeof request.model === "string" &&
          options.xSearchModels.includes(request.model),
      });
    return rewritten;
  }
  abortThread(threadId: string) {
    for (const controller of this.threadRequests.get(threadId) ?? [])
      controller.abort(new Error("The request was cancelled."));
  }
  private trackThread(threadId: string, controller: AbortController) {
    const active =
      this.threadRequests.get(threadId) ?? new Set<AbortController>();
    active.add(controller);
    this.threadRequests.set(threadId, active);
  }
  private untrackThread(threadId: string, controller: AbortController) {
    const active = this.threadRequests.get(threadId);
    active?.delete(controller);
    if (!active?.size) this.threadRequests.delete(threadId);
  }
  /** Only the local Codex process holds the token. Browsers send Origin with POST requests, so those are refused. */
  private isAuthorized(req: http.IncomingMessage) {
    const auth = Buffer.from(req.headers.authorization ?? "");
    const expected = Buffer.from(`Bearer ${this.token}`);
    return (
      auth.length === expected.length &&
      timingSafeEqual(auth, expected) &&
      !req.headers.origin
    );
  }
  /** Streams a Responses body to Codex unchanged while observing usage and child-agent prompts. */
  private async forwardResponses(
    upstream: Response,
    res: http.ServerResponse,
    threadId: string | undefined,
    onUsage: (usage: Json) => void,
    remote: boolean,
  ) {
    if (!upstream.body) throw new Error("The response was empty.");
    const [forward, inspect] = upstream.body.tee();
    const observed = (async () => {
      try {
        for await (const event of readSSE(inspect)) {
          if (event.type === "response.completed" && event.response?.usage)
            onUsage(event.response.usage);
          // Sub2API ends a started stream with response.failed when a limit hits mid-request.
          if (remote && event.type === "response.failed") {
            const refusal = describeStreamRefusal(event.response?.error);
            if (refusal) this.onRefusal?.(refusal);
          }
          const prompt = agentPromptFromResponse(event, threadId);
          if (prompt) this.onAgentPrompt?.(prompt);
          this.observe(event, threadId);
        }
      } catch {
        /* The model response is forwarded unchanged even if accounting is absent. */
      }
    })();
    for await (const chunk of forward as any) {
      if (res.destroyed) break;
      res.write(chunk);
    }
    await observed;
  }
  private async handle(req: http.IncomingMessage, res: http.ServerResponse) {
    if (!this.isAuthorized(req)) {
      res.writeHead(401).end();
      return;
    }
    const route = req.url?.split("?")[0];
    if (
      req.method === "POST" &&
      (route === "/v1/images/generations" || route === "/v1/images/edits")
    ) {
      await this.handleImages(
        req,
        res,
        route === "/v1/images/edits" ? "images/edits" : "images/generations",
      );
      return;
    }
    if (req.method !== "POST" || route !== "/v1/responses") {
      res
        .writeHead(404)
        .end(JSON.stringify({ error: { message: "Unsupported endpoint" } }));
      return;
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), upstreamTimeoutMs);
    res.on("close", () => controller.abort());
    const startedAt = Date.now();
    // Filled in as the request progresses; used for redaction and the usage record.
    let apiKey = "";
    let threadId: string | undefined;
    let providerId = "";
    let model = "";
    let protocol: Protocol = "responses";
    let upstreamUsage: Json | undefined;
    let httpStatus = 502;
    // Status reported to Codex if the current step throws.
    let failureStatus = 502;
    // Last Chat bridge event state, so a mid-stream failure ends the same response.
    let lastResponse: Json | undefined;
    let nextSequence = 0;
    let releaseLimit: (() => void) | undefined;
    try {
      const raw = await readBody(req, maxRequestBytes);
      if (!raw) {
        failureStatus = 413;
        throw new Error("The request is larger than 32 MB.");
      }
      failureStatus = 400;
      const request = JSON.parse(raw.toString());
      if (!request || typeof request !== "object" || Array.isArray(request))
        throw new Error("The request must be a JSON object.");
      // A model's twin that preloads connector tools (Tool access) is the
      // same model upstream (shared/tool-search-mode.ts).
      if (typeof request.model === "string")
        request.model = upstreamModel(request.model);
      if (typeof request.model === "string")
        model = request.model.slice(0, 200);
      const requestThread =
        request.client_metadata?.thread_id ?? request.prompt_cache_key;
      if (typeof requestThread === "string" && requestThread) {
        threadId = requestThread;
        this.trackThread(threadId, controller);
      }
      const current = this.getProvider();
      const { provider } = current;
      apiKey = current.apiKey;
      providerId = provider.id;
      protocol = provider.protocol;
      // Auto mode's reviewer asks for Codex's own review model, which no
      // service group offers (403 here, and every reviewed action was then
      // rejected as "unacceptable risk"): it reviews with the account's model
      // instead.
      if (
        typeof request.model === "string" &&
        /^codex-auto-review\b/.test(request.model) &&
        provider.model
      ) {
        request.model = provider.model;
        model = request.model;
      }
      // An account with several service groups sends each model with its
      // group's key and protocol (MG); without that key, the plan group's.
      const route = routeForModel(provider, request.model);
      if (route) {
        const routeKey = route.primary ? "" : current.keyFor?.(route.keyId);
        if (route.primary || routeKey) protocol = route.protocol;
        if (routeKey) apiKey = routeKey;
      }
      if (
        provider.models.length &&
        !new Set([provider.model, ...provider.models]).has(request.model)
      ) {
        failureStatus = 403;
        throw new Error("This account can't use this model.");
      }
      // A picture model's conversation: each message is answered with a
      // picture from the image endpoint (server/drawing-turn.ts).
      if (isDrawingModel(model)) {
        failureStatus = 429;
        releaseLimit = this.limiter?.acquire();
        failureStatus = 502;
        httpStatus = await this.drawTurn(request, res, {
          provider,
          apiKey,
          threadId,
          signal: controller.signal,
          onUsage: (usage) => {
            upstreamUsage = usage;
          },
        });
        res.end();
        return;
      }
      if (protocol === "chat" && request.stream === false)
        throw new Error("The Chat compatibility bridge requires stream: true.");
      const rewritten = this.rewrite(request, protocol);
      const { body, mapping } =
        protocol === "chat"
          ? toChat(rewritten)
          : { body: rewritten, mapping: new Map() };
      failureStatus = 429;
      releaseLimit = this.limiter?.acquire();
      failureStatus = 502;

      const upstream = await fetch(
        endpoint(
          provider.baseUrl,
          protocol === "chat" ? "chat/completions" : "responses",
        ),
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            // This build's version, platform and architecture, only for the
            // Claudex service and never with the device id.
            ...(provider.backend === "sub2api"
              ? claudexHeaders(claudexClientInfo())
              : {}),
            ...(provider.backend === "sub2api" ? sessionHeader(threadId) : {}),
            ...(provider.backend === "sub2api" && threadId
              ? productHeader(this.threadProducts.get(threadId))
              : {}),
            ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        },
      );
      httpStatus = upstream.status;
      if (!upstream.ok) {
        const text = redact(await upstream.text(), apiKey);
        const detail = text.slice(0, 4000);
        // The whole body (bounded), so a `claudex` object after other fields is still read.
        const refusal =
          provider.backend === "sub2api"
            ? describeSub2ApiRefusal(
                upstream.status,
                text.slice(0, maxRefusalBodyChars),
                undefined,
                upstream.headers.get("x-client-request-id"),
              )
            : undefined;
        if (refusal) {
          this.onRefusal?.(refusal);
          res
            .writeHead(upstream.status, { "Content-Type": "application/json" })
            .end(
              JSON.stringify({
                error: { message: refusal.message, code: refusal.code },
              }),
            );
          return;
        }
        res
          .writeHead(upstream.status, { "Content-Type": "application/json" })
          .end(
            JSON.stringify({
              error: {
                message: `The model service returned HTTP ${upstream.status}: ${detail}`,
              },
            }),
          );
        return;
      }
      res.writeHead(upstream.status, {
        "Content-Type":
          protocol === "chat"
            ? "text/event-stream"
            : (upstream.headers.get("content-type") ?? "text/event-stream"),
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      const onUsage = (usage: Json) => {
        upstreamUsage = usage;
      };
      if (protocol === "chat")
        await streamChatResponse(
          upstream,
          (event) => {
            if (event.response) lastResponse = event.response;
            nextSequence = event.sequence_number + 1;
            if (!res.destroyed) res.write(sseFrame(event));
            this.observe(event, threadId);
          },
          mapping,
          request.model,
          onUsage,
          (event) => this.observe(event, threadId),
        );
      else
        await this.forwardResponses(
          upstream,
          res,
          threadId,
          onUsage,
          provider.backend === "sub2api",
        );
      res.end();
    } catch (error) {
      httpStatus = failureStatus;
      if (!res.destroyed && !res.writableEnded) {
        const message = redact(
          error instanceof Error ? error.message : String(error),
          apiKey,
        );
        // Once streaming has begun, the failure must arrive as a stream event.
        if (res.headersSent)
          res.end(
            sseFrame({
              type: "response.failed",
              sequence_number: nextSequence,
              response: {
                ...lastResponse,
                status: "failed",
                error: { code: "bridge_error", message },
              },
            }),
          );
        else
          res
            .writeHead(failureStatus, { "Content-Type": "application/json" })
            .end(JSON.stringify({ error: { message } }));
      }
    } finally {
      releaseLimit?.();
      if (providerId && this.recordUsage) {
        try {
          this.recordUsage({
            id: randomUUID(),
            at: startedAt,
            providerId,
            model,
            protocol,
            durationMs: Math.max(0, Date.now() - startedAt),
            statusCode: httpStatus,
            ...usageCounters(upstreamUsage),
          });
        } catch (error) {
          console.error(
            "Usage record could not be saved:",
            error instanceof Error ? error.message : String(error),
          );
        }
      }
      clearTimeout(timeout);
      if (threadId) this.untrackThread(threadId, controller);
    }
  }
  async start() {
    if (this.server?.listening) return this.url;
    this.server = http.createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(0, "127.0.0.1", () => resolve());
    });
    const address = this.server.address() as any;
    this.url = `http://127.0.0.1:${address.port}/v1`;
    return this.url;
  }
  async close() {
    if (this.server) {
      this.server.closeAllConnections();
      await new Promise<void>((r) => this.server!.close(() => r()));
      this.server = undefined;
    }
  }
}

export interface Gateway {
}

export interface Gateway {
  observeDrawnImages: OmitThisParameter<
    typeof gatewayImages.observeDrawnImages
  >;
  drawTurn: OmitThisParameter<typeof gatewayImages.drawTurn>;
  handleImages: OmitThisParameter<typeof gatewayImages.handleImages>;
}
installMethods(Gateway.prototype, gatewayImages);

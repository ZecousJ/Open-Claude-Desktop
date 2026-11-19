import http from "node:http";
import { randomBytes } from "node:crypto";
import type { Provider } from "../../shared/types";
import { describeSub2ApiRefusal } from "../../server/sub2api-errors";
import { claudexHeaders } from "../../shared/claudex-contract";
import { claudexClientInfo } from "../sub2api/http";
import { routeForAutomaticImages } from "../../shared/provider-routes";
import {
  drawingPrompt,
  drawingRequest,
  drawnImage,
  imageFormat,
} from "../../server/drawing-turn";
import { endpoint } from "./gateway-chat";
import type { Gateway } from "./gateway";
import {
  maxRefusalBodyChars,
  Json,
  maxImageRequestBytes,
  imageTimeoutMs,
  redact,
  sseFrame,
  readBody,
} from "./gateway-support";

type ImageRoute = ReturnType<typeof drawingRequest>["route"];

function imageEndpoint(provider: Provider, route: ImageRoute) {
  return endpoint(
    provider.baseUrl,
    provider.backend === "sub2api" ? `claudex/${route}` : route,
  );
}

/** The pictures an image endpoint answered with, to the observers. */
export function observeDrawnImages(this: Gateway, text: string, requestId?: string) {
  try {
    const reply = JSON.parse(text) as Json;
    for (const entry of Array.isArray(reply?.data) ? reply.data : []) {
      const base64 = typeof entry?.b64_json === "string" ? entry.b64_json : "";
      if (!base64) continue;
      this.observe(
        {
          type: "response.output_item.done",
          item: {
            type: "image_generation_call",
            id: `ig_${randomBytes(12).toString("hex")}`,
            status: "completed",
            result: base64,
            output_format: imageFormat(base64),
            ...(typeof entry.revised_prompt === "string"
              ? { revised_prompt: entry.revised_prompt }
              : {}),
          },
        },
        undefined,
        undefined,
        requestId,
      );
    }
  } catch {
    /* Not JSON: the answer went through as it came. */
  }
}

/**
 * Answers a picture model's turn with one picture: the person's latest
 * message goes to the image endpoint with the key of the model's group,
 * and Codex gets an `image_generation_call`. The picture itself goes to
 * the main process (saved and shown as the turn's Image card, as an
 * upstream image tool's); the item Codex keeps leaves it out, so its
 * history stays small. Returns the image endpoint's status.
 */
export async function drawTurn(
  this: Gateway,
  request: Json,
  res: http.ServerResponse,
  ctx: {
    provider: Provider;
    apiKey: string;
    threadId?: string;
    turnId?: string;
    signal: AbortSignal;
    onUsage: (usage: Json) => void;
  },
): Promise<number> {
  const { provider, apiKey, threadId, turnId, signal } = ctx;
  const imageRequest = turnId ? undefined : this.startImageRequest(threadId);
  const model = String(request.model);
  const response = {
    id: `resp_${randomBytes(12).toString("hex")}`,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    model,
    output: [] as Json[],
  };
  let sequence = 0;
  const send = (event: Json) => {
    if (!res.destroyed)
      res.write(sseFrame({ ...event, sequence_number: sequence++ }));
  };
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  send({
    type: "response.created",
    response: { ...response, status: "in_progress" },
  });
  // A picture can take minutes: comments keep the stream alive.
  const keepalive = setInterval(() => {
    if (!res.destroyed) res.write(": keepalive\n\n");
  }, 15_000);
  let status = 502;
  try {
    const { prompt, images } = drawingPrompt(request);
    if (!prompt) {
      status = 400;
      throw new Error("Describe the picture you want.");
    }
    const call = drawingRequest(model, prompt, images);
    const upstream = await fetch(imageEndpoint(provider, call.route), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(provider.backend === "sub2api"
          ? claudexHeaders(claudexClientInfo())
          : {}),
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify(call.body),
      signal,
    });
    status = upstream.status;
    const text = await upstream.text();
    if (!upstream.ok) {
      const refusal =
        provider.backend === "sub2api"
          ? describeSub2ApiRefusal(
              upstream.status,
              text.slice(0, maxRefusalBodyChars),
              undefined,
              upstream.headers.get("x-client-request-id"),
            )
          : undefined;
      if (refusal) this.onRefusal?.(refusal);
      throw new Error(
        refusal?.message ??
          `The image service returned HTTP ${upstream.status}: ${redact(text, apiKey).slice(0, 2000)}`,
      );
    }
    const reply = JSON.parse(text) as Json;
    const picture = drawnImage(reply);
    let base64 = picture?.base64;
    if (!base64 && picture?.url) {
      const file = await fetch(picture.url, { signal });
      if (file.ok)
        base64 = Buffer.from(await file.arrayBuffer()).toString("base64");
    }
    if (!base64) throw new Error("The image service returned no picture.");
    if (reply.usage && typeof reply.usage === "object")
      ctx.onUsage(reply.usage);
    const item = {
      type: "image_generation_call",
      id: `ig_${randomBytes(12).toString("hex")}`,
      status: "completed",
      output_format: imageFormat(base64),
      ...(picture?.revisedPrompt
        ? { revised_prompt: picture.revisedPrompt }
        : {}),
    };
    this.observe(
      {
        type: "response.output_item.done",
        output_index: 0,
        item: { ...item, result: base64 },
      },
      threadId,
      turnId,
      imageRequest?.id,
    );
    const kept = { ...item, result: "" };
    send({ type: "response.output_item.done", output_index: 0, item: kept });
    send({
      type: "response.completed",
      response: {
        ...response,
        status: "completed",
        output: [kept],
        usage: {
          input_tokens: 0,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens: 0,
          output_tokens_details: { reasoning_tokens: 0 },
          total_tokens: 0,
        },
      },
    });
    return status;
  } catch (error) {
    send({
      type: "response.failed",
      response: {
        ...response,
        status: "failed",
        error: {
          code: "image_error",
          message: redact(
            error instanceof Error ? error.message : String(error),
            apiKey,
          ),
        },
      },
    });
    return status >= 400 ? status : 502;
  } finally {
    clearInterval(keepalive);
    imageRequest?.finish();
  }
}

export async function handleImages(
  this: Gateway,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  route: ImageRoute,
) {
  const imageRequest = this.startImageRequest();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), imageTimeoutMs);
  res.on("close", () => controller.abort());
  let apiKey = "";
  try {
    const raw = await readBody(req, maxImageRequestBytes);
    if (!raw) {
      res.writeHead(413, { "Content-Type": "application/json" }).end(
        JSON.stringify({
          error: { message: "The request is larger than 64 MB." },
        }),
      );
      return;
    }
    const current = this.getProvider();
    const { provider } = current;
    apiKey = current.apiKey;
    const body = new Uint8Array(raw);
    const contentType = req.headers["content-type"] ?? "application/json";
    const imageRoute =
      provider.backend === "sub2api" ? routeForAutomaticImages(provider) : undefined;
    if (imageRoute && !imageRoute.primary)
      apiKey = current.keyFor?.(imageRoute.keyId) || apiKey;
    const upstream = await fetch(imageEndpoint(provider, route), {
      method: "POST",
      headers: {
        ...(contentType ? { "Content-Type": contentType } : {}),
        ...(provider.backend === "sub2api"
          ? claudexHeaders(claudexClientInfo())
          : {}),
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body,
      signal: controller.signal,
    });
    const text = redact(await upstream.text(), apiKey);
    res
      .writeHead(upstream.status, {
        "Content-Type":
          upstream.headers.get("content-type") ?? "application/json",
      })
      .end(text);
    // Each picture is also the turn's Image card, whether or not the agent
    // opens the file it saves (owner, 2026-10-03: the third was never
    // shown). The running turn takes it (the request names no thread).
    if (upstream.ok) this.observeDrawnImages(text, imageRequest?.id);
  } catch (error) {
    if (!res.headersSent)
      res.writeHead(502, { "Content-Type": "application/json" }).end(
        JSON.stringify({
          error: {
            message: redact(
              error instanceof Error ? error.message : String(error),
              apiKey,
            ),
          },
        }),
      );
  } finally {
    clearTimeout(timeout);
    imageRequest?.finish();
  }
}

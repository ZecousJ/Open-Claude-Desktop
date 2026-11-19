import http from "node:http";

/**
 * The Claudex service adds its `claudex` object to error bodies of up to
 * 64 KB (design 2.7), so a rewritten body can be somewhat larger than that;
 * larger ones are not refusals.
 */
export const maxRefusalBodyChars = 128 * 1024;

export type Json = Record<string, any>;

export async function* readSSE(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<Json> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let data: string[] = [];
  let frameSize = 0;
  const maxSize = 32 * 1024 * 1024;
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      // Parse complete lines before normalizing them: CR and LF may arrive in
      // different network chunks, as may individual UTF-8 bytes.
      while (buffer.length) {
        const end = buffer.search(/[\r\n]/);
        if (end === -1 && !done) break;
        if (end === buffer.length - 1 && buffer[end] === "\r" && !done) break;
        const line = end === -1 ? buffer : buffer.slice(0, end);
        const width =
          end !== -1 && buffer[end] === "\r" && buffer[end + 1] === "\n"
            ? 2
            : 1;
        buffer = end === -1 ? "" : buffer.slice(end + width);
        frameSize += line.length;
        if (frameSize > maxSize)
          throw new Error("The server sent an oversized event.");
        if (line === "") {
          const payload = data.join("\n");
          data = [];
          frameSize = 0;
          if (payload === "[DONE]") return;
          if (payload) yield JSON.parse(payload);
        } else if (line.startsWith("data:")) {
          const value = line.slice(5);
          data.push(value.startsWith(" ") ? value.slice(1) : value);
        }
      }
      if (buffer.length + frameSize > maxSize)
        throw new Error("The server sent an oversized event.");
      if (done) {
        const payload = data.join("\n");
        if (payload && payload !== "[DONE]") yield JSON.parse(payload);
        return;
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** Reference images and masks ride in the body of an image edit. */
export const maxImageRequestBytes = 64 * 1024 * 1024;

/** A picture can take minutes. */
export const imageTimeoutMs = 15 * 60_000;

/** A knowledge-base MCP request (shared/knowledge-api.ts). */
export const knowledgeTimeoutMs = 2 * 60_000;

export const maxKnowledgeBytes = 1024 * 1024;

export const knowledgeRequestHeaders = [
  "content-type",
  "accept",
  "mcp-session-id",
  "mcp-protocol-version",
  "last-event-id",
];

export const knowledgeResponseHeaders = [
  "content-type",
  "mcp-session-id",
  "mcp-protocol-version",
  "cache-control",
];

export function redact(text: string, secret: string) {
  return secret ? text.split(secret).join("[redacted]") : text;
}

export function sseFrame(event: Json) {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

/** Reads the whole body, or returns undefined as soon as it exceeds the limit. */
export async function readBody(req: http.IncomingMessage, limit: number) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) return undefined;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

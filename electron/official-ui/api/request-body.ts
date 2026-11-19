import type { IncomingMessage } from "node:http";

export class RequestBodyError extends Error {
  constructor(
    readonly status: 400 | 413,
    message: string,
  ) {
    super(message);
  }
}
/** Transport cap; callers retain their independent content/type policies. */
export function readBoundedBytes(
  req: IncomingMessage,
  maxBytes: number,
): Promise<Buffer> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1)
    throw Error("Invalid body bound.");
  return new Promise((resolve, reject) => {
    let chunks: Buffer[] = [],
      bytes = 0,
      settled = false;
    const clean = () => {
      req.removeListener("data", data);
      req.removeListener("end", end);
      req.removeListener("error", error);
      req.removeListener("aborted", aborted);
      req.removeListener("close", close);
    };
    const fail = (status: 400 | 413, message: string) => {
      chunks = [];
      if (!settled) {
        settled = true;
        reject(new RequestBodyError(status, message));
      }
    };
    const data = (chunk: Buffer | string) => {
      if (settled) return; // Drain without retaining an oversized body; do not destroy a shared socket.
      const size =
        typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.byteLength;
      if (size > maxBytes - bytes) {
        fail(413, "Request body is too large.");
        return;
      }
      bytes += size;
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    };
    const end = () => {
      clean();
      if (settled) return;
      const value = Buffer.concat(chunks, bytes);
      chunks = [];
      settled = true;
      resolve(value);
    };
    const error = () => {
      fail(400, "The request body could not be read.");
      clean();
    };
    const aborted = () => {
      fail(400, "The request was aborted.");
      clean();
    };
    const close = () => {
      if (!settled)
        fail(400, "The request ended before its body was complete.");
      clean();
    };
    req.on("data", data);
    req.on("end", end);
    req.on("error", error);
    req.on("aborted", aborted);
    req.on("close", close);
    const length = req.headers?.["content-length"];
    if (
      typeof length === "string" &&
      /^[0-9]+$/.test(length) &&
      Number(length) > maxBytes
    )
      fail(413, "Request body is too large.");
    if (req.aborted) aborted();
  });
}

/** JSON profile callers require an object, never null or an array. */
export async function readBoundedJson(
  req: IncomingMessage,
  maxBytes: number,
): Promise<Record<string, unknown>> {
  const bytes = await readBoundedBytes(req, maxBytes);
  try {
    const value: unknown = bytes.length
      ? JSON.parse(bytes.toString("utf8"))
      : {};
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw Error();
    return value as Record<string, unknown>;
  } catch {
    throw new RequestBodyError(400, "Choose a valid JSON object.");
  }
}

import { open } from "node:fs/promises";
import type http from "node:http";
import { pipeline } from "node:stream/promises";
import { z } from "zod";
import type { AdapterContext } from "./context";

export const codeFilePreviewPath = "/api/code-file-preview";

const previewRequest = z.object({
  kind: z.enum(["image", "media"]),
  sessionId: z.string().min(1).max(200),
  path: z.string().min(1).max(4096).refine((value) => !value.includes("\0")),
});
const previewFile = z.object({
  status: z.literal("ok"),
  path: z.string(),
  mimeType: z.string(),
});

function byteRange(value: string | undefined, size: number) {
  const match = value?.trim().match(/^bytes=(\d*)-(\d*)$/);
  if (!match || (!match[1] && !match[2])) return null;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix === 0 || size === 0)
      return "unsatisfiable";
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(match[1]);
  if (!Number.isSafeInteger(start) || start >= size) return "unsatisfiable";
  const end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  return Number.isSafeInteger(end) && end >= start ? { start, end } : null;
}

export async function codeFilePreviewRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: AdapterContext,
) {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname !== codeFilePreviewPath) return false;
  const end = (status: number, headers?: http.OutgoingHttpHeaders) => {
    res.writeHead(status, { "Cache-Control": "no-store", ...headers });
    res.end();
    return true;
  };
  if (req.method !== "GET" && req.method !== "HEAD") return end(405);
  const input = previewRequest.safeParse(Object.fromEntries(url.searchParams));
  if (!input.success) return end(400);
  const { kind, sessionId, path } = input.data;
  const result = await ctx.localCall?.("officialSessionFile", {
    operation: kind === "image" ? "streamImage" : "streamMedia",
    sessionId,
    path,
  }).catch(() => null);
  const preview = previewFile.safeParse(result);
  if (!preview.success) return end(404);
  const file = await open(preview.data.path, "r").catch(() => null);
  if (!file) return end(404);
  try {
    const stat = await file.stat();
    if (!stat.isFile()) return end(404);
    const range = byteRange(req.headers.range, stat.size);
    const headers: http.OutgoingHttpHeaders = {
      "Content-Type": preview.data.mimeType,
      "Accept-Ranges": "bytes",
      "Cache-Control": "no-store",
    };
    if (range === "unsatisfiable")
      return end(416, { ...headers, "Content-Range": `bytes */${stat.size}` });
    const start = range?.start ?? 0;
    const endByte = range?.end ?? stat.size - 1;
    headers["Content-Length"] = endByte - start + 1;
    if (range) headers["Content-Range"] = `bytes ${start}-${endByte}/${stat.size}`;
    const status = range ? 206 : 200;
    if (req.method === "HEAD" || !stat.size) return end(status, headers);
    res.writeHead(status, headers);
    await pipeline(file.createReadStream({ start, end: endByte, autoClose: false }), res);
    return true;
  } catch (error) {
    if (!res.destroyed) throw error;
    return true;
  } finally {
    await file.close();
  }
}

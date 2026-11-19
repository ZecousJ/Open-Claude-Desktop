import { randomBytes } from "node:crypto";
import { documentPreviewTokenHeader } from "../../shared/official-ui-web";

export const documentPreviewMaxBytes = 8_000_000;
export const nativeDocumentPreviewMaxBytes = 25 * 1024 * 1024;
const extensions: Record<string, string> = {
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
    "docx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation":
    "pptx",
};

export function createDocumentPreviewTokens<T = undefined>(
  currentSession: () => unknown,
) {
  const tokens = new Map<
    string,
    { session: unknown; expires: number; value?: T }
  >();
  const authorized = (token: string) => {
    const entry = tokens.get(token);
    return entry &&
      entry.expires > Date.now() &&
      entry.session === currentSession()
      ? entry
      : undefined;
  };
  return {
    issueToken(value?: T) {
      const session = currentSession();
      if (!session) throw Error("Sign in to preview documents.");
      for (const [key, entry] of tokens)
        if (entry.expires <= Date.now() || entry.session !== session)
          tokens.delete(key);
      if (tokens.size >= 128) tokens.delete(tokens.keys().next().value!);
      const token = randomBytes(32).toString("hex");
      tokens.set(token, { session, expires: Date.now() + 120_000, value });
      return token;
    },
    accepts: (token: string) => !!authorized(token),
    value: (token: string) => authorized(token)?.value,
  };
}

/** Official /api/convert-pdf contract. Only the local Office runtime reads document bytes. */
export function createDocumentPreviewHandler(options: {
  maxBytes?: number;
  authorize(token: string, signal: AbortSignal): boolean | Promise<boolean>;
  convert(
    data: Buffer,
    extension: string,
    signal: AbortSignal,
  ): Promise<Buffer>;
}) {
  const maxBytes = options.maxBytes ?? documentPreviewMaxBytes;
  let active = 0;
  const error = (status: number, message: string) =>
    Response.json(
      { error: message },
      { status, headers: { "Cache-Control": "no-store" } },
    );
  return {
    async handle(request: Request): Promise<Response> {
      if (request.method !== "POST") return error(405, "method_not_allowed");
      const token = request.headers.get(documentPreviewTokenHeader) ?? "";
      const authorized = () => options.authorize(token, request.signal);
      if (!(await authorized())) return error(401, "unauthorized");
      const extension =
        extensions[
          (request.headers.get("content-type") ?? "")
            .split(";", 1)[0]
            .trim()
            .toLowerCase()
        ];
      if (!extension) return error(415, "unsupported_format");
      if (active >= 2) return error(429, "converter_busy");
      if (
        Number(request.headers.get("content-length")) > maxBytes
      )
        return error(413, "file_too_large");
      active++;
      try {
        const reader = request.body?.getReader();
        if (!reader) return error(400, "empty_document");
        let size = 0;
        const chunks: Uint8Array[] = [];
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > maxBytes) {
              await reader.cancel();
              return error(413, "file_too_large");
            }
            chunks.push(value);
          }
        } finally {
          reader.releaseLock();
        }
        const data = Buffer.concat(chunks);
        if (data.length < 4 || data.readUInt32LE(0) !== 0x04034b50)
          return error(422, "invalid_document");
        if (!(await authorized())) return error(401, "unauthorized");
        const start = performance.now();
        const pdf = await options.convert(data, extension, request.signal);
        if (!(await authorized())) return error(401, "unauthorized");
        if (pdf.subarray(0, 5).toString() !== "%PDF-")
          return error(422, "conversion_failed");
        return new Response(new Uint8Array(pdf), {
          headers: {
            "Content-Type": "application/pdf",
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
            "Server-Timing":
              "converter;dur=" + Math.round(performance.now() - start),
          },
        });
      } catch (e) {
        return error(request.signal.aborted ? 499 : 422, "conversion_failed");
      } finally {
        active--;
      }
    },
  };
}

export function createDocumentPreviewService(options: {
  maxBytes?: number;
  currentSession(): unknown;
  convert(
    data: Buffer,
    extension: string,
    signal: AbortSignal,
  ): Promise<Buffer>;
}) {
  const tokens = createDocumentPreviewTokens(options.currentSession);
  return {
    issueToken: tokens.issueToken,
    ...createDocumentPreviewHandler({
      maxBytes: options.maxBytes,
      authorize: tokens.accepts,
      convert: options.convert,
    }),
  };
}

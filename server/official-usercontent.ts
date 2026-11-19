import http from "node:http";
import { once } from "node:events";
import { Readable } from "node:stream";
import { createUserContentHandler } from "../electron/official-ui/usercontent";
import { createDocumentPreviewHandler } from "../electron/official-ui/document-preview";
import { convertOfficeDocument } from "../electron/workspace/office-conversion";
import { codePreviewHost, serveCodePreview } from "./official-code-preview";
import {
  documentPreviewTokenHeader,
  documentPreviewTokenVerificationPath,
} from "../shared/official-ui-web";

/** Official viewer resources and document conversion on a separate hostname. */
export async function startOfficialUserContentServer(options: {
  root: string;
  parentOrigin: string;
  publicOrigin?: string;
  host?: string;
  port?: number;
  documentRuntime?: string;
}) {
  let origin = "";
  let handle: ReturnType<typeof createUserContentHandler>;
  const runtime = options.documentRuntime;
  const convert =
    runtime &&
    createDocumentPreviewHandler({
      async authorize(token, signal) {
        if (!/^[1-9][0-9]{0,15}\.[0-9a-f]{64}$/.test(token)) return false;
        try {
          const result = await fetch(
            new URL(documentPreviewTokenVerificationPath, options.parentOrigin),
            {
              method: "POST",
              headers: { [documentPreviewTokenHeader]: token },
              redirect: "error",
              signal: AbortSignal.any([signal, AbortSignal.timeout(4_000)]),
            },
          );
          return result.status === 204;
        } catch {
          return false;
        }
      },
      convert: (data, extension, signal) =>
        convertOfficeDocument({ runtime, data, extension, output: "pdf", signal }),
    });
  const server = http.createServer(async (request, response) => {
    try {
      const preview = codePreviewHost(request, origin);
      if (preview) {
        await serveCodePreview(request, response, preview, options.parentOrigin);
        return;
      }
      const url = new URL(request.url ?? "/", origin);
      let result: Response;
      if (convert && url.pathname === "/api/convert-pdf") {
        if (
          url.origin !== origin ||
          url.search ||
          request.headers.cookie ||
          request.headers.authorization ||
          (request.headers.origin && request.headers.origin !== origin)
        ) {
          response.writeHead(403, { "Cache-Control": "no-store" }).end();
          return;
        }
        const abort = new AbortController();
        response.on("close", () => abort.abort());
        const headers = new Headers();
        for (const name of [
          documentPreviewTokenHeader,
          "content-type",
          "content-length",
        ]) {
          const value = request.headers[name];
          if (typeof value === "string") headers.set(name, value);
        }
        const body =
          request.method === "POST"
            ? (Readable.toWeb(request) as ReadableStream<Uint8Array>)
            : undefined;
        const init = {
          method: request.method,
          headers,
          signal: abort.signal,
          body,
          duplex: "half",
        };
        result = await convert.handle(new Request(url, init));
      } else {
        result = handle(new Request(url, { method: request.method }));
      }
      response.writeHead(result.status, Object.fromEntries(result.headers));
      response.end(Buffer.from(await result.arrayBuffer()));
    } catch {
      response.writeHead(503, {
        "Content-Type": "text/plain",
        "Cache-Control": "no-store",
      });
      response.end("Preview resources are unavailable.");
    }
  });
  server.listen(options.port ?? 0, options.host ?? "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string")
    throw Error("Missing preview listener address.");
  origin = options.publicOrigin ?? `http://localhost:${address.port}`;
  try {
    handle = createUserContentHandler(
      options.root,
      options.parentOrigin,
      origin,
    );
  } catch (error) {
    server.close();
    throw error;
  }
  return {
    origin,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeIdleConnections();
      }),
  };
}

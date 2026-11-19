import { encodeWireValue, decodeWireValue } from "../../shared/web-wire";
import { createIsolatedWebUserContent } from "../../runner/src/official-usercontent-host";
import { officialUserContentOrigin } from "../../shared/official-usercontent-origin";
import { convertOfficeDocument } from "../../electron/workspace/office-conversion";
import { Readable } from "node:stream";
import { deriveOfficialWebAccountModule } from "../../scripts/official-web-account-context.mjs";
/** Local-only original UI fixture, actual adapter/Store/snapshot bytes; no real account/model. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { createApiAdapter } from "../../electron/official-ui/api/index";
import {
  createGeneratedOutputFixture,
  outputConversationId,
} from "../support/generated-output-fixture";
const root =
  process.env.CLAUDEX_F019_FIXTURE_ROOT ??
  fs.mkdtempSync(path.join(os.tmpdir(), "claudex-f019-ui-"));
const fixture = await createGeneratedOutputFixture(
  root,
  process.env.CLAUDEX_F019_DOCUMENTS === "1",
);
const resources = path.resolve(process.env.CLAUDEX_F019_RESOURCES ?? "build");
fixture.ctx.root = path.join(resources, "official-ui");
const runner =
  process.env.CLAUDEX_F019_TRANSPORT === "runner"
    ? (
        await import("../support/generated-output-runner")
      ).generatedOutputRunner(fixture)
    : undefined;
const adapter = createApiAdapter(fixture.ctx, {
  scoped: true,
  timelineWaitMs: 0,
});
const ui = path.join(resources, "official-ui/ui");
const html = fs.readFileSync(path.join(ui, "index.html"), "utf8");
const types: Record<string, string> = {
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".wasm": "application/wasm",
};
let previewOrigin: string | undefined,
  previewHost: ReturnType<typeof createIsolatedWebUserContent> | undefined;
const previewServer = http.createServer(async (req, res) => {
  if (!previewHost) {
    res.writeHead(503).end();
    return;
  }
  const response = await previewHost.handle(
    new Request(previewOrigin + (req.url ?? "/"), {
      method: req.method,
      ...(!["GET", "HEAD"].includes(req.method ?? "GET")
        ? {
            body: Readable.toWeb(req) as ReadableStream<Uint8Array>,
            duplex: "half",
          }
        : {}),
      headers: Object.fromEntries(
        Object.entries(req.headers).filter(
          (v): v is [string, string] => typeof v[1] === "string",
        ),
      ),
    }),
  );
  res.writeHead(response.status, Object.fromEntries(response.headers));
  if (response.body) Readable.fromWeb(response.body as any).pipe(res);
  else res.end();
});
const webBatchModules = new Set([
  "/assets/v1/ce5658dc8-DnpnXkcR.js",
  "/assets/v1/shared-6-abVJ5RR0.js",
  "/assets/v1/shared-40-nCKOLypK.js",
  "/assets/v1/shared-120-CuvT_xum.js",
]);
const events: { path: string; status: number }[] = [];
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (
    process.env.CLAUDEX_F019_REQUIRE_DOWNLOAD_COOKIE === "1" &&
    /\/files\/[^/]+\/contents$/.test(url.pathname) &&
    !(req.headers.cookie ?? "")
      .split(";")
      .some(
        (value) =>
          value.trim() === "claudex_official_ui=f019-native-acceptance",
      )
  ) {
    res.writeHead(401).end();
    return;
  }
  res.once("finish", () => {
    if (
      url.pathname.startsWith("/api") ||
      url.pathname.startsWith("/claudeai-rpc")
    ) {
      events.push({ path: url.pathname, status: res.statusCode });
      console.log("request", req.method, url.pathname, res.statusCode);
    }
  });
  try {
    if (url.pathname === "/__f019/official-read" && runner) {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 256 * 1024) {
          res.writeHead(413).end();
          return;
        }
        chunks.push(chunk);
      }
      const response = await runner.read(
        decodeWireValue(JSON.parse(Buffer.concat(chunks).toString())),
      );
      res
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify(encodeWireValue(response)));
      return;
    }
    if (url.pathname === "/official-preview-unavailable.html") {
      res
        .writeHead(200, { "content-type": "text/html" })
        .end(
          fs.readFileSync(
            path.resolve("public/official-preview-unavailable.html"),
          ),
        );
      return;
    }
    if (url.pathname === "/app.js" && runner) {
      res
        .writeHead(200, { "content-type": "text/javascript" })
        .end(fs.readFileSync(process.env.CLAUDEX_F019_WEB_ENTRY!));
      return;
    }
    if (url.pathname === "/app.js") {
      res.writeHead(200, { "content-type": "text/javascript" });
      res.end(
        (previewOrigin
          ? 'Object.defineProperty(window,"__claudexOfficialUserContentOrigin",{value:' +
            JSON.stringify(previewOrigin) +
            ",writable:false});"
          : "") + 'import("/assets/v1/index-BJJTYFi2.js");',
      );
      return;
    }
    if (
      url.pathname.startsWith("/api/") ||
      url.pathname.startsWith("/edge-api/") ||
      url.pathname.startsWith("/claudeai-rpc/")
    ) {
      if (await adapter(req, res)) return;
      res.writeHead(404).end();
      return;
    }
    const file = path.resolve(ui, "." + decodeURIComponent(url.pathname));
    if (!file.startsWith(ui + path.sep) && file !== ui) {
      res.writeHead(404).end();
      return;
    }
    if (fs.existsSync(file) && fs.statSync(file).isFile()) {
      res.writeHead(200, {
        "content-type": types[path.extname(file)] ?? "application/octet-stream",
      });
      if (runner && webBatchModules.has(url.pathname)) {
        const bytes = fs.readFileSync(file);
        res.end(deriveOfficialWebAccountModule(url.pathname.slice(1), bytes) ?? bytes);
      } else {
        fs.createReadStream(file).pipe(res);
      }
      return;
    }
    if (
      url.pathname === "/" ||
      url.pathname.startsWith("/chat/") ||
      url.pathname === "/new"
    ) {
      res
        .writeHead(200, { "content-type": "text/html" })
        .end(
          previewOrigin
            ? html.replace(
                "</head>",
                '<meta name="f019-preview-origin" content="' +
                  previewOrigin +
                  '"></head>',
              )
            : html,
        );
      return;
    }
    res.writeHead(404).end();
  } catch (error) {
    console.error(
      "fixture error",
      url.pathname,
      error instanceof Error ? error.message : "unknown",
    );
    if (!res.headersSent) res.writeHead(500);
    res.end();
  }
});
server.listen(Number(process.env.CLAUDEX_F019_PORT ?? 0), "127.0.0.1", () => {
  const port = (server.address() as any).port,
    parentOrigin = `http://127.0.0.1:${port}`;
  const ready = () =>
    console.log(
      JSON.stringify({
        url: `${parentOrigin}/chat/${outputConversationId}`,
        root,
        previewOrigin,
      }),
    );
  if (process.env.CLAUDEX_F019_WEB_PREVIEW !== "1") {
    ready();
    return;
  }
  previewServer.listen(
    Number(process.env.CLAUDEX_F019_PREVIEW_PORT ?? 0),
    "127.0.0.1",
    () => {
      previewOrigin = officialUserContentOrigin(
        `http://localhost:${(previewServer.address() as any).port}`,
        parentOrigin,
      );
      if (!previewOrigin) throw Error("Invalid preview origin");
      const contentRoot = path.join(resources, "official-usercontent"),
        manifest = JSON.parse(
          fs.readFileSync(path.join(contentRoot, "manifest.json"), "utf8"),
        );
      const allowed = new Set([
        "text/html",
        "text/javascript",
        "text/css",
        "font/woff2",
        "font/woff",
        "font/ttf",
        "font/otf",
        "application/wasm",
      ]);
      const contentTypes = {
        ...types,
        ".html": "text/html",
        ".mjs": "text/javascript",
        ".ttf": "font/ttf",
        ".otf": "font/otf",
      };
      const assets = manifest.assets.flatMap((a: any) => {
        const contentType = (contentTypes as any)[path.extname(a.file)];
        return allowed.has(contentType)
          ? [
              {
                path: a.path,
                sha256: a.sha256,
                bytes: fs.readFileSync(path.join(contentRoot, a.file)),
                contentType,
              },
            ]
          : [];
      });
      previewHost = createIsolatedWebUserContent({
        parentOrigin,
        previewOrigin,
        identity: { account: "f019-owner", session: "fixture" },
        currentIdentity: () => ({ account: "f019-owner", session: "fixture" }),
        assets,
        convertDocument: process.env.CLAUDEX_F019_DOCUMENT_RUNTIME
          ? (data, extension, signal) =>
              convertOfficeDocument({
                runtime: process.env.CLAUDEX_F019_DOCUMENT_RUNTIME!,
                data, extension, output: "pdf", signal,
              })
          : undefined,
      });
      fixture.ctx.documentPreviewToken = () =>
        previewHost!.issueDocumentPreviewToken();
      ready();
    },
  );
});
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    fixture.store.flush();
    fs.writeFileSync(
      path.join(root, "requests.json"),
      JSON.stringify(events, null, 2),
    );
    previewHost?.revoke();
    previewServer.closeAllConnections();
    previewServer.close();
    server.closeAllConnections();
    server.close(() => process.exit(0));
  });

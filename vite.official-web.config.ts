import fs from "node:fs";
import { verifyPackagedBootstrap } from "./scripts/official-ui-bootstrap-defaults.mjs";
import path from "node:path";
import http from "node:http";
import https from "node:https";
import { createHash } from "node:crypto";
// @ts-expect-error Local opt-in development helper is plain ESM.
import { officialWebProxy } from "./scripts/official-web-proxy.mjs";
import { defineConfig, type Plugin } from "vite";
import ts from "typescript";
import web, { devApiOrigin, devRequestCookies, devResponseCookie, webChunkGroups } from "./vite.web.config.ts";
import { deriveOfficialWebAccountModule } from "./scripts/official-web-account-context.mjs";

const officialUi = path.resolve("build/official-ui");
const ui = path.join(officialUi, "ui");
const workspace = JSON.parse(fs.readFileSync(path.join(officialUi, "manifest.json"), "utf8"));
const files: { path: string; content: Buffer; sha256: string }[] = [];
function readAssets(directory: string) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) readAssets(file);
    else if (entry.isFile()) readAsset(file);
  }
}
function readAsset(file: string) {
  const relative = path.relative(ui, file).split(path.sep).join("/");
  const bytes = fs.readFileSync(file);
  const content = Buffer.from(deriveOfficialWebAccountModule(relative, bytes) ?? bytes);
  files.push({ path: relative, content, sha256: createHash("sha256").update(content).digest("hex") });
}
for (const directory of ["assets", "i18n", "images"]) readAssets(path.join(ui, directory));
readAsset(path.join(ui, "official-status-preview.html"));
const originalAssets = {
  entry: "/" + workspace.entry,
  document: fs.readFileSync(path.join(ui, "index.html"), "utf8").replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ""),
  files,
  manifest: { buildId: workspace.buildId, files: files.map(({ content, ...file }) => file) },
};
// Every byte that can change a vendor module participates in its URL namespace.
const vendorVersion = createHash("sha256")
  .update(JSON.stringify(originalAssets.manifest.files))
  .digest("hex").slice(0, 20);
const vendorPrefix = `/assets/official-${vendorVersion}/`;
const versionedSource = (source: string) => source.replaceAll("/assets/v1/", vendorPrefix);
const versionedFiles = originalAssets.files.map(file => {
  const content = file.content;
  const rewritten = /\.(js|css|html|json)$/.test(file.path)
    ? Buffer.from(versionedSource(content.toString("utf8")))
    : content;
  return {
    ...file,
    path: file.path.replace(/^assets\/v1\//, vendorPrefix.slice(1)),
    content: rewritten,
    bytes: rewritten.length,
    sha256: createHash("sha256").update(rewritten).digest("hex"),
  };
});
const verified = {
  ...originalAssets,
  entry: versionedSource(originalAssets.entry),
  document: versionedSource(originalAssets.document),
  files: versionedFiles,
  manifest: {
    ...originalAssets.manifest,
    vendorVersion,
    files: versionedFiles.map(({ content, ...entry }) => entry),
  },
};

function frameModulePreloads() {
  // Discover the eager graph so browser cache validation can run in parallel.
  const modules = new Map(verified.files.map(file => ["/" + file.path, file]));
  const pending = [verified.entry];
  const seen = new Set(pending);
  for (const url of pending) {
    const asset = modules.get(url);
    if (!asset) throw Error("Missing static official Web module: " + url);
    const source = ts.createSourceFile(
      url, asset.content.toString("utf8"), ts.ScriptTarget.Latest,
    );
    for (const statement of source.statements) {
      if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) continue;
      const node = statement.moduleSpecifier;
      if (!node || !ts.isStringLiteral(node)) continue;
      const dependency = new URL(node.text, "https://official.invalid" + url);
      if (dependency.origin !== "https://official.invalid" ||
          !dependency.pathname.endsWith(".js") ||
          !modules.has(dependency.pathname) || seen.has(dependency.pathname)) continue;
      seen.add(dependency.pathname);
      pending.push(dependency.pathname);
    }
  }
  return pending.map(url => `<link vite-ignore rel="modulepreload" href="${url}" />`).join("\n");
}
const framePreloads = frameModulePreloads();
verifyPackagedBootstrap(path.resolve("build/official-ui"));
const bootstrapMessages = JSON.parse(fs.readFileSync("build/official-ui/data/bootstrap-defaults.json", "utf8")).gated_messages.messages;
const bootstrapRevision = createHash("sha256").update(JSON.stringify(bootstrapMessages)).digest("hex");
const bootstrapCatalogPath = `assets/bootstrap-catalog-${bootstrapRevision}.json`;
const bootstrapCatalogSource = JSON.stringify({ revision: bootstrapRevision, messages: bootstrapMessages });


function frameDocument(entry: string) {
  const head = entry.match(/<head>([\s\S]*?)<\/head>/)?.[1];
  const script = head?.match(/<script type="module"[^>]*><\/script>/)?.[0];
  if (!head || !script) throw Error("The official Web frame entry is incomplete.");
  return verified.document
    .replace('<head>', '<head>' + head.replace(script, ''))
    .replace(/<link rel="stylesheet"/g, '<link vite-ignore rel="stylesheet"')
    .replace('</head>', `${framePreloads}\n</head>`)
    .replace('</body>', `${script}\n</body>`);
}
const mime: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".wasm": "application/wasm",
};
function officialAssets(): Plugin {
  return {
    name: "claudex-verified-official-web",
    enforce: "post",
    configResolved(config) {
      if (config.command === "build" && !config.env.VITE_CLAUDEX_OFFICIAL_USERCONTENT_ORIGIN?.trim()) {
        throw Error("Set VITE_CLAUDEX_OFFICIAL_USERCONTENT_ORIGIN to the preview server origin before building official Web.");
      }
    },
    transformIndexHtml: {
      order: "pre",
      handler(html, { filename }) {
        if (path.basename(filename) === "official-frame.html") return frameDocument(html);
        const localeMetadata = verified.document.match(/<meta name="i18n-catalogs"[^>]*>/)?.[0] ?? "";
        return versionedSource(html).replace("<head>", "<head>" + localeMetadata + `<link rel="preload" as="fetch" crossorigin href="/${bootstrapCatalogPath}" data-bootstrap-catalog />`);
      },
    },
    configureServer(server) {
      const files = new Map(verified.files.map((r: any) => ["/" + r.path, r]));
      server.middlewares.use((req, res, next) => {
        const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
        if (req.method === "GET" && pathname === "/official-frame-document.html") {
          res.setHeader("Content-Type", "text/html");
          res.end(verified.document);
          return;
        }
        if (req.method === "GET" && pathname === "/" + bootstrapCatalogPath) {
          res.setHeader("Content-Type", "application/json");
          res.end(bootstrapCatalogSource);
          return;
        }
        const file = files.get(pathname) as { content: Buffer } | undefined;
        if (file && req.method === "GET") {
          res.setHeader(
            "Content-Type",
            mime[path.extname(pathname)] ?? "application/octet-stream",
          );
          res.end(file.content);
          return;
        }
        if (
          req.method === "GET" &&
          (req.headers.accept ?? "").includes("text/html") &&
          !/^\/(?:api|v1|s|admin|@|src|src-web|shared|node_modules|assets|i18n|images)(?:\/|$)/.test(
            pathname,
          ) &&
          (pathname === "/index.html" || !path.posix.extname(pathname))
        )
          req.url = "/official-web.html";
        next();
      });
    },
    generateBundle(_options, bundle) {
      this.emitFile({ type: "asset", fileName: bootstrapCatalogPath, source: bootstrapCatalogSource });
      for (const [key, asset] of Object.entries(bundle)) {
        if (asset.type === "asset" && asset.fileName === "official-web.html") {
          delete bundle[key];
          this.emitFile({
            type: "asset",
            fileName: "index.html",
            source: asset.source,
          });
        }
      }
      const publicOrigin = process.env.CLAUDEX_OFFICIAL_PUBLIC_ORIGIN;
      if (publicOrigin) {
        const origin = new URL(publicOrigin);
        if (origin.protocol !== "https:" || origin.origin !== publicOrigin)
          throw Error("CLAUDEX_OFFICIAL_PUBLIC_ORIGIN must be an HTTPS origin.");
        for (const [surface, redirect] of [
          ["web", origin.origin + "/mcp/oauth/callback"],
          ["desktop", "http://127.0.0.1/callback"],
        ]) {
          const fileName = `mcp/${surface}-client.json`;
          this.emitFile({
            type: "asset", fileName,
            source: JSON.stringify({
              client_id: new URL(fileName, origin).href,
              client_name: "Claudex",
              redirect_uris: [redirect],
              grant_types: ["authorization_code", "refresh_token"],
              response_types: ["code"],
              token_endpoint_auth_method: "none",
            }),
          });
        }
      }
      this.emitFile({
        type: "asset",
        fileName: "official-frame-document.html",
        source: verified.document,
      });
      this.emitFile({
        type: "asset",
        fileName: "official-web-asset-manifest.json",
        source: JSON.stringify(verified.manifest, null, 2),
      });
      for (const file of verified.files)
        this.emitFile({
          type: "asset",
          fileName: file.path,
          source: file.content,
        });
    },
  };
}
const excluded = new Set([
  "claudex-web-dev-entry",
  "claudex-web-entry-as-index",
]);
export default defineConfig({
  ...web,
  server: officialWebProxy(web.server, process.env, { http: http.globalAgent, https: https.globalAgent }, { devApiOrigin, devRequestCookies, devResponseCookie }),
  cacheDir: "node_modules/.vite-official-web",
  plugins: [
    ...(web.plugins ?? []).filter(
      (p) =>
        !p ||
        typeof p !== "object" ||
        !("name" in p) ||
        !excluded.has(String(p.name)),
    ),
    officialAssets(),
  ],
  define: {
    ...web.define,
    __OFFICIAL_ENTRY__: JSON.stringify(verified.entry),
    __OFFICIAL_LOCALE_LOADER__: JSON.stringify(vendorPrefix + "shared-l-p-m-w-5-BDZb5dJN.js"),
  },
  optimizeDeps: { entries: ["official-web.html", "official-frame.html"] },
  build: {
    ...web.build,
    outDir: "dist-web",
    rolldownOptions: {
      ...web.build?.rolldownOptions,
      input: { index: "official-web.html", frame: "official-frame.html" },
      output: {
        codeSplitting: {
          groups: [
            ...webChunkGroups,
            { name: "official-host-startup", test: /[\\/]src-web[\\/]official[\\/]main\.tsx$/, priority: -1, entriesAware: true },
            { name: "official-frame-startup", test: /[\\/]src-web[\\/]official[\\/]frame-entry\.ts$/, priority: -1, entriesAware: true },
          ],
        },
      },
    },
  },
});

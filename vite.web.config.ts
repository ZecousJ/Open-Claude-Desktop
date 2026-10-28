/**
 * The web version's build (web plan §2, W-ARCH "W-V"): `web.html` +
 * `src-web/main.tsx` → `dist-web/`, served by the Claudex service at the
 * site root. The desktop build (vite.config.ts) is unchanged.
 *
 * - `base: "/"`: the SPA answers deep links (`/chat/<id>`), so asset URLs
 *   are absolute.
 * - The entry page is emitted as `dist-web/index.html`, the file the server
 *   falls back to for every app route.
 * - `__CLAUDEX_SURFACE__` is "web" (shared/host.ts).
 * - No `fixtureReferenceFonts()`: the web never reads local Claude fonts.
 * - The terminal (xterm) needs a shell on this computer, which the web does
 *   not have (`localTerminal` is off), so it is left out of the web bundle.
 * - React, the Markdown stack and KaTeX get their own chunks, so an app
 *   update does not invalidate them in the browser cache.
 * - A bundle report (`dist-web.report.json`, next to the output folder and
 *   never deployed) lets `scripts/check-web-bundle.mjs` enforce the
 *   first-load budget and keep lazy libraries lazy.
 *
 * `npm run dev:web` serves the same entry on http://127.0.0.1:5174 and
 * proxies the Claudex API (HTTP and the events WebSocket) and the share pages
 * to the local service: `CLAUDEX_WEB_API`, default the dev stack at
 * http://127.0.0.1:18080.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { previewRuntimes } from "./scripts/vite-preview-runtimes.ts";
import { webLightPalettePlugin } from "./scripts/vite-web-light-palette.ts";

const { version } = JSON.parse(readFileSync("package.json", "utf8"));

/** The local Claudex service the dev server forwards API calls to. */
const apiTarget = process.env.CLAUDEX_WEB_API || "http://127.0.0.1:18080";
/** A deployed service (CLAUDEX_WEB_API=https://…) answers by its own host name. */
const changeOrigin = apiTarget.startsWith("https:");

/** Forward only this loopback dev server's own Origin to its configured API. */
export function devApiOrigin(
  target: string,
  origin?: string,
  host?: string,
  fetchSite?: string,
) {
  if (
    !target.startsWith("https:") ||
    !host ||
    !/^(127\.0\.0\.1|localhost):5174$/.test(host)
  )
    return undefined;
  if (
    origin !== `http://${host}` &&
    !(origin === undefined && fetchSite === "same-origin")
  )
    return undefined;
  return new URL(target).origin;
}

/** The HTTPS service's refresh cookie has a loopback-only name on HTTP dev pages. */
export function devRequestCookies(value: string) {
  return value.replace(
    /(^|;\s*)claudex_dev_web_rt(?=(?:_\d+)?=)/g,
    "$1__Secure-claudex_web_rt",
  );
}
export function devResponseCookie(value: string) {
  if (!/^__Secure-claudex_web_rt(?:_\d+)?=/.test(value)) return value;
  return value
    .replace(/^__Secure-claudex_web_rt/, "claudex_dev_web_rt")
    .replace(/;\s*Secure(?=;|$)/gi, "");
}

/**
 * Chunk groups by package; the first match wins. Only libraries the first
 * screen needs anyway: lazily loaded ones (KaTeX, the highlighter, mermaid,
 * pdf.js, mammoth, sucrase, the preview runtimes) stay with their dynamic
 * importers.
 */
export const webChunkGroups: { name: string; test: RegExp }[] = [
  {
    name: "react",
    test: /[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/,
  },
  {
    name: "markdown",
    test: /[\\/]node_modules[\\/](react-markdown|remark-[^\\/]+|rehype-(?!katex|highlight)[^\\/]+|micromark[^\\/]*|mdast-[^\\/]+|hast-[^\\/]+|hastscript|unist-[^\\/]+|unified|vfile[^\\/]*|decode-named-character-reference|character-entities[^\\/]*|property-information|space-separated-tokens|comma-separated-tokens|html-url-attributes|zwitch|bail|trough|devlop|is-plain-obj|ccount|markdown-table|longest-streak|estree-util-is-identifier-name|inline-style-parser|style-to-js|style-to-object|trim-lines|web-namespaces|extend|@ungap[\\/]structured-clone)[\\/]/,
  },
];

/** Files the dev server refuses to serve (Vite's defaults first). */
export const webDevDeny = [
  ".env",
  ".env.*",
  "*.{crt,pem}",
  "**/.git/**",
  "*.env",
  "**/work/**",
  "**/secrets/**",
  "**/backend/**",
];

/** Packages the web build replaces: they only serve desktop-only features. */
export const webAbsentPackages = /^@xterm\//;
const absentPrefix = "\0claudex-web-absent:";

/**
 * Replaces the terminal packages with a module whose classes refuse to
 * start. The terminal panel has no entry point on the web (the bridge's
 * terminal methods are absent), so this only drops about 100 KB (gzip) of
 * dead code from the first load; if something did reach it, it fails the
 * way an absent bridge method does.
 */
function webAbsentModules(): Plugin {
  return {
    name: "claudex-web-absent-modules",
    enforce: "pre",
    resolveId(source) {
      if (webAbsentPackages.test(source)) {
        // Stylesheets become an empty module, not an empty stylesheet.
        const css = source.endsWith(".css");
        return `${absentPrefix}${source}${css ? ".js" : ""}`;
      }
    },
    load(id) {
      if (!id.startsWith(absentPrefix)) return;
      if (id.endsWith(".css.js")) return "export {};";
      return [
        "function absent() {",
        '  throw new Error("The terminal is not available on the web.");',
        "}",
        "export class Terminal { constructor() { absent(); } }",
        "export class FitAddon { constructor() { absent(); } }",
        "export class SearchAddon { constructor() { absent(); } }",
      ].join("\n");
    },
  };
}

/** Emits the entry page as `index.html`, the file the server falls back to. */
function entryAsIndex(): Plugin {
  return {
    name: "claudex-web-entry-as-index",
    apply: "build",
    enforce: "post",
    generateBundle(_options, bundle) {
      const page = bundle["web.html"];
      if (!page || page.type !== "asset") return;
      // Rolldown ignores assignments to the bundle: emit the page under its
      // new name and drop the original.
      delete bundle["web.html"];
      this.emitFile({
        type: "asset",
        fileName: "index.html",
        source: page.source,
      });
    },
  };
}

/** Where the bundle report of an output folder goes. */
export function bundleReportPath(outDir: string) {
  return `${path.resolve(outDir)}.report.json`;
}

/**
 * Writes what check-web-bundle.mjs needs and the output files cannot say:
 * which modules each chunk holds, its static and dynamic imports and the
 * stylesheets it pulls in.
 */
function bundleReport(): Plugin {
  let outDir = "dist-web";
  let root = process.cwd();
  return {
    name: "claudex-web-bundle-report",
    apply: "build",
    configResolved(config) {
      root = config.root;
      outDir = path.resolve(config.root, config.build.outDir);
    },
    writeBundle(_options, bundle) {
      const relative = (id: string) =>
        id.startsWith(root + path.sep)
          ? path.relative(root, id).split(path.sep).join("/")
          : id.replace(/\0/g, "\\0");
      const chunks: Record<string, unknown> = {};
      for (const [fileName, output] of Object.entries(bundle)) {
        if (output.type !== "chunk") continue;
        chunks[fileName] = {
          isEntry: output.isEntry,
          isDynamicEntry: output.isDynamicEntry,
          imports: output.imports,
          dynamicImports: output.dynamicImports,
          css: [...(output.viteMetadata?.importedCss ?? [])],
          modules: Object.keys(output.modules).map(relative),
        };
      }
      writeFileSync(
        bundleReportPath(outDir),
        `${JSON.stringify({ version: 1, entry: "index.html", chunks }, null, 1)}\n`,
      );
    },
  };
}

/**
 * The dev server's SPA fallback: page loads of app routes get web.html
 * (index.html is the desktop renderer's page).
 */
function devWebEntry(): Plugin {
  const passThrough =
    /^\/(api|v1|s|admin|@|src|src-web|shared|node_modules)(\/|$)/;
  return {
    name: "claudex-web-dev-entry",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use((request, _response, next) => {
        const url = request.url ?? "/";
        const pathname = url.split("?")[0];
        const page =
          request.method === "GET" &&
          (request.headers.accept ?? "").includes("text/html") &&
          !passThrough.test(pathname) &&
          (pathname === "/index.html" || !path.posix.extname(pathname));
        if (page) request.url = "/web.html";
        next();
      });
    },
  };
}

export default defineConfig({
  // The icons also at fixed addresses (/apple-touch-icon.png…): emails show
  // the app icon from there (backend claudex_email_layout.go).
  publicDir: "public-web",
  // Keep the fixture/desktop server from invalidating web optimized modules.
  cacheDir: "node_modules/.vite-web",
  plugins: [
    webAbsentModules(),
    webLightPalettePlugin(),
    react(),
    previewRuntimes(),
    entryAsIndex(),
    bundleReport(),
    devWebEntry(),
  ],
  base: "/",
  resolve: {
    // remark-math only needs the syntax half; the package index also pulls
    // in mathHtml and with it all of KaTeX, which Markdown loads on demand.
    alias: [
      {
        find: /^micromark-extension-math$/,
        replacement: path.resolve(
          "node_modules/micromark-extension-math/lib/syntax.js",
        ),
      },
    ],
  },
  server: {
    host: "127.0.0.1",
    port: 5174,
    strictPort: true,
    // backend/ is the vendored Sub2API fork with its own Vue toolchain.
    watch: { ignored: ["**/backend/**"] },
    // The dev server serves any file under the repository root; keep the
    // local secrets (work/: dev-stack credentials, service keys) and env
    // files out of reach. The first four are Vite's defaults.
    fs: { deny: webDevDeny },
    proxy: {
      "/api": {
        target: apiTarget,
        ws: true,
        changeOrigin,
        configure(proxy) {
          proxy.on("proxyReq", (upstream, request) => {
            const origin = devApiOrigin(
              apiTarget,
              request.headers.origin,
              request.headers.host,
              request.headers["sec-fetch-site"] as string | undefined,
            );
            if (origin) {
              upstream.setHeader("Origin", origin);
              if (request.headers.cookie)
                upstream.setHeader(
                  "Cookie",
                  devRequestCookies(request.headers.cookie),
                );
            }
          });
          // The events WebSocket's upgrade goes through proxyReqWs, not
          // proxyReq: it needs the same Origin, or the service refuses it.
          proxy.on("proxyReqWs", (upstream, request) => {
            const origin = devApiOrigin(
              apiTarget,
              request.headers.origin,
              request.headers.host,
              request.headers["sec-fetch-site"] as string | undefined,
            );
            if (origin) {
              upstream.setHeader("Origin", origin);
              if (request.headers.cookie)
                upstream.setHeader(
                  "Cookie",
                  devRequestCookies(request.headers.cookie),
                );
            }
          });
          proxy.on("proxyRes", (response, request) => {
            if (
              !devApiOrigin(
                apiTarget,
                request.headers.origin,
                request.headers.host,
                request.headers["sec-fetch-site"] as string | undefined,
              )
            )
              return;
            const cookies = response.headers["set-cookie"];
            if (cookies)
              response.headers["set-cookie"] = cookies.map(devResponseCookie);
          });
        },
      },
      // The gateway: dictation's realtime transcription WebSocket.
      "/v1": { target: apiTarget, ws: true },
      "/s/": { target: apiTarget },
      "/admin": { target: apiTarget },
    },
  },
  optimizeDeps: {
    entries: ["web.html"],
  },
  define: {
    __APP_VERSION__: JSON.stringify(version),
    __CLAUDEX_SURFACE__: JSON.stringify("web"),
    __CLAUDEX_SERVICE_URL__: JSON.stringify(
      process.env.CLAUDEX_SERVICE_URL ?? "",
    ),
  },
  build: {
    outDir: "dist-web",
    emptyOutDir: true,
    // Evergreen browsers from 2023 on (top-level await, :has(), dvh units).
    target: ["chrome111", "edge111", "firefox114", "safari16.4"],
    // Mermaid and pdf.js are large by nature and load only on demand; the
    // first-load budget is checked by scripts/check-web-bundle.mjs.
    chunkSizeWarningLimit: 6000,
    rolldownOptions: {
      input: { index: "web.html" },
      output: {
        codeSplitting: { groups: webChunkGroups },
      },
    },
  },
});

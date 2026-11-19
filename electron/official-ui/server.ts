import { OfficialRendererPacks, rendererPrefix, rendererDocument, rewriteRendererReferences } from "../ui-pack/official-renderer";
import { listenOnLoopback, reserveLoopbackPort } from "../loopback-ports";
/**
 * The loopback origin the official front-end runs on (docs/official-ui-client.md):
 * the page and its published modules from build/official-ui/ui, and the API
 * adapter for everything the page asks its own origin for (/api, /edge-api,
 * /claudeai-rpc, /v1). Every request must carry this launch's cookie token;
 * the window's session gets it before the page loads, other local processes
 * never see it.
 */
import http from "node:http";
import { withResponseLease, type ResponseLease } from "./response-lease";
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import type { Duplex } from "node:stream";

export const cookieName = "claudex_official_ui";
const apiPrefixes = ["/api/", "/edge-api/", "/claudeai-rpc/", "/v1/"];
const types: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json",
  ".wasm": "application/wasm",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".gif": "image/gif",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".avif": "image/avif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".mp3": "audio/mpeg",
  ".webm": "video/webm",
  ".txt": "text/plain; charset=utf-8",
};

export type ApiHandler = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
) => Promise<boolean> | boolean;

export interface OfficialUiServer {
  origin: string;
  token: string;
  close(): Promise<void>;
}

export async function startOfficialUiServer(options: {
  /** build/official-ui */
  root: string;
  rendererPacks?: OfficialRendererPacks;
  rendererBusy?: () => boolean;
  /** Persist the loopback port so browser storage remains on one origin across launches. */
  portFile?: string;
  api: ApiHandler;
  log?: (...args: unknown[]) => void;
  /** Development only (CLAUDEX_OFFICIAL_UI_DEVTOOLS=1): runs JavaScript in the page for inspection. */
  debugEval?: (script: string, windowId?: number) => Promise<unknown>;
  /** Development and e2e only: opens another (hidden in e2e) official window; answers its id. */
  debugOpenWindow?: () => Promise<number>;
  /** Development and e2e only: loads a page route in a window; answers once it has loaded. */
  debugNavigate?: (route: string, windowId?: number) => Promise<void>;
  /** Development only: a PNG of a window ("checkout" or an official window id). */
  debugCapture?: (windowId?: number, nativePdf?:boolean) => Promise<Buffer>;
  /** Development only: calls a Claudex IPC handler by name ({name, args}). */
  debugCall?: (name: string, args: unknown[]) => Promise<unknown>;
  /** Development only: a trusted click inside this test window's viewport. */
  debugClick?: (x: number, y: number, windowId?: number) => void;
  /** Explicit focus E2E only: focus one of this test client's own windows. */
  debugFocus?: (windowId?: number) => void;
  /** Test-only read of isolated preview frames, without exposing arbitrary frame execution. */
  debugFrames?: (windowId?: number) => Promise<unknown>;
  /** E2E only: dispatch native keys inside this test client's own windows/pages. */
  debugKey?: (
    key: string,
    modifiers: string[],
    preview: boolean,
    windowId?: number,
  ) => void;
  /** E2E only: exercise the normal application quit lifecycle. */
  debugQuit?: () => void;
  debugFileInput?: (files:string[],windowId?:number)=>Promise<void>;
  /** Native activation admission only; never maps an old request onto the new account. */
  isCurrent?: () => boolean;
  responseLease?: ResponseLease;
  reusePort?: boolean;
  /** Persistent storage must not silently move to another origin. */
  requireStablePort?: boolean;
  desktopStartup?: boolean;
  forbiddenPorts?: ReadonlySet<number>;
  upgrade?: (request: http.IncomingMessage, socket: Duplex, head: Buffer, origin: string, browser: boolean) => void;
}): Promise<OfficialUiServer> {
  const token = randomBytes(24).toString("hex");
  const ui = path.join(options.root, "ui");
  const desktop = path.join(options.root, "main-window", "view.html");
  const index = fs.readFileSync(options.desktopStartup && fs.existsSync(desktop)
    ? desktop : path.join(ui, "index.html"));
  const log = options.log ?? (() => {});
  const authorized = (req: http.IncomingMessage) =>
    (req.headers.cookie ?? "")
      .split(";")
      .some((part) => part.trim() === `${cookieName}=${token}`);
  const server = http.createServer((req, res) => {
    const serve = async () => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      // Admission is checked once for this concrete request. A previously
      // admitted logout may finish its exact response after retiring the lease;
      // new requests have no path/header-based retirement exemption.
      if (options.isCurrent && options.isCurrent() !== true) {
        res.writeHead(410, { "Content-Type": "text/plain", "Cache-Control": "no-store" });
        return res.end("This account window has retired. Reopen the interface.");
      }
      // The public directory (window.ts redirects the vendor host's directory
      // reads here): no account data, answered without the cookie, CORS for the page.
      if (
        url.pathname.startsWith("/api/__public/directory/") &&
        (req.method === "GET" || req.method === "OPTIONS")
      ) {
        res.writeHead(req.method === "OPTIONS" ? 204 : 200, {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": String(req.headers.origin ?? "*"),
          "Access-Control-Allow-Credentials": "true",
          "Access-Control-Allow-Headers": "*",
          "Cache-Control": "no-store",
        });
        return res.end(
          req.method === "OPTIONS"
            ? undefined
            : JSON.stringify(
                // Exact recovered BFF schema (shared-p-m-0 tJ): do not return
                // the plugins envelope for servers. Still deliberately empty;
                // this unauthenticated route must never read account inventory.
                url.pathname === "/api/__public/directory/servers"
                  ? { servers: [], next_cursor: null }
                  : { data: [], next_page: null, facets: {} },
              ),
        );
      }
      if (!authorized(req)) {
        res.writeHead(403, { "Content-Type": "text/plain" });
        return res.end("Forbidden");
      }
      res.setHeader("X-Content-Type-Options", "nosniff");
      if (
        url.pathname === "/__debug/quit" &&
        options.debugQuit &&
        req.method === "POST"
      ) {
        res.writeHead(204);
        res.end();
        setImmediate(options.debugQuit);
        return;
      }
      if (
        url.pathname === "/__debug/key" &&
        options.debugKey &&
        req.method === "POST"
      ) {
        const key = url.searchParams.get("key") ?? "",
          modifiers = url.searchParams.getAll("modifier");
        if (
          !key ||
          key.length > 40 ||
          modifiers.some(
            (m) => !["meta", "control", "shift", "alt"].includes(m),
          )
        ) {
          res.writeHead(400);
          return res.end();
        }
        options.debugKey(
          key,
          modifiers,
          url.searchParams.get("preview") === "1",
          Number(url.searchParams.get("window") ?? 0) || undefined,
        );
        res.writeHead(204);
        return res.end();
      }
      if (
        url.pathname === "/__debug/frames" &&
        options.debugFrames &&
        req.method === "GET"
      ) {
        const frames = await options.debugFrames(
          Number(url.searchParams.get("window") ?? 0) || undefined,
        );
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        });
        return res.end(JSON.stringify(frames));
      }
      if (
        url.pathname === "/__debug/focus" &&
        options.debugFocus &&
        req.method === "POST"
      ) {
        options.debugFocus(
          Number(url.searchParams.get("window") ?? 0) || undefined,
        );
        res.writeHead(204);
        res.end();
        return;
      }
      if (
        url.pathname === "/__debug/click" &&
        options.debugClick &&
        req.method === "POST"
      ) {
        const x = Number(url.searchParams.get("x")),
          y = Number(url.searchParams.get("y"));
        if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0) {
          res.writeHead(400);
          return res.end();
        }
        options.debugClick(
          Math.round(x),
          Math.round(y),
          Number(url.searchParams.get("window") ?? 0) || undefined,
        );
        res.writeHead(204);
        return res.end();
      }
      if (
        url.pathname === "/__debug/open-window" &&
        options.debugOpenWindow &&
        req.method === "POST"
      ) {
        const id = await options.debugOpenWindow();
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ id }));
      }
      if (
        url.pathname === "/__debug/navigate" &&
        options.debugNavigate &&
        req.method === "POST"
      ) {
        const windowId =
          Number(url.searchParams.get("window") ?? 0) || undefined;
        try {
          await options.debugNavigate(
            url.searchParams.get("route") ?? "/",
            windowId,
          );
          res.writeHead(200, { "Content-Type": "application/json" });
          return res.end("{}");
        } catch (error) {
          res.writeHead(500, { "Content-Type": "application/json" });
          return res.end(
            JSON.stringify({
              error: error instanceof Error ? error.message : String(error),
            }),
          );
        }
      }
      if(url.pathname==='/__debug/file-input' && options.debugFileInput && req.method==='POST'){
        try{
          const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));
          const input=JSON.parse(Buffer.concat(chunks).toString());
          await options.debugFileInput(input.files,Number(url.searchParams.get('window')??0)||undefined);
          res.writeHead(204);res.end();return;
        }catch(error){res.writeHead(400,{'Content-Type':'application/json'});res.end(JSON.stringify({error:String(error)}));return;}
      }
      if (url.pathname === "/__debug/capture" && options.debugCapture) {
        try {
          const raw = url.searchParams.get("window");
          const png = await options.debugCapture(
            raw === "checkout" ? -1 : Number(raw ?? 0) || undefined,
            url.searchParams.get('nativePdf')==='1',
          );
          res.writeHead(200, { "Content-Type": "image/png" });
          return res.end(png);
        } catch (error) {
          res.writeHead(500, { "Content-Type": "application/json" });
          return res.end(
            JSON.stringify({
              error: error instanceof Error ? error.message : String(error),
            }),
          );
        }
      }
      if (
        url.pathname === "/__debug/call" &&
        options.debugCall &&
        req.method === "POST"
      ) {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        try {
          const { name, args } = JSON.parse(
            Buffer.concat(chunks).toString("utf8"),
          );
          const value = await options.debugCall(
            String(name),
            Array.isArray(args) ? args : [],
          );
          res.writeHead(200, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ value }));
        } catch (error) {
          res.writeHead(500, { "Content-Type": "application/json" });
          return res.end(
            JSON.stringify({
              error: error instanceof Error ? error.message : String(error),
            }),
          );
        }
      }
      if (
        url.pathname === "/__debug/eval" &&
        options.debugEval &&
        req.method === "POST"
      ) {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        try {
          const raw = url.searchParams.get("window");
          const windowId =
            raw === "checkout" ? -1 : Number(raw ?? 0) || undefined;
          const value = await options.debugEval(
            Buffer.concat(chunks).toString("utf8"),
            windowId,
          );
          res.writeHead(200, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ value }));
        } catch (error) {
          res.writeHead(500, { "Content-Type": "application/json" });
          return res.end(
            JSON.stringify({
              error: error instanceof Error ? error.message : String(error),
            }),
          );
        }
      }
      if (apiPrefixes.some((prefix) => url.pathname.startsWith(prefix))) {
        if (await options.api(req, res)) return;
        res.writeHead(501, { "Content-Type": "application/json" });
        return res.end(
          JSON.stringify({
            error: {
              type: "not_implemented",
              message: `No adapter for ${req.method} ${url.pathname}`,
            },
          }),
        );
      }
      if (req.method !== "GET" && req.method !== "HEAD") {
        res.writeHead(405);
        return res.end();
      }
      if (url.pathname === "/task/new" && !url.searchParams.has("mode")) {
        url.searchParams.set("mode", "cowork");
        res.writeHead(307, {
          Location: url.pathname + url.search,
          "Cache-Control": "no-store",
        });
        return res.end();
      }
      if (options.rendererPacks && url.pathname.startsWith(rendererPrefix)) {
        const parts = url.pathname.slice(rendererPrefix.length).split("/");
        const version = parts.shift()!;
        const root = options.rendererPacks.root(version);
        const relative = path.posix.normalize("/" + decodeURIComponent(parts.join("/")));
        const file = root && path.join(root, relative);
        if (!root || !file || !file.startsWith(root + path.sep) ||
            !fs.existsSync(file) || !fs.statSync(file).isFile()) {
          res.writeHead(404, { "Cache-Control": "no-store" });
          return res.end();
        }
        const ext = path.extname(file).toLowerCase();
        const text = /\.(js|css|html|json)$/.test(file);
        res.writeHead(200, {
          "Content-Type": types[ext] ?? "application/octet-stream",
          ...(relative === "/official-status-preview.html" ? {
            "Content-Security-Policy": "sandbox allow-scripts; frame-ancestors 'self'",
            "X-Frame-Options": "SAMEORIGIN",
          } : {}),
          "Cache-Control": "public, max-age=31536000, immutable",
        });
        if (req.method === "HEAD") return res.end();
        return text
          ? res.end(rewriteRendererReferences(fs.readFileSync(file, "utf8"), version))
          : fs.createReadStream(file).pipe(res);
      }
      const relative = path.posix.normalize(decodeURIComponent(url.pathname));
      const file = path.join(ui, relative);
      if (
        file.startsWith(ui + path.sep) &&
        path.extname(file) &&
        fs.existsSync(file) &&
        fs.statSync(file).isFile()
      ) {
        const hashed = /^\/assets\//.test(relative);
        res.writeHead(200, {
          "Content-Type":
            types[path.extname(file).toLowerCase()] ??
            "application/octet-stream",
          ...(relative === "/official-status-preview.html" ? {
            "Content-Security-Policy": "sandbox allow-scripts; frame-ancestors 'self'",
            "X-Frame-Options": "SAMEORIGIN",
          } : {}),
          "Cache-Control": hashed
            ? "public, max-age=31536000, immutable"
            : "no-cache",
        });
        if (req.method === "HEAD") return res.end();
        return fs.createReadStream(file).pipe(res);
      }
      // A missing file is a 404, never the page: an asset the bundle lacks must fail
      // visibly (an image decode, a module import) instead of receiving HTML.
      if (path.extname(relative) && !/\.html?$/.test(relative)) {
        log("[official-ui] no such file", relative);
        res.writeHead(404, { "Content-Type": "text/plain", "Cache-Control": "no-store" });
        return res.end("Not found");
      }
      // Every other path is a page route: the front-end's own router takes it.
      res.writeHead(200, {
        "Content-Type": types[".html"],
        "Cache-Control": "no-store",
      });
      const renderer = options.rendererPacks?.document(options.rendererBusy?.() !== true);
      const document = renderer && renderer.version !== "bundled"
        ? fs.readFileSync(path.join(renderer.root, "index.html"), "utf8")
        : index.toString("utf8");
      res.end(req.method === "HEAD" ? undefined : renderer
        ? rendererDocument(document, renderer.version) : document);
    } catch (error) {
      log("[official-ui] request failed", req.url, error);
      if (!res.headersSent) res.writeHead(500);
      res.end();
    }
    };
    return options.responseLease ? withResponseLease(options.responseLease, res, serve) : serve();
  });
  server.on("error", (error) => log("[official-ui] server error", error));
  server.on("upgrade", (request, socket, head) => {
    if (!options.upgrade || options.isCurrent?.() === false) {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      return;
    }
    options.upgrade(request, socket, head, `http://localhost:${port}`, authorized(request));
  });

  const readPort = () => {
    if (!options.portFile) return undefined;
    try {
      const port = Number(fs.readFileSync(options.portFile, "utf8").trim());
      if (Number.isInteger(port) && port >= 1024 && port <= 65535) return port;
      if (options.requireStablePort) throw new Error("The saved account interface origin is invalid.");
      return undefined;
    } catch (error) {
      if (options.requireStablePort && (error as NodeJS.ErrnoException).code !== "ENOENT")
        throw new Error("The saved account interface origin could not be read.");
      return undefined;
    }
  };
  const listen = (port: number) => listenOnLoopback(server, port);

  const previousPort = options.reusePort === false ? undefined : readPort();
  let port: number;
  try {
    port = await listen(previousPort ?? 0);
  } catch (error) {
    if (
      options.requireStablePort === true ||
      previousPort === undefined ||
      (error as NodeJS.ErrnoException).code !== "EADDRINUSE"
    )
      throw error;
    log(
      "[official-ui] saved loopback port is occupied; choosing a new port",
      previousPort,
    );
    port = await listen(0);
  }

  for (let attempts = 0; options.forbiddenPorts?.has(port); attempts++) {
    if (options.requireStablePort && previousPort !== undefined) {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      throw new Error("The saved account interface origin is unavailable.");
    }
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    if (attempts >= 15) throw new Error("A fresh interface origin could not be allocated.");
    port = await listen(0);
  }
  if (options.isCurrent && options.isCurrent() !== true) {
    server.close();
    throw new Error("The account changed while the interface server was starting.");
  }
  if (options.portFile) {
    reserveLoopbackPort(port);
    const directory = path.dirname(options.portFile);
    const temporary = `${options.portFile}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    try {
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(temporary, `${port}\n`, { mode: 0o600 });
      fs.renameSync(temporary, options.portFile);
    } catch (error) {
      server.close();
      throw error;
    } finally {
      try {
        fs.rmSync(temporary, { force: true });
      } catch {}
    }
  }

  return {
    // "localhost" as the official shell uses it: the page and preload compare origins.
    origin: `http://localhost:${port}`,
    token,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  };
}

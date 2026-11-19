import { once } from "node:events";
import net from "node:net";
import path from "node:path";
import fs from "node:fs";
import { startOfficialUserContentServer } from "../../server/official-usercontent";
import { decodeWireValue } from "../../shared/web-wire";
import { webAuthRoutes, webPaths } from "../../shared/web-protocol";
import { fail, ok, type MockRequest, type MockSub2Api } from "./sub2api-mock";

export function installOfficialWebMemory(mock: MockSub2Api, accounts: readonly { id: number; username: string; generate: boolean }[], log: boolean) {
  const scope = "global";
  const updated_at = new Date().toISOString();
  const rows = new Map(accounts.map(({ id, username, generate }) => [id, {
    generate,
    version: 0,
    edits: [] as { id: number; scope: string; text: string; created_at: string }[],
    doc: { scope, content: `${username}'s fixture memory.`, revision: 1, source: "generated", generated_at: updated_at, updated_at },
  }]));
  const versionOf = (value: number) => `v1:1:${value}:0`;
  const route = "/api/v1/claudex/memory";
  mock.route("GET", route, (request) => {
    const row = rows.get(request.userId!);
    if (!row) return fail(404, "No fixture memory", "NOT_FOUND");
    return ok({
      available: true,
      allowed: { search_chats: true, generate: true },
      prefs: { search_chats: false, generate: row.generate },
      docs: [row.doc],
      edits: row.edits,
      controls_versions: { global: versionOf(row.version) },
      empty_controls_version: "v1:0:0:0",
    });
  }, { auth: "user" });
  mock.route("PUT", route + "/controls/global", (request) => {
    const row = rows.get(request.userId!);
    if (!row) return fail(404, "No fixture memory", "NOT_FOUND");
    if (!row.generate) return fail(403, "Memory generation is off", "CLAUDEX_MEMORY_DISABLED", { field: "generate" });
    const { controls, base_controls_version } = request.body;
    if (!Array.isArray(controls) || controls.some((rule) => typeof rule !== "string"))
      return fail(400, "Invalid fixture controls", "CLAUDEX_MEMORY_INVALID");
    if (base_controls_version !== versionOf(row.version))
      return fail(409, "Fixture controls changed", "CLAUDEX_MEMORY_CONTROLS_CONFLICT");
    row.edits = controls.map((text, index) => ({
      id: index + 1, scope, text, created_at: new Date().toISOString(),
    }));
    const controls_version = versionOf(++row.version);
    if (log) console.log(`[official-web-cua] memory user=${request.userId} controls=${row.edits.length} version=${controls_version}`);
    return ok({ edits: row.edits, controls_version });
  }, { auth: "user" });
}

/** Supply the Web cookie contract using the smoke test's existing account backend. */
export function installCuaWebAuth(mock: MockSub2Api) {
  const prefix = "claudex_cua_refresh_";
  const accounts = (request: MockRequest) => {
    const cookies = new Map<string, string>();
    for (const cookie of request.headers.cookie?.split(/;\s*/) ?? []) {
      const [name, token] = cookie.split("=");
      if (name?.startsWith(prefix) && token && mock.refreshTokens.has(token))
        cookies.set(name.slice(prefix.length), token);
    }
    return cookies;
  };
  const cookie = (account: string, token: string) =>
    `${prefix}${account}=${token}; Path=${webPaths.auth}; HttpOnly; SameSite=Strict`;
  const post = async (route: string, body: unknown) => {
    const response = await fetch(`${mock.url}/api/v1/auth/${route}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  const noAuth = { auth: "none" } as const;
  mock.route("POST", webPaths.auth + webAuthRoutes.login, async (request) => {
    const result = await post("login", request.body);
    if (result.status !== 200) return result;
    const { refresh_token, ...session } = result.body.data;
    return ok(session, { "Set-Cookie": cookie(String(session.user.id), refresh_token) });
  }, noAuth);
  mock.route("POST", webPaths.auth + webAuthRoutes.refresh, async (request) => {
    const signedIn = accounts(request);
    const account = String(request.body.account ?? signedIn.keys().next().value ?? "");
    const token = signedIn.get(account);
    if (!token) return fail(401, "No fixture session", "UNAUTHORIZED");
    const result = await post("refresh", { refresh_token: token });
    if (result.status !== 200) return result;
    const { refresh_token, ...session } = result.body.data;
    return ok(session, { "Set-Cookie": cookie(account, refresh_token) });
  }, noAuth);
  mock.route("POST", webPaths.auth + webAuthRoutes.accounts, (request) =>
    ok({ accounts: Array.from(accounts(request).keys()) }), noAuth);
  mock.route("POST", webPaths.auth + webAuthRoutes.logout, async (request) => {
    const account = String(request.body.account ?? "");
    const token = accounts(request).get(account);
    if (token) await post("logout", { refresh_token: token });
    return ok({}, { "Set-Cookie": cookie(account, "") + "; Max-Age=0" });
  }, noAuth);
}

export async function serveOfficialWebForCua(relay: string, faultFile: string) {
  process.env.CLAUDEX_WEB_API = relay;
  process.env.VITE_CLAUDEX_OFFICIAL_APPEARANCE_SETTINGS = "1";
  process.env.VITE_CLAUDEX_OFFICIAL_MEMORY_CONTROLS = "1";
  const reservation = net.createServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const webPort = (reservation.address() as net.AddressInfo).port;
  await new Promise<void>((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()));
  const userContent = await startOfficialUserContentServer({
    root: path.resolve("build/official-usercontent"), parentOrigin: `http://127.0.0.1:${webPort}`,
  });
  process.env.VITE_CLAUDEX_OFFICIAL_USERCONTENT_ORIGIN = userContent.origin;
  try {
  const { build, preview } = await import("vite");
  const configFile = "vite.official-web.config.ts";
  const outDir = path.join(path.dirname(faultFile), `web-${process.pid}`);
  await build({ configFile, build: { outDir }, logLevel: "warn" });
  const server = await preview({
    configFile,
    build: { outDir },
    plugins: [{
      name: "claudex-cua-official-rpc-log",
      configurePreviewServer(vite) {
        vite.middlewares.use((request, response, next) => {
          const pathname = request.url?.split("?")[0] ?? "";
          const dest = request.headers["sec-fetch-dest"];
          const document = dest === "document" || dest === "iframe" ||
            ["/new", "/official-frame.html", "/official-frame-document.html"].includes(pathname);
          const entryScript = /^\/assets\/(?:entry|frame-entry|main)-[^/]+\.js$/.test(pathname) ||
            /^\/assets\/v1\/index-[^/]+\.js$/.test(pathname);
          const auth = [webPaths.auth + webAuthRoutes.login, webPaths.auth + webAuthRoutes.refresh].includes(pathname);
          if (document || entryScript || auth) {
            const destination = dest === "document" || dest === "iframe" || dest === "script" || dest === "empty"
              ? dest : "-";
            response.once("finish", () =>
              console.log(`[official-web-cua] ${request.method} ${pathname} → HTTP ${response.statusCode} dest=${destination} at=${new Date().toISOString()}`));
          }
          next();
        });
        const proxy = vite.config.preview.proxy?.["/api"];
        if (!proxy || typeof proxy === "string") throw Error("Missing Web API proxy.");
        const configure = proxy.configure;
        proxy.configure = (upstream, options) => {
          configure?.(upstream, options);
          const requests = new WeakMap<object, string[]>();
          const isOfficialRpc = (url?: string) =>
            url === webPaths.rpc + "officialUiRead" || url === webPaths.rpc + "officialUiAction";
          upstream.on("proxyReq", (_outgoing, request) => {
            if (!isOfficialRpc(request.url)) return;
            const chunks: string[] = [];
            requests.set(request, chunks);
            request.on("data", (chunk) => chunks.push(String(chunk)));
          });
          upstream.on("proxyRes", (response, request, target) => {
            const input = requests.get(request);
            if (!input) return;
            const call = fs.existsSync(faultFile) && fs.readFileSync(faultFile, "utf8").trim() === "conversation-detail-delay"
              ? JSON.parse(input.join(""))?.args?.[0] : undefined;
            if (call && ((call.method === "GET" && /\/chat_conversations\/[^/?]+(?:\?|$)/.test(call.path)) ||
                (call.method === "POST" && call.path.endsWith(".ConversationService/StreamTimeline")))) {
              const chunks: Buffer[] = [], write = target.write.bind(target), end = target.end.bind(target);
              target.write = ((chunk: any, encoding?: any, callback?: any) => {
                chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, typeof encoding === "string" ? encoding as BufferEncoding : undefined));
                (typeof encoding === "function" ? encoding : callback)?.();
                return true;
              }) as typeof target.write;
              target.end = ((chunk?: any, encoding?: any, callback?: any) => {
                if (chunk != null) target.write(chunk, encoding);
                const timer = setTimeout(() => {
                  target.write = write;
                  target.end = end;
                  for (const bytes of chunks) write(bytes);
                  end(typeof encoding === "function" ? encoding : callback);
                }, 30_000);
                target.once("close", () => clearTimeout(timer));
                return target;
              }) as typeof target.end;
              console.log(`[official-web-cua] delaying conversation detail for 30000ms: ${call.path}`);
            }
            const output: string[] = [];
            response.on("data", (chunk) => output.push(String(chunk)));
            response.on("end", () => {
              try {
                const { args: [call] } = JSON.parse(input.join(""));
                const rpc = JSON.parse(output.join(""));
                const result = decodeWireValue(rpc.value) as { status?: number };
                const outcome = rpc.ok ? result?.status : rpc.error?.code ?? response.statusCode;
                console.log(`[official-web-cua] ${request.url} ${call.method} ${call.path} → ${outcome}`);
              } catch {
                console.log(`[official-web-cua] ${request.url} → HTTP ${response.statusCode}`);
              }
            });
          });
        };
      },
    }],
    preview: {
      host: "127.0.0.1",
      port: webPort,
      strictPort: true,
      headers: {
        "Content-Security-Policy": `default-src 'self'; connect-src 'self' ws://127.0.0.1:*; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; frame-src 'self' blob: ${userContent.origin}; worker-src 'self' blob:`,
      },
    },
  });
  const stop = new AbortController();
  const requestStop = () => stop.abort();
  process.once("SIGUSR2", requestStop);
  try {
    console.log(`[official-web-cua] URL ${server.resolvedUrls?.local[0]}new pid=${process.pid} fault=${faultFile} dist=${outDir}`);
    if (!stop.signal.aborted) await once(stop.signal, "abort");
  } finally {
    process.off("SIGUSR2", requestStop);
    await server.close();
  }
  } finally {
    await userContent.close();
  }
}

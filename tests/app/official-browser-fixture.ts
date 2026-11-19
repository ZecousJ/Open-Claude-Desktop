/** Test-only same-origin host for the unchanged recovered official modules. */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { once } from "node:events";
import { Readable } from "node:stream";
import { build } from "esbuild";

export async function officialBrowserFixture(relay: string, options: { actions?: boolean } = {}) {
  const root = path.resolve("build/official-ui/ui");
  const html = fs.readFileSync(path.join(root, "index.html"), "utf8").replace('src="/app.js"', 'src="/__official_test_entry.js"');
  const bundle = await build({ bundle: true, write: false, format: "esm", platform: "browser", external: ["/assets/*"], stdin: {
    resolveDir: process.cwd(), loader: "js", contents: `
      import { WebTransport } from './shared/web-client/transport.ts';
      import { encodeCall } from './shared/web-client/codec.ts';
      import { createOfficialReadFetch } from './src-web/official/read-fetch.ts';
      import { createOfficialEventSource } from './src-web/official/event-source.ts';
      import { EventStream } from './shared/web-client/events.ts';
      import { EventHub } from './shared/web-client/hub.ts';
      const native = window.fetch.bind(window);
      const timers = { setTimeout: window.setTimeout.bind(window), clearTimeout: window.clearTimeout.bind(window), setInterval: window.setInterval.bind(window), clearInterval: window.clearInterval.bind(window) };
      const token = sessionStorage.getItem('__claudex_test_token');
      const auth = { accessToken: async () => token, refresh: async () => null, expire() {} };
      const transport = new WebTransport({ fetch: native, timers }, auth, 'official-test-tab');
      const hub = new EventHub();
      window.__officialTestStreamEvents = [];
      hub.subscribe(event => window.__officialTestStreamEvents.push(event.type));
      const stream = new EventStream({
        origin: location.origin, timers, now: Date.now, navigate() {},
        openSocket: (url, protocols) => new WebSocket(url, protocols),
        onVisibility() {}, onOnline() {},
      }, {
        current: true,
        async ticket() {
          const response = await native('/api/v1/claudex/web/auth/events-ticket', {method:'POST',
            headers: {Authorization: 'Bearer ' + token, 'Content-Type':'application/json'},
            body: JSON.stringify({tabId:'official-test-tab'})});
          if (!response.ok) throw Error('Event ticket failed');
          return (await response.json()).data;
        },
        expire() { hub.emit({type:'signed-out', reason:'session-expired'}); },
      }, hub, {snapshotLoaded: () => true, pushSnapshot() {}, observe() {}}, 'official-test-tab');
      window.__officialTestStreamReady = () => stream.connected;
      const subscribe = ${options.actions ? "listener => hub.subscribe(listener)" : "undefined"};
      if (subscribe) stream.start();
      window.addEventListener('pagehide', () => stream.stop(), {once:true});
      const action = ${options.actions ? "async request => transport.call('officialUiAction', await encodeCall([request], transport))" : "undefined"};
      const readFetch = createOfficialReadFetch(location.origin, async request => transport.call('officialUiRead', await encodeCall([request], transport)), native, subscribe, action);
      window.EventSource = createOfficialEventSource(location.origin, async request => transport.call('officialUiRead', await encodeCall([request], transport)), window.EventSource, listener => hub.subscribe(listener));
      window.__officialTestFailures = [];
      window.__officialTestCalls = [];
      window.fetch = async (input, init) => {
        const response = await readFetch(input, init);
        const call = { path: new URL(input instanceof Request ? input.url : String(input), location.origin).pathname, status: response.status };
        window.__officialTestCalls.push(call);
        if (response.status >= 400) window.__officialTestFailures.push(call);
        return response;
      };
      import('/assets/v1/index-BJJTYFi2.js').catch(error => { console.error('[official-test-entry]', error); });`,
  } });
  const mime: Record<string, string> = { ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".woff": "font/woff", ".png": "image/png", ".webp": "image/webp", ".wasm": "application/wasm" };
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname.startsWith("/api/v1/")) {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        const upstream = await fetch(new URL(`${url.pathname}${url.search}`, relay), {
          method: req.method, headers: { ...(req.headers.authorization ? { authorization: req.headers.authorization } : {}),
            ...(req.headers["content-type"] ? { "content-type": req.headers["content-type"] } : {}),
            ...(req.headers["x-claudex-web-tab"] ? { "x-claudex-web-tab": String(req.headers["x-claudex-web-tab"]) } : {}), origin: relay },
          ...(req.method === "GET" || req.method === "HEAD" ? {} : { body: Buffer.concat(chunks) }),
        });
        res.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "application/json" });
        if (upstream.body) Readable.fromWeb(upstream.body as never).pipe(res); else res.end();
        return;
      }
      if (url.pathname === "/__official_test_entry.js") { res.writeHead(200, { "content-type": "text/javascript" }); res.end(bundle.outputFiles[0].text); return; }
      if (url.pathname === "/" || url.pathname === "/new") { res.writeHead(200, { "content-type": "text/html" }); res.end(html); return; }
      const file = path.resolve(root, `.${decodeURIComponent(url.pathname)}`);
      if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { "content-type": mime[path.extname(file)] ?? "application/octet-stream" });
      fs.createReadStream(file).pipe(res);
    } catch { if (!res.headersSent) res.writeHead(500); res.end(); }
  });
  // The real EventStream speaks to the Go relay. Proxy only its exact route,
  // preserving the one-time ticket in Sec-WebSocket-Protocol, never a URL.
  const sockets = new Set<import("node:stream").Duplex>();
  server.on("upgrade", (req, socket, head) => {
    if (new URL(req.url ?? "/", "http://localhost").pathname !== "/api/v1/claudex/web/events") { socket.destroy(); return; }
    const target = new URL(req.url!, relay);
    const upstream = http.request(target, { headers: { ...req.headers, host: target.host, origin: new URL(relay).origin } });
    upstream.on("upgrade", (response, peer, peerHead) => {
      sockets.add(socket); sockets.add(peer);
      socket.write(`HTTP/1.1 ${response.statusCode} ${response.statusMessage}\r\n${response.rawHeaders.reduce((lines, value, i, headers) => i % 2 ? lines : [...lines, `${value}: ${headers[i + 1]}`], [] as string[]).join("\r\n")}\r\n\r\n`);
      if (peerHead.length) socket.write(peerHead);
      if (head.length) peer.write(head);
      socket.pipe(peer).pipe(socket);
      socket.on("close", () => { sockets.delete(socket); peer.destroy(); });
      peer.on("close", () => { sockets.delete(peer); socket.destroy(); });
      peer.on("error", () => socket.destroy());
    });
    upstream.on("response", () => socket.destroy());
    upstream.on("error", () => socket.destroy());
    socket.on("error", () => upstream.destroy());
    upstream.end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as { port: number };
  return { origin: `http://127.0.0.1:${address.port}`, close: () => { for (const socket of sockets) socket.destroy(); server.closeAllConnections(); server.close(); } };
}

// W-EGRESS: the runner's egress proxy (runner/src/egress-proxy.ts) over real
// Unix sockets. Names resolve through a scripted resolver and "public"
// addresses are dialled to local test servers, so nothing leaves the machine.
// Erasable TypeScript only, so plain Node can run this file too.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { after, describe, test } from "node:test";
import tls from "node:tls";
import { EgressProxy } from "../../runner/src/egress-proxy.ts";
import {
  egressSocketPath,
  parseAuthority,
} from "../../runner/src/egress-support.ts";
import { parseClientHello } from "../../runner/src/egress-tls.ts";
import type { EgressProxyOptions } from "../../runner/src/egress-proxy.ts";
import type { NetPolicy } from "../../runner/src/net-policy.ts";

const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "egr-"));
after(() => fs.rmSync(base, { recursive: true, force: true }));
let counter = 0;
const sockPath = () => path.join(base, `s${++counter}`, "e.sock");

/**
 * A minimal TLS ClientHello record (optionally split across `records`
 * handshake records) naming `serverName`.
 */
function clientHello(serverName?: string, records = 1) {
  const ext: Buffer[] = [];
  if (serverName !== undefined) {
    const name = Buffer.from(serverName, "latin1");
    const entry = Buffer.concat([
      Buffer.from([0, name.length >> 8, name.length & 0xff]),
      name,
    ]);
    const list = Buffer.concat([
      Buffer.from([entry.length >> 8, entry.length & 0xff]),
      entry,
    ]);
    ext.push(Buffer.from([0, 0, list.length >> 8, list.length & 0xff]), list);
  }
  const extensions = Buffer.concat(ext);
  const body = Buffer.concat([
    Buffer.from([3, 3]),
    Buffer.alloc(32, 7),
    Buffer.from([0, 0, 2, 0x13, 0x01, 1, 0]),
    Buffer.from([extensions.length >> 8, extensions.length & 0xff]),
    extensions,
  ]);
  const hs = Buffer.concat([
    Buffer.from([1, 0, body.length >> 8, body.length & 0xff]),
    body,
  ]);
  const out: Buffer[] = [];
  const step = Math.ceil(hs.length / records);
  for (let i = 0; i < hs.length; i += step) {
    const part = hs.subarray(i, i + step);
    out.push(
      Buffer.from([0x16, 3, 1, part.length >> 8, part.length & 0xff]),
      part,
    );
  }
  return Buffer.concat(out);
}

/**
 * A TCP echo server standing in for a public TLS host: it drops the
 * ClientHello record a tunnel starts with and echoes everything after it.
 */
async function echoServer() {
  const server = net.createServer((c) => {
    let pending = Buffer.alloc(0);
    let handshake = true;
    c.on("data", (d: Buffer) => {
      pending = Buffer.concat([pending, d]);
      while (handshake && pending.length) {
        if (pending[0] !== 0x16) handshake = false;
        else if (pending.length < 5) return;
        else {
          const size = 5 + pending.readUInt16BE(3);
          if (pending.length < size) return;
          pending = pending.subarray(size);
        }
      }
      if (pending.length) c.write(`echo:${pending}`);
      pending = Buffer.alloc(0);
    });
    c.on("error", () => {});
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return { server, port: (server.address() as net.AddressInfo).port };
}

/** An HTTP server standing in for a public web host. */
async function webServer() {
  const seen: http.IncomingHttpHeaders[] = [];
  const server = http.createServer((req, res) => {
    seen.push(req.headers);
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => res.end(`web:${req.method}:${req.url}:${body}`));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return { server, seen, port: (server.address() as net.AddressInfo).port };
}

interface Harness {
  proxy: EgressProxy;
  dialled: string[];
  logs: string[];
}

/** A proxy whose "public" addresses all reach `localPort` on this machine. */
function harness(
  answers: Record<string, string[] | (() => string[])>,
  localPort: number,
  extra: EgressProxyOptions = {},
): Harness {
  const dialled: string[] = [];
  const logs: string[] = [];
  const proxy = new EgressProxy({
    resolver: async (host) => {
      const a = answers[host];
      if (!a) throw new Error("ENOTFOUND");
      return typeof a === "function" ? a() : a;
    },
    ownAddresses: () => [],
    connect: (address, port) => {
      dialled.push(`${address}:${port}`);
      return net.connect(localPort, "127.0.0.1");
    },
    verifyPeer: false,
    log: (line) => logs.push(line),
    ...extra,
  });
  return { proxy, dialled, logs };
}

/** Sends a CONNECT, returns the status line, headers, body and the socket. */
function connect(socket: string, authority: string) {
  return new Promise<{
    status: number;
    head: string;
    body: string;
    conn: net.Socket;
  }>((resolve, reject) => {
    const conn = net.connect(socket, () =>
      conn.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`),
    );
    let data = "";
    const onData = (d: Buffer) => {
      data += d.toString();
      const end = data.indexOf("\r\n\r\n");
      if (end < 0) return;
      const head = data.slice(0, end);
      const status = Number(head.split(" ")[1]);
      if (status === 200) {
        conn.off("data", onData);
        resolve({ status, head, body: data.slice(end + 4), conn });
      }
    };
    conn.on("data", onData);
    conn.on("end", () => {
      const end = data.indexOf("\r\n\r\n");
      const head = data.slice(0, end);
      resolve({
        status: Number(head.split(" ")[1]),
        head,
        body: data.slice(end + 4),
        conn,
      });
    });
    conn.on("error", reject);
  });
}

/** Writes through an open tunnel and waits for `expect` bytes back. */
function roundTrip(conn: net.Socket, text: string) {
  return new Promise<string>((resolve) => {
    let data = "";
    const onData = (d: Buffer) => {
      data += d.toString();
      if (data.length >= `echo:${text}`.length) {
        conn.off("data", onData);
        resolve(data);
      }
    };
    conn.on("data", onData);
    conn.write(text);
  });
}

/** A plain-HTTP proxy request (absolute form) through the Unix socket. */
function proxied(
  socket: string,
  url: string,
  init: {
    method?: string;
    body?: string;
    headers?: Record<string, string>;
  } = {},
) {
  return new Promise<{
    status: number;
    headers: http.IncomingHttpHeaders;
    body: string;
  }>((resolve, reject) => {
    const req = http.request(
      {
        socketPath: socket,
        method: init.method ?? "GET",
        path: url,
        headers: { host: new URL(url).host, ...(init.headers ?? {}) },
      },
      (res) => {
        let body = "";
        res.on("data", (d) => (body += d));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body }),
        );
      },
    );
    req.on("error", reject);
    req.end(init.body);
  });
}

const trusted: NetPolicy = {
  level: "trusted",
  trustedDomains: ["registry.npmjs.org", "github.com"],
};

describe("CONNECT", () => {
  test("an allowed name is tunnelled to the address that was checked", async () => {
    const echo = await echoServer();
    const h = harness(
      { "registry.npmjs.org": ["104.16.0.35", "104.16.1.35"] },
      echo.port,
    );
    const handle = h.proxy.open("chat-1", trusted, { socket: sockPath() });
    await handle.ready;
    const r = await connect(handle.socket!, "registry.npmjs.org:443");
    assert.equal(r.status, 200);
    const hello = clientHello("registry.npmjs.org");
    r.conn.write(hello);
    assert.equal(await roundTrip(r.conn, "hello"), "echo:hello");
    assert.deepEqual(h.dialled, ["104.16.0.35:443"]);
    const usage = handle.usage();
    assert.equal(usage.allowed, 1);
    assert.equal(usage.connections, 1);
    assert.equal(usage.bytesOut, hello.length + 5);
    assert.equal(usage.bytesIn, 10);
    r.conn.destroy();
    await h.proxy.closeAll();
    echo.server.close();
  });

  test("refusals: level, list, port, internal names and private answers", async () => {
    const echo = await echoServer();
    const h = harness(
      {
        "github.com": ["140.82.112.3"],
        "rebind.github.com": ["140.82.112.3", "10.0.0.7"],
        "meta.github.com": ["169.254.169.254"],
      },
      echo.port,
    );
    const handle = h.proxy.open("chat-2", trusted, { socket: sockPath() });
    await handle.ready;
    const cases: Array<[string, number, string]> = [
      ["evil.example.com:443", 403, "not-allowed"],
      ["github.com:22", 403, "port"],
      ["rebind.github.com:443", 403, "private"],
      ["meta.github.com:443", 403, "metadata"],
      ["missing.github.com:443", 502, "unresolved"],
      ["169.254.169.254:80", 403, "metadata"],
      ["[::1]:443", 403, "loopback"],
      ["localhost:443", 403, "internal-name"],
      ["nonsense", 400, "bad-host"],
    ];
    for (const [authority, status, reason] of cases) {
      const r = await connect(handle.socket!, authority);
      assert.equal(r.status, status, authority);
      assert.match(
        r.head,
        new RegExp(`X-Claudex-Egress: ${reason}`),
        authority,
      );
      r.conn.destroy();
    }
    assert.deepEqual(h.dialled, [], "nothing refused was ever dialled");
    assert.equal(handle.usage().denied, cases.length);
    assert.ok(
      h.logs.some((l) => /refused meta\.github\.com:443 \(metadata\)/.test(l)),
    );
    handle.update({ level: "none" });
    const off = await connect(handle.socket!, "github.com:443");
    assert.equal(off.status, 403);
    assert.match(off.body, /Network access is off for this environment\./);
    off.conn.destroy();
    await h.proxy.closeAll();
    echo.server.close();
  });

  test("DNS rebinding: every request resolves again and only checked addresses are dialled", async () => {
    const echo = await echoServer();
    let answer = ["140.82.112.3"];
    const h = harness({ "github.com": () => answer }, echo.port);
    const handle = h.proxy.open("chat-3", trusted, { socket: sockPath() });
    await handle.ready;
    const first = await connect(handle.socket!, "github.com:443");
    assert.equal(first.status, 200);
    first.conn.destroy();
    answer = ["127.0.0.1"];
    const second = await connect(handle.socket!, "github.com:443");
    assert.equal(second.status, 403);
    assert.match(second.head, /X-Claudex-Egress: loopback/);
    second.conn.destroy();
    answer = ["::ffff:192.168.1.1"];
    const third = await connect(handle.socket!, "github.com:443");
    assert.equal(third.status, 403);
    third.conn.destroy();
    assert.deepEqual(h.dialled, ["140.82.112.3:443"]);
    await h.proxy.closeAll();
    echo.server.close();
  });

  test("the connected peer is checked again", async () => {
    const echo = await echoServer();
    // The dial lands on 127.0.0.1 (as a hijacked route would); the peer check refuses it.
    const h = harness({ "github.com": ["140.82.112.3"] }, echo.port, {
      verifyPeer: true,
    });
    const handle = h.proxy.open("chat-4", trusted, { socket: sockPath() });
    await handle.ready;
    const r = await connect(handle.socket!, "github.com:443");
    assert.equal(r.status, 403);
    assert.match(r.head, /X-Claudex-Egress: loopback/);
    r.conn.destroy();
    await h.proxy.closeAll();
    echo.server.close();
  });

  test("tightening the policy closes tunnels it would not open", async () => {
    const echo = await echoServer();
    const h = harness({ "github.com": ["140.82.112.3"] }, echo.port);
    const handle = h.proxy.open("chat-5", trusted, { socket: sockPath() });
    await handle.ready;
    const r = await connect(handle.socket!, "github.com:443");
    assert.equal(r.status, 200);
    const closed = new Promise<void>((resolve) =>
      r.conn.on("close", () => resolve()),
    );
    handle.update({ level: "none" });
    await closed;
    assert.equal(handle.usage().connections, 0);
    await h.proxy.closeAll();
    echo.server.close();
  });

  test("the allowance stops the session until the next window", async () => {
    const echo = await echoServer();
    let clock = 1_000_000;
    const h = harness({ "github.com": ["140.82.112.3"] }, echo.port, {
      now: () => clock,
    });
    const handle = h.proxy.open(
      "chat-6",
      { ...trusted, maxBytes: 64 },
      { socket: sockPath() },
    );
    await handle.ready;
    const r = await connect(handle.socket!, "github.com:443");
    assert.equal(r.status, 200);
    const closed = new Promise<void>((resolve) =>
      r.conn.on("close", () => resolve()),
    );
    r.conn.write(clientHello("github.com"));
    r.conn.write("x".repeat(80));
    await closed;
    const again = await connect(handle.socket!, "github.com:443");
    assert.equal(again.status, 403);
    assert.match(again.head, /X-Claudex-Egress: allowance/);
    assert.match(again.body, /used up its network allowance/);
    again.conn.destroy();
    // The allowance is per window; the next window opens the network again.
    clock += 24 * 3_600_000;
    const next = await connect(handle.socket!, "github.com:443");
    assert.equal(next.status, 200);
    next.conn.destroy();
    assert.ok(handle.usage().bytesOut >= 80);
    await h.proxy.closeAll();
    echo.server.close();
  });

  test("connections per sandbox are limited", async () => {
    const echo = await echoServer();
    const h = harness({ "github.com": ["140.82.112.3"] }, echo.port, {
      maxConnections: 1,
    });
    const handle = h.proxy.open("chat-7", trusted, { socket: sockPath() });
    await handle.ready;
    const a = await connect(handle.socket!, "github.com:443");
    assert.equal(a.status, 200);
    const b = await connect(handle.socket!, "github.com:443");
    assert.equal(b.status, 503);
    a.conn.destroy();
    b.conn.destroy();
    await h.proxy.closeAll();
    echo.server.close();
  });

  test("the TLS server name must be allowed too (no fronting through a CDN)", async () => {
    const echo = await echoServer();
    const h = harness({ "registry.npmjs.org": ["104.16.0.35"] }, echo.port);
    const handle = h.proxy.open(
      "chat-15",
      { ...trusted, deniedHosts: ["claudex.example.com"] },
      { socket: sockPath() },
    );
    await handle.ready;
    const cut = async (payload: Buffer | string) => {
      const r = await connect(handle.socket!, "registry.npmjs.org:443");
      assert.equal(r.status, 200);
      let got = "";
      r.conn.on("data", (d) => (got += d));
      const closed = new Promise<void>((resolve) =>
        r.conn.on("close", () => resolve()),
      );
      r.conn.write(payload);
      r.conn.write("GET / HTTP/1.1\r\nHost: evil.example.com\r\n\r\n");
      await closed;
      return got;
    };
    // Another site on the same CDN address, and the Claudex service itself.
    assert.equal(await cut(clientHello("evil.example.com")), "");
    assert.equal(await cut(clientHello("claudex.example.com")), "");
    // Plain text (for example HTTP with another Host) is not a tunnel.
    assert.equal(
      await cut("GET / HTTP/1.1\r\nHost: evil.example.com\r\n\r\n"),
      "",
    );
    assert.equal(await cut(Buffer.from([0x16, 3, 1, 0, 4, 2, 0, 0, 0])), "");
    assert.ok(
      h.logs.some((l) =>
        /refused evil\.example\.com:443 \(not-allowed\)/.test(l),
      ),
    );
    assert.ok(
      h.logs.some((l) =>
        /refused claudex\.example\.com:443 \(denied-host\)/.test(l),
      ),
    );
    assert.ok(
      h.logs.some((l) =>
        /did not start with a TLS ClientHello \(not-tls\)/.test(l),
      ),
    );
    const usage = handle.usage();
    assert.equal(usage.allowed, 0);
    assert.equal(usage.denied, 4);
    assert.equal(usage.connections, 0);
    // An allowed name, split over two records and sent in pieces, passes.
    const r = await connect(handle.socket!, "registry.npmjs.org:443");
    const hello = clientHello("REGISTRY.npmjs.org.", 2);
    r.conn.write(hello.subarray(0, 3));
    await new Promise((resolve) => setTimeout(resolve, 20));
    r.conn.write(hello.subarray(3));
    assert.equal(await roundTrip(r.conn, "ok"), "echo:ok");
    r.conn.destroy();
    // A ClientHello without a server name reaches the checked address only.
    const bare = await connect(handle.socket!, "registry.npmjs.org:443");
    bare.conn.write(clientHello());
    assert.equal(await roundTrip(bare.conn, "ok"), "echo:ok");
    bare.conn.destroy();
    await h.proxy.closeAll();
    echo.server.close();
  });

  test("a tunnel that never sends its ClientHello is closed; full needs none", async () => {
    const echo = await echoServer();
    const h = harness({ "github.com": ["140.82.112.3"] }, echo.port, {
      helloTimeoutMs: 100,
    });
    const handle = h.proxy.open("chat-16", trusted, { socket: sockPath() });
    await handle.ready;
    const r = await connect(handle.socket!, "github.com:443");
    assert.equal(r.status, 200);
    await new Promise<void>((resolve) => r.conn.on("close", () => resolve()));
    assert.ok(h.logs.some((l) => /\(timeout\)/.test(l)));
    handle.update({ level: "full" });
    const full = await connect(handle.socket!, "github.com:443");
    assert.equal(full.status, 200);
    assert.equal(await roundTrip(full.conn, "plain"), "echo:plain");
    full.conn.destroy();
    await h.proxy.closeAll();
    echo.server.close();
  });

  test("an unreachable upstream is a 502", async () => {
    const h = harness({ "github.com": ["140.82.112.3"] }, 1, {
      connectTimeoutMs: 500,
    });
    const handle = h.proxy.open("chat-8", trusted, { socket: sockPath() });
    await handle.ready;
    const r = await connect(handle.socket!, "github.com:443");
    assert.equal(r.status, 502);
    assert.match(r.body, /github\.com:443 could not be reached/);
    r.conn.destroy();
    await h.proxy.closeAll();
  });
});

describe("plain HTTP", () => {
  test("absolute-form requests are forwarded without proxy headers", async () => {
    const web = await webServer();
    const h = harness({ "deb.debian.org": ["151.101.2.132"] }, web.port);
    const handle = h.proxy.open(
      "chat-9",
      { level: "trusted" },
      { socket: sockPath() },
    );
    await handle.ready;
    const r = await proxied(
      handle.socket!,
      "http://deb.debian.org/debian/dists?x=1",
      {
        method: "POST",
        body: "payload",
        headers: { "proxy-authorization": "Basic c2VjcmV0", "x-kept": "yes" },
      },
    );
    assert.equal(r.status, 200);
    assert.equal(r.body, "web:POST:/debian/dists?x=1:payload");
    assert.equal(web.seen[0]!.host, "deb.debian.org");
    assert.equal(web.seen[0]!["proxy-authorization"], undefined);
    assert.equal(web.seen[0]!["x-kept"], "yes");
    assert.deepEqual(h.dialled, ["151.101.2.132:80"]);
    assert.ok(handle.usage().bytesIn > 0 && handle.usage().bytesOut === 7);
    await h.proxy.closeAll();
    web.server.close();
  });

  test("refused and unsupported requests", async () => {
    const web = await webServer();
    const h = harness({ "deb.debian.org": ["151.101.2.132"] }, web.port);
    const handle = h.proxy.open(
      "chat-10",
      { level: "trusted" },
      { socket: sockPath() },
    );
    await handle.ready;
    const denied = await proxied(
      handle.socket!,
      "http://169.254.169.254/latest/meta-data/",
    );
    assert.equal(denied.status, 403);
    assert.equal(denied.headers["x-claudex-egress"], "metadata");
    const notListed = await proxied(handle.socket!, "http://example.com/");
    assert.equal(notListed.status, 403);
    assert.equal(notListed.headers["x-claudex-egress"], "not-allowed");
    const https = await proxied(handle.socket!, "https://deb.debian.org/");
    assert.equal(https.status, 400);
    const origin = await new Promise<number>((resolve) => {
      http
        .get({ socketPath: handle.socket!, path: "/relative" }, (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        })
        .on("error", () => resolve(0));
    });
    assert.equal(origin, 400);
    assert.equal(web.seen.length, 0);
    await h.proxy.closeAll();
    web.server.close();
  });
});

describe("listeners", () => {
  test("socket is private, re-used per sandbox, removed on close", async (t) => {
    const echo = await echoServer();
    const h = harness({ "github.com": ["140.82.112.3"] }, echo.port);
    t.after(async () => {
      await h.proxy.closeAll();
      echo.server.close();
    });
    const socket = sockPath();
    const handle = h.proxy.open("chat-11", trusted, { socket });
    // Bound before open() returns, so a launcher can bind it right away.
    assert.ok(fs.lstatSync(socket).isSocket());
    await handle.ready;
    assert.equal(fs.statSync(socket).mode & 0o777, 0o600);
    const same = h.proxy.open("chat-11", { level: "none" }, { socket });
    assert.equal(same.socket, socket);
    assert.equal(h.proxy.get("chat-11")!.policy().level, "none");
    await handle.close();
    assert.throws(() => fs.lstatSync(socket));
    // A listener opened on the same path while the old one is closing keeps its file.
    const reopened = h.proxy.open("chat-11", trusted, { socket });
    await reopened.ready;
    const closing = reopened.close();
    const successor = h.proxy.open("chat-11b", trusted, { socket });
    await closing;
    await successor.ready;
    assert.ok(fs.lstatSync(socket).isSocket());
    await successor.close();
    assert.equal(h.proxy.get("chat-11"), undefined);
  });

  test("a stale socket is replaced; any other file is left alone", async () => {
    const h = harness({}, 1);
    const stale = sockPath();
    fs.mkdirSync(path.dirname(stale), { recursive: true });
    // A crashed runner leaves its socket file behind.
    spawnSync(process.execPath, [
      "-e",
      `require("net").createServer().listen(${JSON.stringify(stale)}, () => process.kill(process.pid, "SIGKILL"))`,
    ]);
    assert.ok(fs.lstatSync(stale).isSocket());
    const handle = h.proxy.open("chat-12", trusted, { socket: stale });
    await handle.ready;
    const regular = path.join(base, "not-a-socket");
    fs.writeFileSync(regular, "keep me");
    assert.throws(
      () => h.proxy.open("chat-13", trusted, { socket: regular }),
      /not a socket/,
    );
    assert.equal(fs.readFileSync(regular, "utf8"), "keep me");
    await h.proxy.closeAll();
  });

  test("a TCP listener works the same way (for network-namespace setups)", async () => {
    const echo = await echoServer();
    const h = harness({ "github.com": ["140.82.112.3"] }, echo.port);
    const probe = net.createServer();
    await new Promise<void>((r) => probe.listen(0, "127.0.0.1", () => r()));
    const port = (probe.address() as net.AddressInfo).port;
    await new Promise<void>((r) => probe.close(() => r()));
    const handle = h.proxy.open("chat-14", trusted, {
      host: "127.0.0.1",
      port,
    });
    await handle.ready;
    const status = await new Promise<string>((resolve) => {
      const c = net.connect(port, "127.0.0.1", () =>
        c.write("CONNECT github.com:443 HTTP/1.1\r\n\r\n"),
      );
      c.once("data", (d) => {
        resolve(d.toString().split("\r\n")[0]!);
        c.destroy();
      });
    });
    assert.equal(status, "HTTP/1.1 200 Connection Established");
    await h.proxy.closeAll();
    echo.server.close();
  });

  test("the ClientHello parser reads what a real TLS client sends", async () => {
    const captured = await new Promise<Buffer>((resolve) => {
      const server = net.createServer((c) => {
        let data = Buffer.alloc(0);
        c.on("data", (d: Buffer) => {
          data = Buffer.concat([data, d]);
          if (parseClientHello(data).kind !== "more") {
            c.destroy();
            server.close();
            resolve(data);
          }
        });
      });
      server.listen(0, "127.0.0.1", () => {
        const port = (server.address() as net.AddressInfo).port;
        tls
          .connect({ host: "127.0.0.1", port, servername: "pypi.org" })
          .on("error", () => {});
      });
    });
    assert.deepEqual(parseClientHello(captured), {
      kind: "tls",
      serverName: "pypi.org",
    });
    for (let i = 0; i < captured.length - 1; i += 97)
      assert.equal(parseClientHello(captured.subarray(0, i)).kind, "more");
    assert.deepEqual(parseClientHello(Buffer.from("CONNECT")), {
      kind: "not-tls",
    });
    assert.deepEqual(parseClientHello(Buffer.from([0x17, 3, 3, 0, 1, 0])), {
      kind: "not-tls",
    });
    // Handshake type other than ClientHello, and a truncated extension list.
    assert.equal(
      parseClientHello(Buffer.from([0x16, 3, 1, 0, 4, 2, 0, 0, 0])).kind,
      "bad",
    );
    const broken = Buffer.from(clientHello("a.example.com"));
    broken.writeUInt16BE(
      broken.readUInt16BE(5 + 4 + 34 + 1 + 4 + 2) + 9,
      5 + 4 + 34 + 1 + 4 + 2,
    );
    assert.equal(parseClientHello(broken).kind, "bad");
  });

  test("helpers", () => {
    assert.deepEqual(parseAuthority("github.com:443"), {
      host: "github.com",
      port: 443,
    });
    assert.deepEqual(parseAuthority("[2606:4700::1]:8443"), {
      host: "2606:4700::1",
      port: 8443,
    });
    assert.equal(parseAuthority("github.com"), undefined);
    assert.equal(parseAuthority("github.com:0"), undefined);
    assert.equal(parseAuthority("a:b:443"), undefined);
    assert.equal(
      egressSocketPath("/var/lib/claudex-runner", "chat-42"),
      "/var/lib/claudex-runner/egress/chat-42.sock",
    );
    assert.equal(egressSocketPath("/s", "../x"), "/s/egress/.._x.sock");
  });
});

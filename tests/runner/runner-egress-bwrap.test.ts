// W-EGRESS: the egress proxy wired into a real bubblewrap sandbox.
//
// Linux only (skipped elsewhere): the sandbox's network namespace has no
// route out; its only path is the per-sandbox proxy socket bound in by the
// driver and bridged to 127.0.0.1:3128 (HTTPS_PROXY). Names resolve through a
// scripted resolver and "public" addresses are dialled to local servers, so
// the test needs no internet. Run it like the W-BWRAP tests, as an
// unprivileged user: `node --test tests/runner-egress-bwrap.test.ts`.
// Erasable TypeScript only, so plain Node can run this file too.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { chatSandboxSpec } from "../../runner/src/sandbox/sandbox-setup.ts";
import { BwrapDriver, checkBwrap } from "../../runner/src/sandbox/bwrap.ts";
import { EgressProxy } from "../../runner/src/egress-proxy.ts";

const repo = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const wrapper = path.join(repo, "runner/bin/sandbox-codex");
const real = process.platform === "linux" ? checkBwrap() : undefined;
const skip =
  !real?.ok &&
  `bubblewrap unavailable: ${real?.problems.join("; ") ?? process.platform}`;

describe("egress proxy in a real bubblewrap sandbox", { skip }, () => {
  const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "egb-"));
  after(() => fs.rmSync(base, { recursive: true, force: true }));
  let n = 0;
  const dir = (name: string) => {
    const d = path.join(base, `${name}${++n}`);
    fs.mkdirSync(d, { recursive: true });
    return d;
  };

  test("allowed names pass, private targets and direct routes do not", async () => {
    // Stands in for a TLS host: drops the leading ClientHello record and
    // echoes the rest.
    const tls = net.createServer((c) => {
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
    await new Promise<void>((r) => tls.listen(0, "127.0.0.1", () => r()));
    const web = http.createServer((req, res) =>
      res.end(`web:${req.url}:${req.headers.host}`),
    );
    await new Promise<void>((r) => web.listen(0, "127.0.0.1", () => r()));
    const local = (s: net.Server) => (s.address() as net.AddressInfo).port;
    const proxy = new EgressProxy({
      resolver: async (host) => {
        if (host === "allowed.example.org") return ["93.184.215.14"];
        if (host === "rebind.example.org") return ["10.0.0.9"];
        throw new Error("ENOTFOUND");
      },
      ownAddresses: () => [],
      connect: (_address, port) =>
        net.connect(port === 80 ? local(web) : local(tls), "127.0.0.1"),
      verifyPeer: false,
    });
    const handle = proxy.open(
      "chat-42",
      {
        level: "trusted",
        trustedDomains: ["allowed.example.org", "rebind.example.org"],
      },
      { socket: path.join(dir("eg"), "chat-42.sock") },
    );
    await handle.ready;

    const root = dir("u");
    const codexDir = dir("cx");
    const codexBinary = path.join(codexDir, "codex");
    fs.writeFileSync(
      codexBinary,
      `#!${process.execPath}
const net = require("net"), http = require("http");
const proxy = new URL(process.env.HTTPS_PROXY);
// A minimal TLS ClientHello naming the tunnel's host (the proxy checks it).
const hello = (name) => {
  const n = Buffer.from(name);
  const sni = Buffer.concat([Buffer.from([0, 0, 0, n.length + 5, 0, n.length + 3, 0, 0, n.length]), n]);
  const body = Buffer.concat([Buffer.from([3, 3]), Buffer.alloc(32, 7), Buffer.from([0, 0, 2, 0x13, 1, 1, 0, 0, sni.length]), sni]);
  const hs = Buffer.concat([Buffer.from([1, 0, 0, body.length]), body]);
  return Buffer.concat([Buffer.from([0x16, 3, 1, 0, hs.length]), hs]);
};
const connect = (authority, payload) => new Promise((resolve) => {
  const c = net.connect(Number(proxy.port), proxy.hostname, () => c.write("CONNECT " + authority + " HTTP/1.1\\r\\n\\r\\n"));
  let d = "", open = false;
  c.on("data", (x) => {
    d += x;
    if (!open && d.startsWith("HTTP/1.1 200")) { open = true; d = ""; c.write(hello(authority.split(":")[0])); c.write(payload); return; }
    if (open && d.length >= payload.length + 5) { c.destroy(); resolve("tunnel:" + d); }
  });
  c.on("end", () => resolve(d.split("\\r\\n")[0] + "|" + (/X-Claudex-Egress: (\\S+)/.exec(d) || [])[1]));
  c.on("error", (e) => resolve("ERR:" + e.code));
});
const get = (url) => new Promise((resolve) => {
  http.get({ host: proxy.hostname, port: Number(proxy.port), path: url, headers: { host: new URL(url).host } }, (r) => {
    let d = ""; r.on("data", (x) => (d += x)); r.on("end", () => resolve(r.statusCode + ":" + d));
  }).on("error", (e) => resolve("ERR:" + e.code));
});
const direct = (host, port) => new Promise((resolve) => {
  const c = net.connect(port, host, () => { c.destroy(); resolve("connected"); });
  c.on("error", (e) => resolve("ERR:" + e.code));
  setTimeout(() => { c.destroy(); resolve("timeout"); }, 3000);
});
(async () => {
  const res = { proxyEnv: process.env.HTTPS_PROXY };
  res.allowed = await connect("allowed.example.org:443", "hello");
  res.plain = await get("http://allowed.example.org/pkg");
  res.metadata = await connect("169.254.169.254:80", "x");
  res.notListed = await connect("evil.example.net:443", "x");
  res.rebind = await connect("rebind.example.org:443", "x");
  res.directPublic = await direct("1.1.1.1", 443);
  res.directMetadata = await direct("169.254.169.254", 80);
  process.stdout.write(JSON.stringify(res));
})();
`,
      { mode: 0o755 },
    );
    const spec = chatSandboxSpec({
      userId: 42,
      storeRoot: root,
      stateRoot: dir("st"),
      codexBinary,
      egressSocket: handle.socket,
    });
    const prepared = new BwrapDriver({
      wrapper,
      node: process.execPath,
    }).prepare(spec);
    const result = await new Promise<{
      code: number | null;
      out: string;
      err: string;
    }>((resolve) => {
      const child = spawn(prepared.binary, ["app-server"], {
        env: {
          PATH: "/usr/bin:/bin",
          CODEX_HOME: path.join(root, "codex-home"),
          CLAUDEX_GATEWAY_TOKEN: "loopback-capability",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "";
      let err = "";
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (err += d));
      child.on("exit", (code) => resolve({ code, out, err }));
    });
    prepared.dispose();
    await proxy.closeAll();
    tls.close();
    web.close();
    assert.equal(result.code, 0, result.err);
    const res = JSON.parse(result.out);
    assert.equal(res.proxyEnv, "http://127.0.0.1:3128");
    assert.equal(res.allowed, "tunnel:echo:hello");
    assert.equal(res.plain, "200:web:/pkg:allowed.example.org");
    assert.equal(res.metadata, "HTTP/1.1 403 Forbidden|metadata");
    assert.equal(res.notListed, "HTTP/1.1 403 Forbidden|not-allowed");
    assert.equal(res.rebind, "HTTP/1.1 403 Forbidden|private");
    assert.match(res.directPublic, /^ERR:|timeout/);
    assert.match(res.directMetadata, /^ERR:|timeout/);
    const usage = handle.usage();
    assert.equal(usage.allowed, 2);
    assert.equal(usage.denied, 3);
  });
});

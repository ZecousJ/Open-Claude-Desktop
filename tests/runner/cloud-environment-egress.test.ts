import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import http from "node:http";
import net from "node:net";
import test from "node:test";
import { EgressProxy } from "../../runner/src/egress-proxy";
import { proxyTunnel } from "../../runner/src/egress-tls";
import { compilePolicy } from "../../runner/src/net-policy-compile";

test("profile restrictions are checked before forwarding through an external proxy", async (context) => {
  let tunnels = 0;
  context.mock.method(http, "request", (options: http.RequestOptions) => {
    tunnels++;
    assert.equal(options.socketPath, "/run/egress.sock");
    assert.equal(options.method, "CONNECT");
    assert.equal(options.path, "example.com:443");
    const request = new EventEmitter() as any;
    request.destroy = () => {};
    request.end = () =>
      queueMicrotask(() =>
        request.emit(
          "connect",
          { statusCode: 200 },
          new net.Socket(),
          Buffer.alloc(0),
        ),
      );
    return request;
  });
  const proxy = new EgressProxy({
    upstreamSocket: "/run/egress.sock",
    resolver: async () => ["93.184.215.14"],
    ownAddresses: () => [],
  });
  const session = {
    id: "cloud",
    compiled: compilePolicy({
      level: "full",
      restriction: {
        level: "custom",
        trustedDomains: [],
        customDomains: ["example.com"],
      },
    }),
    closed: false,
    open: new Map(),
    windowStart: Date.now(),
    windowBytes: 0,
    usage: { bytesIn: 0, bytesOut: 0, connections: 0, allowed: 0, denied: 0 },
  };
  const refused = await (proxy as any).dial(session, "other.example", 443);
  assert.equal(refused.ok, false);
  assert.equal(tunnels, 0);
  const allowed = await (proxy as any).dial(session, "example.com", 443);
  assert.equal(allowed.ok, true);
  assert.equal(tunnels, 1);
  allowed.upstream.destroy();
  session.compiled = compilePolicy({
    level: "full",
    restriction: { level: "none" },
  });
  assert.equal(
    (await (proxy as any).dial(session, "example.com", 443)).ok,
    false,
  );
  assert.equal(tunnels, 1);
});

test("external tunnel failures and timeouts fail closed", async (context) => {
  const sockets: net.Socket[] = [];
  let status = 403;
  context.mock.method(http, "request", () => {
    const request = new EventEmitter() as any;
    request.destroy = () => {};
    request.end = () => {
      if (!status) return;
      const socket = new net.Socket();
      sockets.push(socket);
      queueMicrotask(() =>
        request.emit(
          "connect",
          { statusCode: status, statusMessage: "Forbidden" },
          socket,
          Buffer.alloc(0),
        ),
      );
    };
    return request;
  });
  await assert.rejects(
    proxyTunnel("/run/egress.sock", "example.com", 443, 100),
    /Forbidden/,
  );
  assert.equal(sockets[0].destroyed, true);
  status = 0;
  await assert.rejects(
    proxyTunnel("/run/egress.sock", "example.com", 443, 1),
    /connection timed out/,
  );
});

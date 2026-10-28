/**
 * The runner link (runner/src/control-link.ts) against a real WebSocket
 * server: token header, sub-protocol, hello/welcome, calls, requests,
 * heartbeats and reconnects.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { webCloseCodes } from "../../shared/web-protocol";
import { parseRunnerFrame, type GoFrame } from "../../shared/web-runner-frames";
import { ControlLink, linkUrl } from "../../runner/src/control-link";
import { wsServer, type TestSocket } from "./runner-core-support.test.ts";

const until = async (check: () => boolean, ms = 3000) => {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
};

test("the link URL is the service's runner/link path over ws(s)", () => {
  assert.equal(
    linkUrl("https://claudex.example.com"),
    "wss://claudex.example.com/api/v1/claudex/web/runner/link",
  );
  assert.equal(
    linkUrl("http://127.0.0.1:8080/"),
    "ws://127.0.0.1:8080/api/v1/claudex/web/runner/link",
  );
  assert.throws(() => linkUrl("ftp://x"));
});

test("hello, welcome, calls, requests and pings over a real socket", async () => {
  const sockets: TestSocket[] = [];
  const received: any[] = [];
  const server = await wsServer((socket) => {
    sockets.push(socket);
    socket.onText = (text) => {
      const frame = parseRunnerFrame(text);
      received.push(frame);
      if (frame.t === "hello")
        socket.send(
          JSON.stringify({
            t: "welcome",
            v: 1,
            runnerId: "r-1",
            heartbeatMs: 1000,
          }),
        );
      if (frame.t === "request")
        socket.send(
          JSON.stringify(
            frame.op === "store.settings.get"
              ? {
                  t: "response",
                  id: frame.id,
                  ok: true,
                  value: { settings: null },
                }
              : {
                  t: "response",
                  id: frame.id,
                  ok: false,
                  error: {
                    message: "nope",
                    code: "CLAUDEX_WEB_METHOD_UNAVAILABLE",
                  },
                },
          ),
        );
    };
  });
  const calls: GoFrame[] = [];
  const signedOut: GoFrame[] = [];
  let downs = 0;
  const link = new ControlLink({
    serviceUrl: server.url,
    token: "runner-token-0123456789",
    version: "9.9.9",
    methods: () => ["snapshot", "send"],
    capacity: () => ({ engines: 1, users: 4 }),
    labels: { host: "dc6" },
    load: () => ({ engines: 0, users: 0, rssMb: 42 }),
    log: () => {},
    random: () => 0,
    handlers: {
      call: (frame) => calls.push(frame),
      signedOut: (frame) => signedOut.push(frame),
      down: () => downs++,
    },
  });
  link.start();
  try {
    await until(() => link.connected);
    // The token rides in the Authorization header, never in the URL.
    assert.equal(
      sockets[0]!.headers.authorization,
      "Bearer runner-token-0123456789",
    );
    assert.equal(
      sockets[0]!.headers["sec-websocket-protocol"],
      "claudex.runner.v1",
    );
    assert.deepEqual(received[0], {
      t: "hello",
      v: 1,
      version: "9.9.9",
      methods: ["snapshot", "send"],
      capacity: { engines: 1, users: 4 },
      labels: { host: "dc6" },
    });
    assert.equal(link.runnerId, "r-1");
    await until(() => received.some((f) => f.t === "load"));

    assert.deepEqual(await link.request("store.settings.get", 5, {}), {
      settings: null,
    });
    await assert.rejects(link.request("key.get", 5, {}), {
      message: "nope",
      code: "CLAUDEX_WEB_METHOD_UNAVAILABLE",
    });
    const request = received.find((f) => f.t === "request");
    assert.equal(request.userId, 5);

    sockets[0]!.send(
      JSON.stringify({
        t: "call",
        id: "c1",
        user: { id: 5, accessToken: "at" },
        method: "snapshot",
        args: [],
        deadlineMs: 1000,
      }),
    );
    sockets[0]!.send(
      JSON.stringify({ t: "user-signed-out", userId: 5, reason: "revoked" }),
    );
    sockets[0]!.send(JSON.stringify({ t: "ping" }));
    await until(() => calls.length === 1 && signedOut.length === 1);
    await until(() => received.some((f) => f.t === "pong"));
    // Pings go out on the heartbeat.
    await until(() => received.some((f) => f.t === "ping"), 3000);

    // The service drops the link: the runner dials again and says hello.
    sockets[0]!.close(webCloseCodes.goingAway);
    await until(() => sockets.length === 2 && link.connected, 5000);
    assert.equal(downs, 1);
    assert.equal(received.filter((f) => f.t === "hello").length, 2);
  } finally {
    link.stop();
    await server.close();
  }
});

test("a request while the link is down fails right away", async () => {
  const link = new ControlLink({
    serviceUrl: "http://127.0.0.1:1",
    token: "runner-token-0123456789",
    version: "1",
    methods: () => [],
    capacity: () => ({ engines: 1, users: 1 }),
    handlers: { call: () => {} },
    log: () => {},
  });
  await assert.rejects(link.request("key.get", 1), {
    code: "CLAUDEX_WEB_RUNNER_UNAVAILABLE",
  });
  assert.equal(link.send({ t: "ping" }), false);
});

test("a frame that breaks the protocol closes the link", async () => {
  const closes: number[] = [];
  const fakeSockets: any[] = [];
  const link = new ControlLink({
    serviceUrl: "http://127.0.0.1:9",
    token: "runner-token-0123456789",
    version: "1",
    methods: () => [],
    capacity: () => ({ engines: 1, users: 1 }),
    handlers: { call: () => {} },
    log: () => {},
    socket: () => {
      const socket: any = {
        send() {},
        close(code: number) {
          closes.push(code);
        },
        onopen: null,
        onmessage: null,
        onclose: null,
        onerror: null,
      };
      fakeSockets.push(socket);
      return socket;
    },
  });
  link.start();
  fakeSockets[0].onopen();
  fakeSockets[0].onmessage({ data: '{"t":"call","id":"x"}' });
  assert.deepEqual(closes, [webCloseCodes.protocolError]);
  link.stop();
});

test("a link Go never welcomes is dialled again", async () => {
  let sockets = 0;
  const server = await wsServer(() => {
    sockets++;
  });
  const link = new ControlLink({
    serviceUrl: server.url,
    token: "runner-token-0123456789",
    version: "9.9.9",
    methods: () => [],
    capacity: () => ({ engines: 1, users: 1 }),
    welcomeTimeoutMs: 100,
    log: () => {},
    random: () => 0,
    handlers: { call: () => {} },
  });
  link.start();
  try {
    await until(() => sockets >= 2, 5000);
    assert.equal(link.connected, false);
  } finally {
    link.stop();
    await server.close();
  }
});

test("a dial whose socket never opens is dialled again", async () => {
  const dials: any[] = [];
  const link = new ControlLink({
    serviceUrl: "https://claudex.example",
    token: "runner-token-0123456789",
    version: "9.9.9",
    methods: () => [],
    capacity: () => ({ engines: 1, users: 1 }),
    openTimeoutMs: 50,
    log: () => {},
    random: () => 0,
    handlers: { call: () => {} },
    // A socket that neither opens nor closes, as during a lost SYN.
    socket: () => {
      const socket: any = {
        send() {},
        close() {},
        onopen: null,
        onmessage: null,
        onclose: null,
        onerror: null,
      };
      dials.push(socket);
      return socket;
    },
  });
  link.start();
  try {
    await until(() => dials.length >= 2, 5000);
    assert.equal(link.connected, false);
  } finally {
    link.stop();
  }
});

test("a link that goes silent after welcome is dialled again", async () => {
  let sockets = 0;
  const server = await wsServer((socket) => {
    sockets++;
    socket.onText = (text) => {
      if (parseRunnerFrame(text).t === "hello")
        socket.send(
          JSON.stringify({
            t: "welcome",
            v: 1,
            runnerId: "r-1",
            heartbeatMs: 100,
          }),
        );
      // Pings are never answered: the link goes silent.
    };
  });
  const link = new ControlLink({
    serviceUrl: server.url,
    token: "runner-token-0123456789",
    version: "9.9.9",
    methods: () => [],
    capacity: () => ({ engines: 1, users: 1 }),
    log: () => {},
    random: () => 0,
    handlers: { call: () => {} },
  });
  link.start();
  try {
    await until(() => sockets >= 2, 5000);
  } finally {
    link.stop();
    await server.close();
  }
});

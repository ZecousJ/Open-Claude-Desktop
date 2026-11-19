/**
 * The runner link (runner/src/control-link.ts) against a real WebSocket
 * server: token header, sub-protocol, hello/welcome, calls, requests,
 * heartbeats and reconnects.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import zlib from "node:zlib";
import type { AppEvent, Conversation } from "../../shared/types";
import { webCloseCodes, webLimits } from "../../shared/web-protocol";
import {
  parseRunnerFrame,
  runnerChunkBytes,
  type GoFrame,
} from "../../shared/web-runner-frames";
import {
  ControlLink,
  linkUrl,
  type LinkSocket,
} from "../../runner/src/control-link";
import { EventHub } from "../../runner/src/event-hub";
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

const welcome = JSON.stringify({
  t: "welcome",
  v: 1,
  runnerId: "r-1",
  heartbeatMs: 25_000,
});

test("large events and results arrive whole and in order over the socket", async (t) => {
  const received: string[] = [];
  const server = await wsServer((socket) => {
    socket.onText = (text) => {
      if (text.startsWith('{"t":"hello",')) socket.send(welcome);
      else received.push(text);
    };
  });
  const link = new ControlLink({
    serviceUrl: server.url,
    token: "runner-token-0123456789",
    version: "1",
    methods: () => ["snapshot"],
    capacity: () => ({ engines: 1, users: 1 }),
    handlers: { call: () => {} },
  });
  t.after(async () => {
    link.stop();
    await server.close();
  });
  link.start();
  await until(() => link.connected);

  const conversation: Conversation = {
    id: "conversation",
    title: "Full history",
    mode: "chat",
    providerId: "provider",
    model: "model",
    pinned: false,
    archived: false,
    createdAt: 0,
    updatedAt: 0,
    turns: [],
  };
  const text = randomBytes(2 * 1024 * 1024).toString("base64") + "\n你好 🌏";
  for (let i = 0; i < 9; i++)
    conversation.turns.push({
      id: `turn-${i}`,
      prompt: "Keep the full output",
      attachments: [],
      items: [
        {
          id: `item-${i}`,
          type: "agentMessage",
          text,
          generatedFiles: [
            {
              id: "report",
              name: "report.md",
              path: "/workspace/report.md",
              language: "markdown",
              operation: "create",
              state: "ready",
              content: "# Report\nUntouched artifact contents.\n",
            },
          ],
        },
      ],
      status: "completed",
      createdAt: i,
    });

  const event: AppEvent = { type: "conversation", conversation };
  const result = {
    t: "result",
    id: "snapshot",
    ok: true,
    value: { conversations: [conversation] },
  } satisfies Parameters<ControlLink["send"]>[0];
  const hub = new EventHub({ sink: link });
  hub.publish(1, event);
  hub.flush(1);
  assert.deepEqual(hub.counts, { sent: 1, dropped: 0 });
  assert.equal(link.send(result), true);
  assert.equal(link.send({ t: "pong" }), true);
  await until(() => received.at(-1) === '{"t":"pong"}', 10_000);

  const expected = [
    Buffer.from(JSON.stringify({ t: "event", userId: 1, event })),
    Buffer.from(JSON.stringify(result)),
  ];
  let message = 0;
  let offset = 0;
  let parts: Buffer[] = [];
  for (const text of received.slice(0, -1)) {
    assert.ok(Buffer.byteLength(text) <= webLimits.linkFrameBytes);
    const chunk = parseRunnerFrame(text);
    assert.equal(chunk.t, "chunk");
    assert.equal(chunk.encoding, "gzip");
    assert.equal(chunk.offset, offset);
    const original = expected[message];
    assert.ok(original);
    assert.equal(chunk.decodedBytes, original.length);
    assert.ok(chunk.totalBytes < original.length);
    const bytes = Buffer.from(chunk.data, "base64");
    parts.push(bytes);
    offset += bytes.length;
    if (offset === chunk.totalBytes) {
      assert.ok(parts.length > 1);
      assert.ok(zlib.gunzipSync(Buffer.concat(parts)).equals(original));
      message++;
      offset = 0;
      parts = [];
    }
  }
  assert.equal(message, expected.length);
  assert.equal(offset, 0);
});

function inMemoryLink(send: LinkSocket["send"]) {
  const socket: LinkSocket = {
    send,
    close() {},
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
  };
  const link = new ControlLink({
    serviceUrl: "http://127.0.0.1:1",
    token: "runner-token-0123456789",
    version: "1",
    methods: () => [],
    capacity: () => ({ engines: 1, users: 1 }),
    handlers: { call: () => {} },
    socket: () => socket,
  });
  link.start();
  socket.onopen?.();
  socket.onmessage?.({ data: welcome });
  return link;
}

test("conversation text around 2 MiB arrives whole in smaller result and event frames", async (t) => {
  const frames: string[] = [];
  const server = await wsServer((socket) => {
    socket.onText = (text) => {
      if (text.startsWith('{"t":"hello",')) socket.send(welcome);
      else frames.push(text);
    };
  });
  const link = new ControlLink({
    serviceUrl: server.url,
    token: "runner-token-0123456789",
    version: "1",
    methods: () => ["snapshot"],
    capacity: () => ({ engines: 1, users: 1 }),
    handlers: { call: () => {} },
  });
  t.after(async () => {
    link.stop();
    await server.close();
  });
  link.start();
  await until(() => link.connected);
  const text = "The conversation keeps its full history. 你好 🌏\n".repeat(
    41_000,
  );
  const messages: Parameters<ControlLink["send"]>[0][] = [
    { t: "result", id: "snapshot", ok: true, value: { text } },
    {
      t: "event",
      userId: 1,
      event: {
        type: "side-chat-text",
        conversationId: "conversation",
        sideChatId: "side-chat",
        text,
      },
    },
  ];
  for (const message of messages) {
    frames.length = 0;
    const original = Buffer.from(JSON.stringify(message));
    assert.equal(link.send(message), true);
    assert.equal(link.send({ t: "pong" }), true);
    await until(() => frames.at(-1) === '{"t":"pong"}');
    frames.pop();
    let offset = 0;
    const parts = frames.map((frame) => {
      const chunk = parseRunnerFrame(frame);
      assert.equal(chunk.t, "chunk");
      assert.equal(chunk.encoding, "gzip");
      assert.equal(chunk.offset, offset);
      assert.equal(chunk.decodedBytes, original.length);
      const bytes = Buffer.from(chunk.data, "base64");
      offset += bytes.length;
      return bytes;
    });
    assert.ok(zlib.gunzipSync(Buffer.concat(parts)).equals(original));
    const wireBytes = frames.reduce(
      (sum, frame) => sum + Buffer.byteLength(frame),
      0,
    );
    assert.ok(wireBytes < original.length / 10);
  }
});

test("a medium payload that grows with base64 is sent directly", (t) => {
  const frames: string[] = [];
  const link = inMemoryLink((text) => frames.push(text));
  t.after(() => link.stop());
  const result = {
    t: "result",
    id: "random-data",
    ok: true,
    value: randomBytes(384 * 1024).toString("base64"),
  } satisfies Parameters<ControlLink["send"]>[0];
  const expected = JSON.stringify(result);
  const compressed = zlib.gzipSync(expected, { level: 1 });
  assert.ok(compressed.length < Buffer.byteLength(expected));
  assert.ok(compressed.toString("base64").length > Buffer.byteLength(expected));
  frames.length = 0;
  assert.equal(link.send(result), true);
  assert.deepEqual(frames, [expected]);
});

test("small conversation updates repeat unchanged and oversize messages send nothing", (t) => {
  const event: AppEvent = {
    type: "side-chat-text",
    conversationId: "conversation",
    sideChatId: "side-chat",
    text: "a".repeat(12_102),
  };
  const expected = JSON.stringify({ t: "event", userId: 1, event });
  let frames = 0;
  let unchanged = true;
  const link = inMemoryLink((text) => {
    if (text.startsWith('{"t":"hello",')) return;
    frames++;
    unchanged &&= text === expected;
  });
  t.after(() => link.stop());
  const hub = new EventHub({ sink: link, log: () => {} });
  for (let i = 0; i < 2; i++) {
    hub.publish(1, event);
    hub.flush(1);
  }
  assert.equal(frames, 2);
  const oversized = "a".repeat(webLimits.linkMessageBytes);
  assert.equal(
    link.send({ t: "result", id: "large", ok: true, value: oversized }),
    false,
  );
  hub.publish(1, { ...event, text: oversized });
  hub.flush(1);
  assert.deepEqual(hub.counts, { sent: 2, dropped: 1 });
  assert.equal(frames, 2);
  assert.equal(unchanged, true);
});

test("identity chunks can split a UTF-8 character without changing the result", (t) => {
  const frames: string[] = [];
  const link = inMemoryLink((text) => frames.push(text));
  t.after(() => link.stop());

  const result = {
    t: "result",
    id: "identity",
    ok: true,
    value: "",
  } satisfies Parameters<ControlLink["send"]>[0];
  const prefix = JSON.stringify(result).length - 2;
  result.value =
    "a".repeat(runnerChunkBytes - prefix - 1) +
    "🌏" +
    "b".repeat(webLimits.linkFrameBytes);

  const compression = t.mock.method(zlib, "gzipSync", (body: Buffer) => body);
  syncBuiltinESMExports();
  try {
    assert.equal(link.send(result), true);
  } finally {
    compression.mock.restore();
    syncBuiltinESMExports();
  }
  let offset = 0;
  const expected = Buffer.from(JSON.stringify(result));
  const parts = frames.slice(1).map((text) => {
    const chunk = parseRunnerFrame(text);
    assert.equal(chunk.t, "chunk");
    assert.equal(chunk.encoding, "identity");
    assert.equal(chunk.offset, offset);
    assert.equal(chunk.totalBytes, expected.length);
    assert.equal(chunk.decodedBytes, expected.length);
    const part = Buffer.from(chunk.data, "base64");
    offset += part.length;
    return part;
  });
  assert.equal(parts[0]?.at(-1), 0xf0);
  assert.ok(Buffer.concat(parts).equals(expected));
});

test("a failed chunk send closes the connection before another message", (t) => {
  let chunkSends = 0;
  const link = inMemoryLink((text) => {
    if (text.startsWith('{"t":"chunk",') && ++chunkSends === 2)
      throw new Error("socket failed");
  });
  t.after(() => link.stop());
  const compression = t.mock.method(zlib, "gzipSync", (body: Buffer) => body);
  syncBuiltinESMExports();
  try {
    assert.equal(
      link.send({
        t: "result",
        id: "interrupted",
        ok: true,
        value: "a".repeat(webLimits.linkFrameBytes),
      }),
      false,
    );
  } finally {
    compression.mock.restore();
    syncBuiltinESMExports();
  }
  assert.equal(chunkSends, 2);
  assert.equal(link.connected, false);
  assert.equal(link.send({ t: "pong" }), false);
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

import test from "node:test";
import assert from "node:assert/strict";
import type { AppEvent } from "../../shared/types";
import { webPaths } from "../../shared/web-protocol";
import {
  CloudClient,
  type CloudSession,
} from "../../electron/cloud/cloud-client";
import {
  FakeClock,
  FakeSocket,
  flush,
  json,
} from "../app/web-bridge-fakes.test.ts";

const origin = "https://claudex.example.com";

interface Sent {
  url: string;
  method: string;
  headers: Headers;
  body: string;
}

function setup(route: (sent: Sent) => Response) {
  const clock = new FakeClock();
  const sent: Sent[] = [];
  const sockets: FakeSocket[] = [];
  const signedOut: string[] = [];
  let token = "at-1";
  let renewals = 0;
  const session: CloudSession = {
    currentToken: async () => token,
    renewed: async (stale) => {
      if (stale === token) token = `at-${++renewals + 1}`;
      return token;
    },
  };
  let signedIn = true;
  const client = new CloudClient({
    baseUrl: `${origin}/some/path`,
    session: () => (signedIn ? session : undefined),
    signedOut: (reason) => signedOut.push(reason),
    randomId: () => "tab-desktop-1",
    fetch: async (input, init) => {
      const request = {
        url: String(input),
        method: init?.method ?? "GET",
        headers: new Headers(init?.headers),
        body: typeof init?.body === "string" ? init.body : "",
      };
      sent.push(request);
      return route(request);
    },
    openSocket: (url, protocols) => {
      const socket = new FakeSocket(url, protocols);
      sockets.push(socket);
      return socket;
    },
    timers: {
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clear,
      setInterval: clock.setInterval,
      clearInterval: clock.clear,
    },
    now: () => clock.now,
  });
  return {
    client,
    sent,
    sockets,
    signedOut,
    clock,
    signOut: () => (signedIn = false),
    get renewals() {
      return renewals;
    },
  };
}

test("a cloud call posts to the relay with the account token and the desktop's tab", async () => {
  const t = setup(() => json({ ok: true, value: { id: "conv-1" } }));
  const value = await t.client.call("pinConversation", ["conv-1", true]);
  assert.deepEqual(value, { id: "conv-1" });
  const [request] = t.sent;
  assert.equal(request.url, `${origin}${webPaths.rpc}pinConversation`);
  assert.equal(request.method, "POST");
  assert.equal(request.headers.get("Authorization"), "Bearer at-1");
  assert.equal(request.headers.get("X-Claudex-Web-Tab"), "tab-desktop-1");
  assert.deepEqual(JSON.parse(request.body), { args: ["conv-1", true] });
});

test("a refused token is renewed once and the call repeated", async () => {
  const t = setup((sent) =>
    sent.headers.get("Authorization") === "Bearer at-1"
      ? json({ code: 401, reason: "TOKEN_EXPIRED" }, 401)
      : json({ ok: true, value: 7 }),
  );
  assert.equal(await t.client.call("snapshotCount"), 7);
  assert.equal(t.renewals, 1);
  assert.equal(t.sent.length, 2);
  assert.equal(t.sent[1].headers.get("Authorization"), "Bearer at-2");
});

test("signed out, a call fails without reaching the service", async () => {
  const t = setup(() => json({ ok: true, value: 1 }));
  t.signOut();
  await assert.rejects(t.client.call("snapshot"));
  assert.equal(t.sent.length, 0);
});

test("the snapshot keeps the event number Go answered", async () => {
  const t = setup(() =>
    json({ ok: true, value: { conversations: [] } }, 200, {
      "X-Claudex-Event-Seq": "41",
    }),
  );
  const { snapshot, eventSeq } = await t.client.snapshot();
  assert.deepEqual(snapshot, { conversations: [] });
  assert.equal(eventSeq, 41);
});

test("the event stream takes a ticket with the web headers, says hello and delivers events", async () => {
  const t = setup((sent) =>
    sent.url.endsWith("/auth/events-ticket")
      ? json({
          code: 0,
          data: {
            ticket: "q3Zb8m1Yc0Xh2Kp9Lr4Tn6Vw7Sd5Fg0Jk1Hl2Mz3Nx_",
            expires_in: 30,
          },
        })
      : json({ ok: true, value: null }),
  );
  const events: AppEvent[] = [];
  t.client.onEvent((event) => events.push(event));
  t.client.start();
  await flush();
  const ticket = t.sent[0];
  assert.equal(ticket.url, `${origin}${webPaths.auth}events-ticket`);
  assert.equal(ticket.headers.get("X-Claudex-Web"), "1");
  assert.equal(ticket.headers.get("Origin"), origin);
  assert.equal(ticket.headers.get("Authorization"), "Bearer at-1");
  assert.deepEqual(JSON.parse(ticket.body), { tabId: "tab-desktop-1" });

  const [socket] = t.sockets;
  assert.equal(socket.url, "wss://claudex.example.com" + webPaths.events);
  assert.ok(socket.protocols.includes("claudex.v1"));
  socket.open();
  assert.equal(socket.frames()[0].t, "hello");
  assert.equal(socket.frames()[0].tabId, "tab-desktop-1");
  socket.receive({ t: "ready", v: 1, seq: 5, resumed: false });
  socket.receive({
    t: "event",
    seq: 6,
    event: { type: "engine", engine: { state: "ready" } },
  });
  assert.deepEqual(events, [{ type: "engine", engine: { state: "ready" } }]);
  assert.ok(t.client.connected);
  t.client.stop();
});

test("a signed-out close ends the cloud session and stops the stream", async () => {
  const t = setup(() =>
    json({
      code: 0,
      data: {
        ticket: "q3Zb8m1Yc0Xh2Kp9Lr4Tn6Vw7Sd5Fg0Jk1Hl2Mz3Nx_",
        expires_in: 30,
      },
    }),
  );
  t.client.start();
  await flush();
  const [socket] = t.sockets;
  socket.open();
  socket.receive({ t: "error", code: "revoked", message: "Signed out." });
  socket.drop(4008);
  assert.deepEqual(t.signedOut, ["revoked"]);
  assert.equal(t.client.connected, false);
});

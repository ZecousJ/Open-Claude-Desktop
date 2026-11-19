import assert from "node:assert/strict";
import test from "node:test";
import { webHost } from "../../shared/host";
import type { Snapshot } from "../../shared/types";
import { webMethodTable } from "../../shared/web-bridge-methods";
import { inlineBytes } from "../../shared/web-client/codec";
import { json, signedInBridge } from "./web-bridge-fakes.test.ts";

const path = (url: string) => new URL(url, "https://claudex.example").pathname;

test("an old official request cannot replay with the replacement account's token", async (t) => {
  const { bridge, tab, service } = await signedInBridge();
  t.after(() => bridge.dispose());
  let started!: () => void;
  let refuse!: () => void;
  const sent = new Promise<void>((resolve) => { started = resolve; });
  const held = new Promise<void>((resolve) => { refuse = resolve; });
  const tokens: (string | null)[] = [];
  tab.routes.unshift(async (request) => {
    if (!path(request.url).endsWith("/rpc/officialUiRead")) return;
    tokens.push(request.headers.get("authorization"));
    if (tokens.length === 1) { started(); await held; }
    return json({ ok: false, error: { message: "Unauthorized" } }, 401);
  });
  const pending = bridge.officialUiRead({ method: "GET", path: "/api/account" });
  const check = assert.rejects(pending, { name: "AbortError" });
  await sent;
  service.valid.add("account-b");
  await bridge.auth.adopt({ access_token: "account-b", expires_in: 3600,
    account: { id: "43", email: "b@example.invalid", name: "B" } });
  refuse();
  await check;
  assert.deepEqual(tokens, ["Bearer at-1"]);
  assert.equal(bridge.auth.current?.account.id, "43");
});

test("a shared read under a new activation does not join the old account's request", async (t) => {
  let started!: () => void;
  let release!: () => void;
  const sent = new Promise<void>((resolve) => { started = resolve; });
  const held = new Promise<void>((resolve) => { release = resolve; });
  let reads = 0;
  const { bridge, service } = await signedInBridge(async (method) => {
    if (method !== "modelCatalog") return null;
    if (++reads === 1) { started(); await held; return "A"; }
    return "B";
  });
  t.after(() => bridge.dispose());
  const pending = bridge.api.modelCatalog();
  const check = assert.rejects(pending, { name: "AbortError" });
  await sent;
  service.valid.add("account-b");
  await bridge.auth.adopt({ access_token: "account-b", expires_in: 3600,
    account: { id: "43", email: "b@example.invalid", name: "B" } });
  const next = bridge.api.modelCatalog();
  release();
  assert.equal(await next, "B");
  await check;
  assert.equal(reads, 2);
});

test("a call is a Bearer RPC with the tab's id and wire-encoded arguments", async () => {
  const { bridge, calls } = await signedInBridge((method, args) => ({
    method,
    echoed: args,
  }));
  const result = await bridge.api.updateConversation("c-1", { pinned: true });
  assert.deepEqual(result, {
    method: "updateConversation",
    echoed: ["c-1", { pinned: true }],
  });
  const { request } = calls[0]!;
  assert.equal(path(request.url), "/api/v1/claudex/web/rpc/updateConversation");
  assert.equal(request.method, "POST");
  assert.equal(request.headers.get("authorization"), "Bearer at-1");
  assert.match(request.headers.get("x-claudex-web-tab")!, /^id-\d{8}$/);
  assert.equal(request.headers.get("x-claudex-client"), "web");
  assert.deepEqual(request.body, { args: ["c-1", { pinned: true }] });
});

test("bytes travel as $bytes and come back as Uint8Array", async () => {
  const { bridge, calls } = await signedInBridge(() => ({
    id: "a-1",
    name: "x.txt",
    path: "",
    kind: "text",
    size: 3,
  }));
  await bridge.api.addAttachmentData("x.txt", new Uint8Array([1, 2, 3]));
  assert.deepEqual(calls[0]!.request.body, {
    args: ["x.txt", { $bytes: "AQID" }],
  });
  assert.deepEqual(calls[0]!.args[1], new Uint8Array([1, 2, 3]));
});

test("a refused token is refreshed once and the call repeated", async () => {
  const { bridge, service, calls } = await signedInBridge(() => "done");
  service.valid.clear(); // at-1 revoked server-side
  assert.equal(await bridge.api.clientPolicy(), "done");
  assert.equal(service.refreshes, 2);
  assert.equal(
    calls.at(-1)!.request.headers.get("authorization"),
    "Bearer at-2",
  );
});

test("a session the service ended signs the window out", async () => {
  const { bridge, service, events } = await signedInBridge(() => "done");
  service.signOut();
  await assert.rejects(bridge.api.clientPolicy(), /Your session has expired/);
  const signedOut = events.filter((e) => e.type === "signed-out");
  assert.equal(signedOut.length, 1);
  assert.equal(bridge.auth.current, undefined);
});

test("handler errors keep their message, code and details", async () => {
  const { bridge } = await signedInBridge(() => {
    throw Object.assign(new Error("You've reached your usage limit."), {
      code: "CLAUDEX_USAGE_LIMIT",
    });
  });
  await assert.rejects(bridge.api.send({} as any), (error: any) => {
    assert.equal(error.message, "You've reached your usage limit.");
    assert.equal(error.code, "CLAUDEX_USAGE_LIMIT");
    return true;
  });
});

test("Go's own refusals and proxy pages become plain messages", async () => {
  const { bridge, tab } = await signedInBridge();
  tab.routes.unshift((request) => {
    if (path(request.url).endsWith("/rpc/usageSummary"))
      return json(
        {
          ok: false,
          error: {
            message: "No runner is free right now. Try again in a minute.",
            code: "CLAUDEX_WEB_CAPACITY",
          },
        },
        503,
      );
    if (path(request.url).endsWith("/rpc/codeUsageDashboard"))
      return new Response("<html>Bad gateway</html>", { status: 502 });
    return undefined;
  });
  await assert.rejects(bridge.api.usageSummary("7d" as any), (error: any) => {
    assert.equal(error.code, "CLAUDEX_WEB_CAPACITY");
    return /No runner is free/.test(error.message);
  });
  await assert.rejects(
    bridge.api.codeUsageDashboard({} as any),
    /The server answered 502/,
  );
});

test("an unreachable service is a connection message, not a sign-out", async () => {
  const { bridge, tab, events } = await signedInBridge();
  tab.routes.unshift((request) => {
    if (path(request.url).includes("/rpc/")) throw new TypeError("offline");
    return undefined;
  });
  await assert.rejects(bridge.api.clientPolicy(), /Can't reach Claudex/);
  assert.ok(bridge.auth.current);
  assert.equal(events.filter((e) => e.type === "signed-out").length, 0);
});

test("large bytes are uploaded in 1 MiB chunks and sent as $upload", async () => {
  const { bridge, tab, calls } = await signedInBridge(() => ({
    id: "a-1",
  }));
  const chunks: number[] = [];
  let started: any;
  tab.routes.unshift((request) => {
    const p = path(request.url);
    if (p === "/api/v1/claudex/web/uploads") {
      started = request.body;
      return json({ ok: true, value: { id: "up_1" } });
    }
    const chunk = /\/uploads\/up_1\/chunks\/(\d+)$/.exec(p);
    if (chunk) {
      assert.equal(request.method, "PUT");
      assert.equal(request.headers.get("authorization"), "Bearer at-1");
      chunks.push((request.body as Uint8Array).byteLength);
      return new Response(null, { status: 204 });
    }
    if (p === "/api/v1/claudex/web/uploads/up_1/complete")
      return json({ ok: true, value: { id: "up_1" } });
    return undefined;
  });
  const data = new Uint8Array(2.5 * 1024 * 1024).fill(7);
  await bridge.api.addAttachmentData("big.png", data);
  assert.equal(started.name, "big.png");
  assert.equal(started.size, data.byteLength);
  assert.match(started.sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(chunks, [1024 * 1024, 1024 * 1024, 512 * 1024]);
  assert.deepEqual(calls[0]!.request.body, {
    args: ["big.png", { $upload: "up_1" }],
  });
  // Small enough bytes stay inline.
  await bridge.api.addAttachmentData("s.png", new Uint8Array(inlineBytes));
  assert.ok("$bytes" in (calls[1]!.request.body as any).args[1]);
});

test("large avatar photos use chunked uploads instead of exceeding the settings RPC limit", async () => {
  const { bridge, tab, calls } = await signedInBridge(() => ({}));
  let size = 0;
  tab.routes.unshift((request) => {
    const url = path(request.url);
    if (url === "/api/v1/claudex/web/uploads") {
      size = (request.body as { size: number }).size;
      return json({ ok: true, value: { id: "avatar_1" } });
    }
    if (url.startsWith("/api/v1/claudex/web/uploads/avatar_1/"))
      return json({ ok: true, value: {} });
    return undefined;
  });
  const avatarPhoto = "data:image/png;base64," + "YQ".repeat(600000);
  await bridge.api.saveSettings({ avatar: 0, avatarPhoto } as any);
  assert.equal(size, avatarPhoto.length);
  assert.deepEqual(calls[0]!.request.body, {
    args: [
      { avatar: 0, avatarPhoto: { $avatarPhoto: { $upload: "avatar_1" } } },
    ],
  });
});

test("the snapshot names this browser's platform and the web host", async () => {
  const { bridge } = await signedInBridge((method) =>
    method === "snapshot"
      ? ({
          conversations: [],
          projects: [],
          platform: "linux",
        } as unknown as Snapshot)
      : null,
  );
  const snapshot = await bridge.api.snapshot();
  assert.equal(snapshot.platform, "darwin");
  assert.deepEqual(snapshot.host, webHost);
  assert.equal(bridge.state.snapshotLoaded, true);
});

test("every bridge call exists, served where the method table says", async () => {
  const { bridge } = await signedInBridge();
  for (const [name, kind] of webMethodTable) {
    assert.equal(typeof (bridge.api as any)[name], "function", name);
    assert.equal(bridge.kinds.get(name), kind, `${name} has an implementation`);
  }
  assert.equal(typeof bridge.api.onEvent, "function");
});

test("absent calls are refused without reaching the service", async () => {
  const { bridge, calls } = await signedInBridge();
  for (const name of ["chooseFolder", "terminalStart", "popOutArtifact"]) {
    await assert.rejects((bridge.api as any)[name](), (error: any) => {
      assert.equal(error.message, "Not available on the web.");
      assert.equal(error.code, "CLAUDEX_WEB_METHOD_UNAVAILABLE");
      return true;
    });
  }
  assert.equal(calls.length, 0);
});

test("the first snapshot is asked for at sign-in and the window's first call takes it", async () => {
  let asked = 0;
  const { bridge, calls, early } = await signedInBridge((method) => {
    if (method === "snapshot") asked++;
    return method === "snapshot"
      ? { conversations: [], settings: {}, approvals: [] }
      : null;
  });
  assert.deepEqual(
    early.map(({ request }) => path(request.url)),
    ["/api/v1/claudex/web/rpc/snapshot"],
  );
  await bridge.api.snapshot();
  assert.equal(calls.length, 0, "no second request");
  assert.equal(asked, 1);
});

test("the same read asked for twice at once is one request", async () => {
  const { bridge, calls } = await signedInBridge(() => ({ items: [] }));
  await Promise.all([bridge.api.modelCatalog(), bridge.api.modelCatalog()]);
  assert.equal(calls.length, 1);
  await bridge.api.modelCatalog();
  assert.equal(calls.length, 2, "not cached once answered");
});

test("simultaneous browser snapshots share a request without retaining the answer", async t => {
  const { bridge, calls } = await signedInBridge(() => ({ conversations: [], platform: "linux" }));
  t.after(() => bridge.dispose());
  await bridge.api.snapshot();
  await Promise.all([bridge.api.snapshot(), bridge.api.snapshot()]);
  assert.equal(calls.filter(call => call.method === "snapshot").length, 1);
  await bridge.api.snapshot();
  assert.equal(calls.filter(call => call.method === "snapshot").length, 2);
});

test("a replacement account never shares the previous account's pending snapshot", async t => {
  let started!: () => void, release!: () => void;
  const sent = new Promise<void>(resolve => { started = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  let reads = 0;
  const { bridge, service } = await signedInBridge(async method => {
    if (method !== "snapshot") return null;
    if (++reads === 2) { started(); await held; }
    return { conversations: [], platform: "linux", accountRead: reads };
  });
  t.after(() => bridge.dispose());
  await bridge.api.snapshot();
  const old = bridge.api.snapshot();
  const rejected = assert.rejects(old, { name: "AbortError" });
  await sent;
  service.valid.add("snapshot-account-b");
  await bridge.auth.adopt({ access_token: "snapshot-account-b", expires_in: 3600,
    account: { id: "43", email: "b@example.invalid", name: "B" } });
  const next = await bridge.api.snapshot();
  assert.equal((next as any).accountRead, 3);
  release();await rejected;
});


test("a REST settings write separates pending snapshot reads", async () => {
  const { WebTransport } = await import("../../shared/web-client/transport");
  const { FakeClock, flush } = await import("./web-bridge-fakes.test");
  const clock = new FakeClock();
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let reads = 0;
  const transport = new WebTransport({
    timers: { setTimeout: clock.setTimeout, clearTimeout: clock.clear, setInterval: clock.setInterval, clearInterval: clock.clear },
    fetch: async url => {
      if (!String(url).endsWith("/snapshot")) return json({ saved: true });
      const revision = ++reads;
      if (revision === 1) await held;
      return json({ ok: true, value: { revision } });
    },
  }, { activationIdentity: {}, accessToken: async () => "account-token", refresh: async () => null, expire() {} }, "tab");
  const first = transport.call("snapshot", '{"args":[]}');
  await flush();
  await transport.json("/profile", { method: "PUT", body: "{}" });
  assert.deepEqual(await transport.call("snapshot", '{"args":[]}'), { revision: 2 });
  release();await first;
});

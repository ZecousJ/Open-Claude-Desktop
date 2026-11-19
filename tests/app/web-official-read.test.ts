import assert from "node:assert/strict";
import test from "node:test";
import {
  officialResponseChunkBytes,
  officialResponseChunkPath,
} from "../../shared/official-response-transfer";
import { officialDesignType } from "../../shared/official-design-artifacts";
import { remoteCodeHeartbeatPath } from "../../shared/official-remote-code";
import { officialUiTransferMaxBytes } from "../../shared/official-ui-web";
import { reconnectMaxMs } from "../../shared/web-client/events";
import { createOfficialReadFetch } from "../../src-web/official/read-fetch";
import { negotiatedOfficialAction } from "../../src-web/official/negotiated-action";
import { officialPluginOrganizationTarget, pluginOrganizationResponse } from "../../shared/official-plugin-organizations";
import { FakeClock, json, signedInBridge } from "./web-bridge-fakes.test";

test("organization marketplace reads use the active Bearer token and never deliver a retired response", async (t) => {
  const { bridge, tab, service, calls } = await signedInBridge();
  t.after(() => bridge.dispose());
  const organization = "11111111-1111-4111-8111-111111111111";
  const market = {
    id: "22222222-2222-4222-8222-222222222222",
    name: "research",
    display_name: "Research",
  };
  const servicePath = "/api/v1/claudex/plugin-organizations";
  const readPath = "/api/organizations/" + organization + "/marketplaces/list-org-marketplaces";
  const tokens: (string | null)[] = [];
  let started!: () => void;
  let release!: () => void;
  const sent = new Promise<void>((resolve) => { started = resolve; });
  const held = new Promise<void>((resolve) => { release = resolve; });
  tab.routes.unshift(async (request) => {
    const pathname = new URL(request.url, "https://fixture.invalid").pathname;
    if (pathname === servicePath) {
      assert.equal(request.headers.get("authorization"), "Bearer at-1");
      return json({ code: 0, data: [{ id: organization, name: "Research", role: "member" }] });
    }
    if (pathname !== servicePath + "/" + organization + "/marketplaces") return;
    const token = request.headers.get("authorization");
    tokens.push(token);
    if (token === "Bearer at-1") {
      if (tokens.length === 2) {
        started();
        await held;
      }
      return json({ code: 0, data: [{ ...market, private_source: "ignore me" }] });
    }
    return json({ code: 404, reason: "CLAUDEX_PLUGIN_ORGANIZATION_NOT_FOUND", message: "private diagnostic" }, 404);
  });
  const read = createOfficialReadFetch(
    "https://fixture.invalid",
    bridge.officialUiRead,
    async () => assert.fail("organization metadata is a read"),
  );
  const memberships = await read("/api/claudex/plugin-organizations");
  assert.deepEqual(await memberships.json(), {
    organizations: [{ id: organization, name: "Research", role: "member" }],
  });
  const listed = await read(readPath);
  assert.equal(listed.status, 200);
  assert.equal(listed.headers.get("cache-control"), "no-store");
  assert.deepEqual(await listed.json(), { marketplaces: [market] });
  assert.equal((await read(readPath + "?user=owner")).status, 400);
  const pending = assert.rejects(read(readPath), { name: "AbortError" });
  await sent;
  service.valid.add("account-b");
  await bridge.auth.adopt({
    access_token: "account-b",
    expires_in: 3600,
    account: { id: "43", email: "b@example.invalid", name: "B" },
  });
  release();
  await pending;
  const absent = await read(readPath);
  assert.equal(absent.status, 404);
  assert.deepEqual(await absent.json(), {
    error: { type: "not_found_error", message: "Organization not found." },
  });
  assert.deepEqual(tokens, ["Bearer at-1", "Bearer at-1", "Bearer account-b"]);
  assert.ok(!calls.some(({ method }) => method === "officialUiRead"), "organization metadata did not route through the runner");
});

test("Remote Control heartbeat forwards the batch and organization as a read", async () => {
  const ids = { session_ids: ["cse_11111111111141118111111111111111"] };
  const organization = "11111111-1111-4111-8111-111111111111";
  let reads = 0;
  const read = createOfficialReadFetch(
    "https://fixture.invalid",
    async (request) => {
      reads++;
      assert.equal(request.method, "POST");
      assert.equal(request.path, remoteCodeHeartbeatPath);
      assert.equal(request.codeOrganizationId, organization);
      assert.deepEqual(JSON.parse(new TextDecoder().decode(request.body)), ids);
      return {
        status: 200,
        contentType: "application/json",
        body: new TextEncoder().encode(JSON.stringify({
          checks_enabled: true,
          results: [{ session_id: ids.session_ids[0], outcome: "fresh" }],
        })),
      };
    },
    async () => assert.fail("heartbeat must be handled by the read adapter"),
  );
  const init = {
    method: "POST",
    headers: { "content-type": "application/json", "x-organization-uuid": organization },
    body: JSON.stringify(ids),
  };
  const response = await read(remoteCodeHeartbeatPath, init);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).results[0].outcome, "fresh");
  assert.equal((await read(remoteCodeHeartbeatPath + "?scope=other", init)).status, 501);
  assert.equal(reads, 1);
});

test("Cloud Code does not reopen its stream until the Runner event connection returns", async (t) => {
  const clock = new FakeClock();
  const key = "a".repeat(32);
  const id = `session_${key}`;
  const { bridge, tab } = await signedInBridge((method) =>
    method === "officialUiRead"
      ? {
          status: 200,
          contentType: "application/json",
          body: new TextEncoder().encode(JSON.stringify({
            conversation_id: "code",
            session: { id, worker_status: "running" },
            data: [],
            has_more: false,
          })),
        }
      : null,
    { clock },
  );
  t.after(() => bridge.dispose());
  const fetch = createOfficialReadFetch(
    "https://fixture.invalid",
    bridge.officialUiRead,
    async () => assert.fail("Code stream escaped the Web bridge"),
    bridge.officialUiEvents,
    undefined, undefined, undefined,
    { organization: "owner", codeStreamConnected: () => bridge.stream.connected },
  );
  const path = `/v1/code/sessions/${id}/events/stream`;
  const socket = tab.sockets.at(-1)!;
  socket.open();
  socket.receive({ t: "ready", v: 1, seq: 0, resumed: false });
  const first = await fetch(path);
  assert.equal(first.status, 200);
  const reader = first.body!.getReader();
  t.after(() => reader.cancel().catch(() => {}));
  await reader.read();

  socket.drop(1006);
  await assert.rejects(reader.read(), /Runner event connection closed/);
  assert.equal((await bridge.officialUiRead({ method: "GET", path })).status, 200);
  for (let attempt = 0; attempt < 2; attempt++) {
    const unavailable = await fetch(path);
    t.after(() => unavailable.body?.cancel());
    assert.equal(unavailable.status, 503);
  }

  await clock.advance(reconnectMaxMs);
  const next = tab.sockets.at(-1)!;
  assert.notEqual(next, socket);
  next.open();
  next.receive({ t: "ready", v: 1, seq: 0, resumed: true });
  const restored = await fetch(path);
  assert.equal(restored.status, 200);
  const resumed = restored.body!.getReader();
  t.after(() => resumed.cancel());
  assert.match(new TextDecoder().decode((await resumed.read()).value), /"connection_status":"connected"/);
});

test("original Discover forwards organization reads to the Runner with installed state", async (t) => {
  const market = "11111111-1111-4111-8111-111111111111";
  const rows = [{
    id: "plugin_0123456789abcdef01234567",
    marketplace_id: market,
    marketplace_display_name: "Research",
    name: "research",
    display_name: "Research Tools",
    description: "Test plugin metadata",
    version: "1.0.0",
    installation_preference: "required",
    package_available: true,
  }];
  const { bridge, calls } = await signedInBridge((method, args) => {
    if (method !== "officialUiRead") return null;
    const request = args[0] as { method: string; path: string };
    const url = new URL(request.path, "https://fixture.invalid");
    const target = officialPluginOrganizationTarget(request.method, url.pathname, url.search);
    assert.ok(target?.kind === "catalog");
    const body = pluginOrganizationResponse(target, rows, url.search, { [rows[0].id]: { enabled: true } });
    return { status: 200, contentType: "application/json", body: new TextEncoder().encode(JSON.stringify(body)) };
  });
  t.after(() => bridge.dispose());
  const read = createOfficialReadFetch("https://fixture.invalid", bridge.officialUiRead,
    async () => assert.fail("a metadata read must not invoke a mutation"));
  const path = "/api/organizations/11111111-1111-4111-8111-111111111111/library/discover/";
  const home = await (await read(path + "home")).json();
  assert.equal(home.blocks[0].key, "from_your_organization");
  assert.deepEqual(home.blocks[0].see_all, { source: "organization", sort: "installs" });
  const browse = await (await read(path + "browse?source=organization&kind=plugin&sort=installs&limit=1")).json();
  assert.deepEqual(browse.items, home.blocks[0].items);
  assert.deepEqual(browse.items[0].viewer, {
    added: true, installed: { enabled: true, installation_preference: "required", can_remove: false, can_toggle: false },
  });
  assert.deepEqual((await (await read(path + "browse?source=organization&kind=plugin&q=missing")).json()).items, []);
  assert.ok(calls.every(({ method, request }) => method === "officialUiRead" && request.headers.get("authorization") === "Bearer at-1"));
});

test("the original organization plugin removal crosses the action bridge without a JSON body", async () => {
  const path = "/api/organizations/11111111-1111-4111-8111-111111111111/plugins/plugin_0123456789abcdef01234567?source=organization";
  const read = createOfficialReadFetch("https://fixture.invalid", async () => assert.fail("removal is a mutation"),
    async () => assert.fail("removal must stay on the Runner bridge"), undefined, async request => {
    assert.deepEqual(request, { method: "DELETE", path });
    return { status: 200, contentType: "application/json", body: new TextEncoder().encode('{"installed":false}') };
  });
  const response = await read(path, { method: "DELETE" });
  assert.deepEqual(await response.json(), { installed: false });
});

test("the official Web fetch exposes retry headers only for keyed Design creation", async (t) => {
  const origin = "https://fixture.invalid";
  const organization = "11111111-1111-4111-8111-111111111111";
  const key = "22222222-2222-4222-8222-222222222222";
  const create = `/api/frame/types/${officialDesignType.slug}/create?org=${organization}`;
  const keyed = `${create}&idempotency_key=${key}`;
  let status = 409;
  const { bridge } = await signedInBridge((method) => {
    assert.ok(method === "officialUiAction" || method === "officialUiRead");
    return {
      status,
      contentType: "application/json",
      body: new TextEncoder().encode("{}"),
      retryAfter: "1",
      frameRefusal: "create_in_flight",
      headers: { "Set-Cookie": "fixture=private" },
    };
  });
  t.after(() => bridge.dispose());
  const native = new Response(null, { status: 429, headers: { "Retry-After": "4" } });
  const fetch = createOfficialReadFetch(origin, bridge.officialUiRead, async () => native, undefined, bridge.officialUiAction);
  const post = (path: string) => fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: '{"target_type_version":null}',
  });
  const inFlight = await post(keyed);
  assert.equal(inFlight.status, 409);
  assert.equal(inFlight.headers.get("Retry-After"), "1");
  assert.equal(inFlight.headers.get("X-Frame-Refusal"), "create_in_flight");
  assert.equal(inFlight.headers.get("Set-Cookie"), null);
  for (const ordinary of [await post(create), await fetch("/api/frame/types?org=" + organization)]) {
    assert.equal(ordinary.status, 409);
    assert.equal(ordinary.headers.get("Retry-After"), null);
    assert.equal(ordinary.headers.get("X-Frame-Refusal"), null);
  }
  status = 503;
  const unavailable = await post(keyed);
  assert.equal(unavailable.status, 503);
  assert.equal(unavailable.headers.get("Retry-After"), "1");
  assert.equal(unavailable.headers.get("X-Frame-Refusal"), null);
  status = 404;
  const absent = await post(keyed);
  assert.equal(absent.status, 404);
  assert.equal(absent.headers.get("Retry-After"), null);
  assert.equal(absent.headers.get("X-Frame-Refusal"), null);
  assert.equal(await fetch("/api/v1/native"), native);
  assert.equal(await post(`https://other.invalid${keyed}`), native);
});

test("the official read bridge uses the authenticated runner transport and decodes bytes", async () => {
  const bytes = new TextEncoder().encode('{"ok":true}');
  const { bridge, calls } = await signedInBridge((method) =>
    method === "officialUiRead"
      ? { status: 200, contentType: "application/json", body: bytes }
      : null,
  );
  try {
    const answer = await bridge.officialUiRead({
      method: "GET",
      path: "/api/account",
    });
    assert.equal(new TextDecoder().decode(answer.body), '{"ok":true}');
    assert.equal(calls[0].request.headers.get("authorization"), "Bearer at-1");
    assert.deepEqual(calls[0].request.body, {
      args: [{ method: "GET", path: "/api/account" }],
    });
  } finally {
    bridge.dispose();
  }
});

test("the official read bridge rejects malformed runner responses", async () => {
  const { bridge } = await signedInBridge(() => ({
    status: 200,
    contentType: "application/json",
    body: "not bytes",
  }));
  try {
    await assert.rejects(
      bridge.officialUiRead({ method: "GET", path: "/api/account" }),
      /not valid/,
    );
  } finally {
    bridge.dispose();
  }
});

test("the official read bridge rejects missing, misordered, and retired response chunks", async (t) => {
  const bytes = officialResponseChunkBytes;
  const id = "11111111-1111-4111-8111-111111111111";
  const path =
    "/api/organizations/22222222-2222-4222-8222-222222222222/files/file-id/contents";
  const first = {
    status: 200,
    contentType: "application/pdf",
    body: new Uint8Array(bytes),
    responseTransfer: { id, totalBytes: 2 * bytes + 1 },
  };
  for (const fault of [
    "missing",
    "wrong offset",
    "account changed",
    "oversized transfer",
  ] as const) {
    await t.test(fault, async () => {
      let rotateAccount = () => {};
      const { bridge, calls } = await signedInBridge((method, args) => {
        if (method !== "officialUiRead") return null;
        const request = args[0] as { path: string };
        if (request.path === path)
          return fault === "oversized transfer"
            ? {
                ...first,
                responseTransfer: {
                  id,
                  totalBytes: officialUiTransferMaxBytes + 1,
                },
              }
            : first;
        assert.equal(request.path, officialResponseChunkPath(id, bytes));
        if (fault === "account changed") rotateAccount();
        return {
          status: 200,
          contentType: "application/octet-stream",
          body: fault === "missing" ? new Uint8Array() : first.body,
          responseOffset: fault === "wrong offset" ? 2 * bytes : bytes,
        };
      });
      try {
        const account = bridge.auth.current!;
        rotateAccount = () => {
          bridge.auth.set({
            ...account,
            account: { ...account.account, id: "2" },
          });
          bridge.auth.set(account);
        };
        await assert.rejects(
          bridge.officialUiRead({ method: "GET", path }),
          fault === "account changed" ? /account changed/ : /not valid/,
        );
        assert.equal(
          calls.filter(({ method }) => method === "officialUiRead").length,
          fault === "oversized transfer" ? 1 : 2,
        );
      } finally {
        bridge.dispose();
      }
    });
  }
});

test("official event subscriptions stop when this tab switches accounts", async () => {
  const { bridge } = await signedInBridge();
  try {
    const events: string[] = [];
    const unsubscribe = bridge.officialUiEvents((event) =>
      events.push(event.type),
    );
    const current = bridge.auth.current!;
    bridge.auth.set({ ...current, account: { ...current.account, id: "999" } });
    assert.deepEqual(events, ["signed-out"]);
    bridge.auth.set(current);
    assert.deepEqual(events, ["signed-out"]);
    unsubscribe();
  } finally {
    bridge.dispose();
  }
});

test("the official session viewer action sends the organization without requiring a model", async () => {
  const organization = "11111111-1111-4111-8111-111111111111";
  const path = "/v1/code/sessions/cse_22222222222242228222222222222222/client/presence";
  const payload = { client_id: "33333333-3333-4333-8333-333333333333", clear: true };
  const unexpectedRead = async () => assert.fail("viewer activity does not read model or Chat capabilities");
  let called = 0;
  const action = negotiatedOfficialAction({
    mode: "engine-chat",
    accountId: "owner",
    isCurrent: () => true,
    read: unexpectedRead,
    action: async (request) => {
      called++;
      assert.equal(request.method, "POST");
      assert.equal(request.path, path);
      assert.equal(request.codeOrganizationId, organization);
      assert.equal(request.capabilityLease, undefined);
      assert.deepEqual(JSON.parse(new TextDecoder().decode(request.body)), payload);
      return {
        status: 200,
        contentType: "application/json",
        body: new TextEncoder().encode('{"refresh_after_seconds":20}'),
      };
    },
  });
  const read = createOfficialReadFetch("https://fixture.invalid", unexpectedRead, unexpectedRead, undefined, action);
  const init = {
    method: "POST",
    headers: { "content-type": "application/json", "x-organization-uuid": organization },
    body: JSON.stringify(payload),
  };
  const response = await read(path, init);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { refresh_after_seconds: 20 });
  assert.equal((await read(path + "?channel=other", init)).status, 501);
  assert.equal(called, 1);
});

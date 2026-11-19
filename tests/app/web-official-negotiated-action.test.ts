/** Inert bridge callbacks only. Capability discovery is not a client-side grant. */
import test from "node:test";
import assert from "node:assert/strict";
import { negotiatedOfficialAction } from "../../src-web/official/negotiated-action";
import {
  officialUiCapabilitiesPath,
  officialUiActionPath,
  type OfficialUiCapabilities,
} from "../../shared/official-ui-web";
const lease = "11111111-1111-4111-8111-111111111111";
const completion = {
  method: "POST" as const,
  path: "/api/organizations/11111111-1111-4111-8111-111111111111/chat_conversations/22222222-2222-4222-8222-222222222222/completion",
  body: new TextEncoder().encode('{"tools":[]}'),
  contentType: "application/json",
};
function fixture(mode: OfficialUiCapabilities["mode"] = "strict-text") {
  let current = true,
    reads = 0,
    actions = 0,
    input: any,
    data: any = {
      version: 1,
      accountId: "owner",
      activationLease: lease,
      mode,
      textChat: { state: "ready", reason: "ready" },
    };
  let afterRead = () => {},
    afterAction = () => {};
  const invoke = negotiatedOfficialAction({
    mode,
    accountId: "owner",
    isCurrent: () => current,
    read: async (request) => {
      reads++;
      assert.deepEqual(request, {
        method: "GET",
        path: officialUiCapabilitiesPath,
      });
      afterRead();
      return {
        status: 200,
        contentType: "application/json",
        body: new TextEncoder().encode(JSON.stringify(data)),
      };
    },
    action: async (request) => {
      actions++;
      input = request;
      afterAction();
      return {
        status: 200,
        contentType: "application/json",
        body: new Uint8Array(),
      };
    },
  });
  return {
    invoke,
    revoke: () => (current = false),
    data: (v: any) => (data = v),
    afterRead: (fn: typeof afterRead) => (afterRead = fn),
    afterAction: (fn: typeof afterAction) => (afterAction = fn),
    get reads() {
      return reads;
    },
    get actions() {
      return actions;
    },
    get input() {
      return input;
    },
  };
}
test("default read-only path performs no capability or action request", async () => {
  const f = fixture("read-only");
  assert.equal((await f.invoke(completion)).status, 501);
  assert.equal(f.reads, 0);
  assert.equal(f.actions, 0);
});
test("each opted-in action negotiates again and cannot self-supply an approval/lease", async () => {
  const f = fixture();
  assert.equal(
    (await f.invoke({ ...completion, capabilityLease: "forged" })).status,
    200,
  );
  assert.equal(f.input.capabilityLease, lease);
  assert.deepEqual(f.input.body, completion.body);
  assert.equal((await f.invoke(completion)).status, 200);
  assert.equal(f.reads, 2);
  assert.equal(f.actions, 2);
});
test("wrong account, missing, unknown and denied descriptors never call action", async () => {
  for (const data of [
    null,
    {},
    {
      version: 1,
      accountId: "other",
      activationLease: lease,
      mode: "strict-text",
      textChat: { state: "ready", reason: "ready" },
    },
    {
      version: 1,
      accountId: "owner",
      activationLease: lease,
      mode: "strict-text",
      textChat: { state: "denied", reason: "approval_required" },
    },
  ]) {
    const f = fixture();
    f.data(data);
    assert.equal((await f.invoke(completion)).status, 501);
    assert.equal(f.actions, 0);
  }
});
test("unsupported RPC and delete cannot use the negotiated action transport", async () => {
  const f = fixture();
  for (const request of [
    { ...completion, path: officialUiActionPath },
    { ...completion, method: "DELETE" as const },
  ])
    assert.equal((await f.invoke(request)).status, 501);
  assert.equal(f.reads, 0);
  assert.equal(f.actions, 0);
});
test("ordinary Chat forwards original PerformAction bytes with a fresh lease", async () => {
  const f = fixture("engine-chat");
  const request = { method: "POST" as const, path: officialUiActionPath,
    contentType: "application/proto", body: new Uint8Array([1, 2, 3]) };
  assert.equal((await f.invoke(request)).status, 200);
  assert.deepEqual(f.input, { ...request, capabilityLease: lease });
  const replacement = "22222222-2222-4222-8222-222222222222";
  f.data({ version: 1, accountId: "owner", activationLease: replacement,
    mode: "engine-chat", textChat: { state: "ready", reason: "ready" } });
  assert.equal((await f.invoke(request)).status, 200);
  assert.deepEqual(f.input, { ...request, capabilityLease: replacement });
  assert.equal(f.reads, 2);
});
test("strict and ordinary Chat cannot dispatch through each other's capability", async () => {
  for (const [requested, received] of [
    ["engine-chat", "strict-text"],
    ["strict-text", "engine-chat"],
    ["engine-chat", "read-only"],
  ] as const) {
    const f = fixture(requested);
    f.data({ version: 1, accountId: "owner", activationLease: lease,
      mode: received, textChat: { state: "ready", reason: "ready" } });
    assert.equal((await f.invoke(completion)).status, 501);
    assert.equal(f.actions, 0);
  }
});
test("read or send completion after account retirement is revoked without automatic retry", async () => {
  const before = fixture();
  before.afterRead(before.revoke);
  assert.equal((await before.invoke(completion)).status, 409);
  assert.equal(before.actions, 0);
  const late = fixture();
  late.afterAction(late.revoke);
  assert.equal((await late.invoke(completion)).status, 409);
  assert.equal(late.actions, 1);
});
test("owned Stop can use current lease even when new spending approval is denied", async () => {
  const f = fixture();
  f.data({
    version: 1,
    accountId: "owner",
    activationLease: lease,
    mode: "strict-text",
    textChat: { state: "denied", reason: "approval_required" },
  });
  assert.equal(
    (
      await f.invoke({
        ...completion,
        path: completion.path.replace(/completion$/, "stop_response"),
      })
    ).status,
    200,
  );
  assert.equal(f.actions, 1);
});

test("discovery failure and rejected transport after retirement fail closed without retry", async () => {
  const read = fixture();
  read.afterRead(() => {
    throw Error("inert discovery failure");
  });
  assert.equal((await read.invoke(completion)).status, 501);
  assert.equal(read.actions, 0);
  const send = fixture();
  send.afterAction(() => {
    send.revoke();
    throw Error("old private failure");
  });
  const answer = await send.invoke(completion);
  assert.equal(answer.status, 409);
  assert.doesNotMatch(new TextDecoder().decode(answer.body), /old private/);
  assert.equal(send.actions, 1);
});
test("unknown readiness reason cannot use Stop as a negotiation bypass", async () => {
  const f = fixture();
  f.data({
    version: 1,
    accountId: "owner",
    activationLease: lease,
    mode: "strict-text",
    textChat: { state: "unavailable", reason: "unknown" },
  });
  assert.equal(
    (
      await f.invoke({
        ...completion,
        path: completion.path.replace(/completion$/, "stop_response"),
      })
    ).status,
    501,
  );
  assert.equal(f.actions, 0);
});

test("Code session creation requires the active engine lease", async () => {
  const request = { method: "POST" as const, path: "/v1/code/sessions", body: new TextEncoder().encode('{"events":[]}'), codeOrganizationId: "organization" };
  const allowed = fixture("engine-chat");
  assert.equal((await allowed.invoke(request)).status, 200);
  assert.equal(allowed.input.capabilityLease, lease);
  assert.equal(allowed.input.codeOrganizationId, "organization");
  const strict = fixture("strict-text");
  assert.equal((await strict.invoke(request)).status, 501);
  assert.equal(strict.actions, 0);
});

test("an exact Code routine action uses its own active-account authority", async () => {
  const request = { method: "POST" as const, path: "/v1/code/triggers/trig_task/run", body: new TextEncoder().encode("{}"), codeOrganizationId: "organization" };
  const allowed = fixture("engine-chat");
  assert.equal((await allowed.invoke(request)).status, 200);
  assert.equal(allowed.input.capabilityLease, undefined);
  assert.equal(allowed.input.codeOrganizationId, "organization");
  assert.equal((await allowed.invoke({ ...request, path: "/v1/code/triggers/trig_task/unknown" })).status, 501);
  const denied = fixture("read-only");
  assert.equal((await denied.invoke(request)).status, 501);
  assert.equal(denied.actions, 0);
});

test("original Cowork creation requires the current engine lease", async () => {
  const request = { method: "POST" as const, path: "/api/organizations/11111111-1111-4111-8111-111111111111/cowork/sessions", body: new TextEncoder().encode('{"message":"hello"}'), contentType: "application/json" };
  const engine = fixture("engine-chat");
  assert.equal((await engine.invoke(request)).status, 200);
  assert.equal(engine.input.capabilityLease, lease);
  assert.deepEqual(engine.input.body, request.body);
  const strict = fixture("strict-text");
  assert.equal((await strict.invoke(request)).status, 501);
  assert.equal(strict.actions, 0);
});

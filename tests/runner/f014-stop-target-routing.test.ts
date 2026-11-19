import assert from "node:assert/strict";
import { test } from "node:test";
import { route } from "../../runner/src/chat-devices-routing";

function fixture(bound: boolean) {
  const binding = {
    deviceId: "self-device",
    remoteConversationId: "self-remote",
    revision: 1,
  };
  const conversation = {
    id: "self-chat",
    mode: "chat",
    createdAt: 0,
    turns: [{ id: "self-turn", createdAt: 1 }],
    ...(bound ? { chatDeviceBinding: binding } : {}),
  };
  const calls: unknown[] = [];
  let fallbackCalls = 0;
  const controller: any = {
    current() {},
    host: { conversations: () => [conversation] },
    call: async (...args: unknown[]) => {
      calls.push(args);
      return "legacy-result";
    },
  };
  return {
    calls,
    get fallbackCalls() {
      return fallbackCalls;
    },
    run: (args: unknown[]) =>
      route.call(controller, "interrupt", args, async () => {
        fallbackCalls++;
        return "local-cas-result";
      }),
  };
}

test("bound device carries a stable expected turn and rejects invalid targets", async () => {
  const f = fixture(true);
  const expected = {
    turnId: "self-turn",
    turnCreatedAt: 1,
    conversationCreatedAt: 0,
  };
  assert.equal(await f.run(["self-chat", expected]), "legacy-result");
  assert.deepEqual((f.calls[0] as unknown[]).slice(1, 3), [
    "chatDeviceInterruptExpected",
    { remoteConversationId: "self-remote", expected },
  ]);
  for (const expected of [
    null,
    {},
    "invalid",
    {
      turnId: "self-turn",
      turnCreatedAt: 1,
      conversationCreatedAt: 0,
      threadId: "remote",
    },
  ]) {
    const f = fixture(true);
    await assert.rejects(
      f.run(["self-chat", expected]),
      /stop target cannot be confirmed/,
    );
    assert.equal(f.calls.length, 0);
    assert.equal(f.fallbackCalls, 0);
  }
});

test("legacy unaddressed device Stop retains its original dispatch and result", async () => {
  const f = fixture(true);
  assert.equal(await f.run(["self-chat"]), "legacy-result");
  assert.equal(f.calls.length, 1);
  assert.deepEqual((f.calls[0] as unknown[]).slice(1), [
    "chatDeviceInterrupt",
    { remoteConversationId: "self-remote" },
  ]);
  assert.equal(f.fallbackCalls, 0);
});

test("unbound local scoped Stop still reaches its authoritative local handler", async () => {
  const f = fixture(false);
  assert.equal(
    await f.run(["self-chat", { turnId: "self-turn" }]),
    "local-cas-result",
  );
  assert.equal(f.calls.length, 0);
  assert.equal(f.fallbackCalls, 1);
});

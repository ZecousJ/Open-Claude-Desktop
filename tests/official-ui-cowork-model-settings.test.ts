import test from "node:test";
import assert from "node:assert/strict";
import { registerExperimentalCoworkSessions } from "../electron/official-ui/native/cowork-sessions";
import type { Conversation } from "../shared/types";

// Adapter contract tests, not live model or UI acceptance. Method signatures
// verified against recovered LocalAgentModeSessions native schema and renderer
// cb1e253a0-D3VA46OS.js (setters awaited before send, effortLevel on getSession).
function fixture(
  options: { load?: () => Promise<void>; update?: () => Promise<void> } = {},
) {
  let owner = "one";
  const conversation: Conversation = {
    id: "task",
    title: "Task",
    pinned: false,
    archived: false,
    mode: "cowork",
    providerId: "provider",
    model: "before",
    effort: "medium",
    turns: [],
    createdAt: 1,
    updatedAt: 1,
  };
  const calls: Array<{ name: string; args: unknown[] }> = [];
  const attach = () => {
    const handlers = new Map<string, (...args: any[]) => unknown>();
    registerExperimentalCoworkSessions({
      ctx: {
        account: () => ({ id: owner }),
        settings: () => ({ providers: [] }),
        localLoadConversation: async (id: string) => {
          await options.load?.();
          return id === conversation.id
            ? structuredClone(conversation)
            : undefined;
        },
        localListConversations: async () => [structuredClone(conversation)],
        localCall: async (name: string, ...args: unknown[]) => {
          calls.push({ name, args });
          if (name === "snapshot") return { approvals: [] };
          if (name === "listSlashCommands") return {
            commands: [{ name: "fixture", description: "Fixture command", source: "prompt" }],
            usageCredits: false,
          };
          if (name === "updateConversation") {
            await options.update?.();
            assert.equal(args[0], conversation.id);
            Object.assign(conversation, args[1]);
            return structuredClone(conversation);
          }
          if (name === "send") return structuredClone(conversation);
          throw Error(name);
        },
        onEvent: () => () => {},
        log() {},
      },
      on: (name: string, fn: (...args: any[]) => unknown) =>
        handlers.set(name, fn),
      emit() {},
    } as never);
    return (method: string, ...args: unknown[]) =>
      Promise.resolve(
        handlers.get(`LocalAgentModeSessions.${method}`)!(...args),
      );
  };
  return {
    conversation,
    calls,
    attach,
    run: attach(),
    switchAccount: () => {
      owner = "two";
    },
  };
}

test("Cowork official model/effort/thinking setters persist host choices and rehydrate effortLevel", async () => {
  const f = fixture();
  assert.equal(await f.run("setModel", "local_task", "after"), undefined);
  assert.equal(await f.run("setEffort", "local_task", "high"), undefined);
  assert.equal(
    await f.run("setExtendedThinking", "local_task", true),
    undefined,
  );
  assert.deepEqual(
    f.calls.map((c) => c.args[1]),
    [
      { providerId: "provider", model: "after" },
      { effort: "high" },
      { thinkingMode: "extended" },
    ],
  );
  const reopened = (await f.attach()("getSession", "local_task")) as {
    model: string;
    effortLevel: string;
  };
  assert.equal(reopened.model, "after");
  assert.equal(reopened.effortLevel, "high");
  await f.run(
    "sendMessage",
    "local_task",
    "no live request: host boundary only",
  );
  const send = f.calls.find((c) => c.name === "send")!.args[0] as {
    model: string;
    providerId: string;
  };
  assert.equal(send.model, "after");
  assert.equal(send.providerId, "provider");
  await f.run("setExtendedThinking", "local_task", false);
  assert.equal(f.conversation.thinkingMode, "standard");
});

test("Cowork rejects invalid model, effort and thinking inputs without writes", async () => {
  const f = fixture();
  for (const model of [null, {}, "", " ", "a".repeat(201)])
    await assert.rejects(f.run("setModel", "local_task", model));
  for (const effort of [null, {}, "", "auto", "HIGH", 1])
    await assert.rejects(f.run("setEffort", "local_task", effort));
  for (const enabled of [null, "false", 0, {}])
    await assert.rejects(f.run("setExtendedThinking", "local_task", enabled));
  assert.deepEqual(f.calls, []);
  for (const effort of ["low", "medium", "high", "xhigh", "max", "ultra"])
    await f.run("setEffort", "local_task", effort);
  assert.equal(f.conversation.effort, "ultra");
});

test("Cowork settings cannot alter missing or non-Cowork sessions", async () => {
  const f = fixture();
  for (const [method, value] of [
    ["setModel", "after"],
    ["setEffort", "high"],
    ["setExtendedThinking", true],
  ] as const) {
    await assert.rejects(f.run(method, "local_other", value), /not found/);
    f.conversation.mode = "code";
    await assert.rejects(f.run(method, "local_task", value), /not found/);
    f.conversation.mode = "cowork";
  }
  assert.deepEqual(f.calls, []);
});

test("account switch during settings lookup refuses a late host mutation", async () => {
  let release!: () => void;
  let entered!: () => void;
  const waiting = new Promise<void>((r) => {
    release = r;
  });
  const started = new Promise<void>((r) => {
    entered = r;
  });
  const f = fixture({
    load: async () => {
      entered();
      await waiting;
    },
  });
  const pending = f.run("setEffort", "local_task", "high");
  await started;
  f.switchAccount();
  release();
  await assert.rejects(pending, /account/i);
  assert.deepEqual(f.calls, []);
});

test("host setting failures are surfaced and a later explicit retry can succeed", async () => {
  let fail = true;
  const f = fixture({
    update: async () => {
      if (fail) throw Error("storage offline");
    },
  });
  await assert.rejects(
    f.run("setModel", "local_task", "after"),
    /storage offline/,
  );
  assert.equal(f.conversation.model, "before");
  fail = false;
  await f.run("setModel", "local_task", "after");
  assert.equal(f.conversation.model, "after");
});


test("Cowork uses the original scoped command rows for an owned session", async () => {
  const f = fixture();
  assert.deepEqual(await f.run("getSupportedCommands", { sessionId: "local_task" }),
    [{ name: "fixture", description: "Fixture command", kind: "skill", scope: "cowork" }]);
  assert.deepEqual(f.calls, [{ name: "listSlashCommands", args: [{ strictSources: true, conversationId: "task" }] }]);
  await assert.rejects(f.run("getSupportedCommands", { sessionId: "local_foreign" }), /not found/);
});

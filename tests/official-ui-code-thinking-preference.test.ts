/** Inert adapter calls only: no model, shell, filesystem grants or account operations. */
import test from "node:test";
import assert from "node:assert/strict";
import { registerExperimentalCodeSessions } from "../electron/official-ui/native/code-sessions";
import type { Conversation } from "../shared/types";
import "../shared/agent-api";
function fixture() {
  const c: Conversation = {
    id: "session",
    mode: "code",
    title: "Code",
    cwd: "/inert",
    providerId: "p",
    model: "m",
    pinned: false,
    archived: false,
    createdAt: 1,
    updatedAt: 1,
    turns: [],
  };
  const calls: unknown[][] = [];
  const handlers = new Map<string, (...args: any[]) => unknown>();
  let account = "a",
    identity = {},
    readGate: Promise<void> | undefined,
    writeGate: Promise<void> | undefined,
    fail = false,
    readOnly = false,
    current = true;
  let reply: ((saved: Conversation) => unknown) | undefined;
  registerExperimentalCodeSessions({
    ctx: {
      account: () => ({ id: account }),
      sessionIdentity: () => identity,
      get readOnly() {
        return readOnly;
      },
      isCurrent: () => current,
      settings: () => ({}),
      localLoadConversation: async (id: string) => {
        await readGate;
        return id === c.id ? structuredClone(c) : undefined;
      },
      localCall: async (name: string, ...args: unknown[]) => {
        calls.push([name, ...args]);
        await writeGate;
        if (fail) throw Error("write failed");
        if (name !== "updateConversation") throw Error("Unexpected call");
        const patch = args[1] as {
          thinkingSummariesWanted: { wanted: boolean };
        };
        c.thinkingSummariesWanted = patch.thinkingSummariesWanted.wanted;
        return reply ? reply(structuredClone(c)) : structuredClone(c);
      },
      onEvent: () => () => {},
      log() {},
    },
    on(name: string, fn: (...args: any[]) => unknown) {
      handlers.set(name, fn);
    },
    emit() {},
  } as never);
  return {
    c,
    calls,
    reply: (value: (saved: Conversation) => unknown) => {
      reply = value;
    },
    run: (id: unknown, wanted: unknown) =>
      handlers.get("LocalSessions.setThinkingSummariesWanted")!(id, wanted),
    readGate: (gate: Promise<void>) => {
      readGate = gate;
    },
    writeGate: (gate: Promise<void>) => {
      writeGate = gate;
    },
    retire() {
      identity = {};
    },
    switch() {
      account = "b";
      identity = {};
    },
    fail(value: boolean) {
      fail = value;
    },
    readOnly() {
      readOnly = true;
    },
    notCurrent() {
      current = false;
    },
  };
}
test("official thinking/verbose preference writes both boolean states through existing update", async () => {
  const f = fixture();
  await f.run("local_session", true);
  assert.equal(f.c.thinkingSummariesWanted, true);
  await f.run("local_session", false);
  assert.equal(f.c.thinkingSummariesWanted, false);
  assert.deepEqual(f.calls, [
    [
      "updateConversation",
      "session",
      {
        thinkingSummariesWanted: {
          version: 1,
          wanted: true,
          expected: {
            id: "session",
            createdAt: 1,
            thinkingSummariesWanted: null,
          },
        },
      },
    ],
    [
      "updateConversation",
      "session",
      {
        thinkingSummariesWanted: {
          version: 1,
          wanted: false,
          expected: {
            id: "session",
            createdAt: 1,
            thinkingSummariesWanted: true,
          },
        },
      },
    ],
  ]);
  assert.deepEqual(f.c.turns, []);
});
test("strict boolean, local Code ownership and writable current host are required", async () => {
  for (const invalid of [undefined, null, 0, 1, "true", {}, []]) {
    const f = fixture();
    await assert.rejects(async () => f.run("local_session", invalid));
    assert.equal(f.calls.length, 0);
  }
  for (const id of [null, 42, "session", "local_missing"]) {
    const f = fixture();
    await assert.rejects(async () => f.run(id, true));
    assert.equal(f.calls.length, 0);
  }
  for (const change of [
    (f: ReturnType<typeof fixture>) => {
      f.c.mode = "chat";
    },
    (f: ReturnType<typeof fixture>) => {
      f.c.cloudHosted = true;
    },
    (f: ReturnType<typeof fixture>) => {
      f.c.incognito = true;
    },
    (f: ReturnType<typeof fixture>) => {
      f.c.cloudEnvironmentId = "remote";
    },
    (f: ReturnType<typeof fixture>) => {
      f.c.environment = { kind: "ssh", hostId: "remote" };
    },
    (f: ReturnType<typeof fixture>) => {
      f.c.sessionAuthors = {
        ownerAccountUuid: "other",
        viewerAccountUuid: "a",
      };
    },
    (f: ReturnType<typeof fixture>) => f.readOnly(),
    (f: ReturnType<typeof fixture>) => f.notCurrent(),
  ]) {
    const f = fixture();
    change(f);
    await assert.rejects(async () => f.run("local_session", true));
    assert.equal(f.calls.length, 0);
  }
});
test("late reads after same-account retirement or switch do not write; failure remains retryable", async () => {
  for (const retire of ["retire", "switch"] as const) {
    const f = fixture();
    let release!: () => void;
    f.readGate(new Promise<void>((r) => (release = r)));
    const pending = assert.rejects(
      async () => f.run("local_session", true),
      /account changed/,
    );
    f[retire]();
    release();
    await pending;
    assert.equal(f.calls.length, 0);
  }
  const f = fixture();
  f.fail(true);
  await assert.rejects(
    async () => f.run("local_session", true),
    /write failed/,
  );
  assert.equal(f.c.thinkingSummariesWanted, undefined);
  f.fail(false);
  await f.run("local_session", true);
  assert.equal(f.c.thinkingSummariesWanted, true);
});

test("changing summary preference never migrates or resumes saved legacy input", async () => {
  const f = fixture();
  f.c.codeNewTask = {
    id: "draft",
    text: "Do not send",
    attachments: [],
    providerId: "p",
    model: "m",
  } as any;
  const before = structuredClone(f.c.codeNewTask);
  await f.run("local_session", true);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.deepEqual(f.c.codeNewTask, before);
  assert.equal(f.calls.length, 1);
});

for (const retire of ["retire", "switch", "readOnly", "notCurrent"] as const)
  test(`late preference acknowledgment after ${retire} cannot report success`, async () => {
    const f = fixture();
    let release!: () => void;
    f.writeGate(
      new Promise<void>((r) => {
        release = r;
      }),
    );
    const pending = assert.rejects(async () => f.run("local_session", true));
    while (!f.calls.length) await new Promise((r) => setTimeout(r, 0));
    f[retire]();
    release();
    await pending;
    assert.equal(f.calls.length, 1, "unknown outcomes are never retried");
  });

for (const [name, reply] of [
  ["missing", () => undefined],
  ["wrong id", (c: any) => ({ ...c, id: "other" })],
  ["recreated", (c: any) => ({ ...c, createdAt: 2 })],
  ["wrong value", (c: any) => ({ ...c, thinkingSummariesWanted: false })],
  ["not Code", (c: any) => ({ ...c, mode: "chat" })],
  ["remote", (c: any) => ({ ...c, environment: { kind: "ssh", hostId: "h" } })],
  ["cloud", (c: any) => ({ ...c, cloudHosted: true })],
  [
    "other owner",
    (c: any) => ({
      ...c,
      sessionAuthors: { viewerAccountUuid: "a", ownerAccountUuid: "other" },
    }),
  ],
] as const)
  test(`preference save rejects ${name} acknowledgment`, async () => {
    const f = fixture();
    f.reply(reply);
    await assert.rejects(
      async () => f.run("local_session", true),
      /could not be confirmed/,
    );
    assert.equal(f.calls.length, 1);
  });

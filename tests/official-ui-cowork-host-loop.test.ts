import assert from "node:assert/strict";
import { test } from "node:test";
import { registerExperimentalCoworkSessions } from "../electron/official-ui/native/cowork-sessions";
import type { Conversation } from "../shared/types";

const conversation = (
  id: string,
  changes: Partial<Conversation> = {},
): Conversation => ({
  id,
  title: id,
  mode: "cowork",
  providerId: "p",
  model: "m",
  pinned: false,
  archived: false,
  createdAt: 1,
  updatedAt: 1,
  turns: [],
  cwd: process.cwd(),
  ...changes,
});
function fixture() {
  let owner = "A",
    identity = {};
  let pendingLoad: Promise<Conversation | undefined> | undefined;
  const rows = [
    conversation("host"),
    conversation("explicit-local", { environment: { kind: "local" } }),
    conversation("code", { mode: "code" }),
    conversation("chat", { mode: "chat" }),
    conversation("cloud", { cloudHosted: true }),
    conversation("ssh", { environment: { kind: "ssh", hostId: "ssh" } }),
    conversation("space", { environment: { kind: "space", spaceId: "space" } }),
  ];
  const handlers = new Map<string, (...args: any[]) => any>();
  registerExperimentalCoworkSessions({
    ctx: {
      account: () => ({ id: owner }),
      sessionIdentity: () => identity,
      localListConversations: async () => (owner === "A" ? rows : []),
      localLoadConversation: async (id: string) =>
        pendingLoad ??
        (owner === "A" ? rows.find((row) => row.id === id) : undefined),
      localCall: async (name: string) => {
        assert.equal(name, "snapshot");
        return { approvals: [] };
      },
      settings: () => ({ mcpServers: {} }),
      onEvent: () => () => {},
      log() {},
    },
    on(name: string, handler: (...args: any[]) => any) {
      handlers.set(name, handler);
    },
    emit() {},
  } as never);
  return {
    call: (name: string, ...args: unknown[]) =>
      handlers.get(`LocalAgentModeSessions.${name}`)!(...args),
    rotate(next = owner) {
      owner = next;
      identity = {};
    },
    hold(promise: Promise<Conversation | undefined>) {
      pendingLoad = promise;
    },
  };
}

test("actual Cowork handlers describe only local host sessions, including optimistic new session", async () => {
  const f = fixture();
  for (const list of [
    await f.call("getAll"),
    (await f.call("getSessionList")).sessions,
  ]) {
    assert.deepEqual(
      list.map((row: any) => [row.sessionId, row.hostLoopMode]),
      [
        ["local_host", true],
        ["local_explicit-local", true],
      ],
    );
  }
  for (const id of ["local_host", "local_explicit-local", "local_session_new"])
    assert.equal((await f.call("getSession", id)).hostLoopMode, true);
  for (const id of [
    "local_code",
    "local_chat",
    "local_cloud",
    "local_ssh",
    "local_space",
    "local_missing",
    "foreign_host",
  ])
    assert.equal(await f.call("getSession", id), null);
  f.rotate("B");
  assert.deepEqual(await f.call("getAll"), []);
  assert.equal(await f.call("getSession", "local_host"), null);
});

test("pending host metadata read cannot cross owner or same-account activation", async () => {
  for (const next of ["A", "B"]) {
    const f = fixture();
    let resolve!: (value: Conversation) => void;
    f.hold(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const result = f.call("getSession", "local_host");
    f.rotate(next);
    resolve(conversation("host"));
    await assert.rejects(result, /account changed/);
  }
});

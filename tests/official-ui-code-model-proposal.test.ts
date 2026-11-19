import { test } from "node:test";
import assert from "node:assert/strict";
import { registerExperimentalCodeSessions } from "../electron/official-ui/native/code-sessions";

const parent = "32ed031c-feb9-4d0d-b9c4-5c18dfdbec50";
const child = "32ed031c-feb9-4d0d-b9c4-5c18dfdbec51";
test("native proposal cards and actions preserve the renderer contract", async () => {
  const now = Date.now();
  const proposal = (
    id: string,
    kind: "suggestion" | "offer",
    expiresAt = now + 60000,
  ) => ({
    id,
    kind,
    title: id,
    brief: "Saved brief",
    context: "fresh",
    createdAt: now,
    sourceTurnId: "source",
    expiresAt,
    state: { kind: "pending" },
    worktree: true,
  });
  const conversation = {
    id: parent,
    title: "Parent",
    mode: "code",
    cwd: "/tmp",
    providerId: "p",
    model: "m",
    createdAt: now,
    updatedAt: now,
    turns: [
      {
        id: "source",
        status: "inProgress",
        items: [],
        attachments: [],
        createdAt: now,
        prompt: "Offer a task",
      },
    ],
    codeModelProposals: [
      proposal("task_12345678", "suggestion"),
      proposal("task_12345679", "offer"),
      proposal("task_1234567a", "suggestion", now - 1),
      {
        ...proposal("task_1234567b", "suggestion"),
        state: { kind: "dismissed" },
      },
      {
        ...proposal("task_1234567c", "suggestion"),
        state: { kind: "claimed", childId: child },
      },
    ],
  };
  const handlers = new Map<string, (...args: any[]) => any>();
  const calls: any[][] = [];
  const stop = registerExperimentalCodeSessions({
    ctx: {
      account: () => ({ id: "owner" }),
      settings: () => ({ providers: [] }),
      localLoadConversation: async (id: string) =>
        id === parent ? structuredClone(conversation) : undefined,
      onEvent: () => () => {},
      localCall: async (...args: any[]) => {
        calls.push(args);
        if (args[0] === "snapshot") return { approvals: [] };
        assert.equal(args[0], "officialCodeModelProposal");
        assert.equal(args[4](), true);
        return args[3].kind === "start"
          ? { sessionId: `local_${child}` }
          : true;
      },
    },
    on(name: string, handler: (...args: any[]) => any) {
      handlers.set(name, handler);
    },
    emit() {},
  } as never);
  try {
    const session = await handlers.get("LocalSessions.getSession")!(
      `local_${parent}`,
    );
    assert.deepEqual(session.backgroundTaskSuggestions, [
      {
        id: "task_12345678",
        title: "task_12345678",
        prompt: "Saved brief",
        context: "fresh",
        createdAt: now,
        expiresAt: now + 60000,
        useWorktree: true,
      },
      {
        id: "task_12345679",
        title: "task_12345679",
        prompt: "Saved brief",
        context: "fresh",
        createdAt: now,
        expiresAt: now + 60000,
        useWorktree: true,
        offer: true,
      },
      {
        id: "task_1234567c",
        title: "task_1234567c",
        prompt: "Saved brief",
        context: "fresh",
        createdAt: now,
        expiresAt: now + 60000,
        useWorktree: true,
      },
    ]);
    assert.deepEqual(session.spawningTaskIds, []);
    const start = await handlers.get("LocalSessions.start")!({
      sessionId: `local_${child}`,
      spawnedFrom: {
        sessionId: `local_${parent}`,
        taskId: "task_12345678",
        pendingPop: true,
        proposalPicks: { model: "m" },
      },
      useWorktree: true,
      cwd: "/forged",
      message: "forged",
    });
    assert.deepEqual(start, { sessionId: `local_${child}` });
    assert.deepEqual(calls.at(-1)?.slice(0, 4), [
      "officialCodeModelProposal",
      parent,
      "task_12345678",
      {
        kind: "start",
        requestedId: child,
        picks: { model: "m" },
        useWorktree: true,
      },
    ]);
    assert.equal(
      await handlers.get("LocalSessions.popBackgroundTaskSuggestionById")!(
        `local_${parent}`,
        "task_12345678",
        true,
      ),
      true,
    );
    assert.deepEqual(calls.at(-1)?.slice(0, 4), [
      "officialCodeModelProposal",
      parent,
      "task_12345678",
      { kind: "pop", launched: true },
    ]);
    assert.equal(
      await handlers.get("LocalSessions.acceptSideSessionOffer")!(
        `local_${parent}`,
        "task_12345679",
        { target: "local", useWorktree: true },
      ),
      true,
    );
    assert.deepEqual(calls.at(-1)?.slice(0, 4), [
      "officialCodeModelProposal",
      parent,
      "task_12345679",
      {
        kind: "acceptOffer",
        selection: { target: "local", useWorktree: true },
      },
    ]);
    await assert.rejects(
      handlers.get("LocalSessions.start")!({
        spawnedFrom: {
          sessionId: `local_${parent}`,
          taskId: "bad",
          pendingPop: true,
        },
        cwd: "/tmp",
        message: "forged",
      }),
    );
  } finally {
    stop();
  }
});

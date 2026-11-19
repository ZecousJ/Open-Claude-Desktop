import test from "node:test";
import assert from "node:assert/strict";
import {
  convertCodeTranscript,
  pageCodeTranscript,
  normalizeCodeTranscriptLimit,
} from "../electron/official-ui/native/code-transcript";
import { registerExperimentalCodeSessions } from "../electron/official-ui/native/code-sessions";
import type { Conversation, Item } from "../shared/types";

function conversation(items: Item[] = []): Conversation {
  return {
    id: "history",
    mode: "code",
    title: "History",
    providerId: "inert",
    model: "inert",
    cwd: "/inert",
    pinned: false,
    archived: false,
    createdAt: 1,
    updatedAt: 1,
    turns: [
      {
        id: "turn",
        prompt: "Question",
        attachments: [],
        items,
        status: "completed",
        createdAt: 1,
      },
    ],
  };
}
function harness(c = conversation()) {
  const handlers = new Map<string, any>(),
    events: any[] = [],
    calls: unknown[][] = [],
    logs: unknown[][] = [];
  let listener: (event: any) => void = () => {},
    owner = "a",
    revision = 1,
    loads = 0;
  let load = async (id: string) => {
    loads++;
    return id === c.id ? structuredClone(c) : undefined;
  };
  const close = registerExperimentalCodeSessions({
    ctx: {
      account: () => ({ id: owner }),
      sessionIdentity: () => revision,
      isCurrent: () => true,
      localLoadConversation: (id: string) => load(id),
      localCall: async (...args: unknown[]) => {
        calls.push(args);
        assert.equal(args[0], "snapshot");
        return { approvals: [] };
      },
      onEvent: (fn: any) => {
        listener = fn;
        return () => {};
      },
      log: (...args: unknown[]) => logs.push(args),
    },
    on: (name: string, fn: any) => handlers.set(name, fn),
    emit: (_a: string, _b: string, event: any) => events.push(event),
  } as any);
  return {
    c,
    events,
    calls,
    logs,
    close,
    read: (name: string, ...args: any[]) =>
      handlers.get("LocalSessions." + name)("local_history", ...args),
    loads: () => loads,
    setLoad: (fn: typeof load) => {
      load = fn;
    },
    switchOwner: () => {
      owner = "b";
      revision++;
    },
    async changed() {
      listener({ type: "conversation", conversation: c });
      await new Promise((r) => setImmediate(r));
    },
  };
}
for (const [limit, expected] of [
  [0, 1],
  [-1, 1],
  [1.9, 1],
  [200, 200],
  [1001, 1000],
  [2 ** 31, 1000],
  [2 ** 32 + 17, 1000],
  [Number.MAX_SAFE_INTEGER, 1000],
] as const) {
  test(`page limit ${limit} clamps without wrapping`, () =>
    assert.equal(normalizeCodeTranscriptLimit(limit), expected));
}
for (const limit of [NaN, Infinity, -Infinity, "20", null, {}, []]) {
  test(`invalid page limit ${String(limit)} rejects without reading history`, async () => {
    const h = harness();
    await assert.rejects(h.read("getTranscriptTail", limit), /finite number/);
    await assert.rejects(
      h.read("getTranscriptPage", "", limit),
      /finite number/,
    );
    assert.equal(h.loads(), 0);
    h.close();
  });
}
test("missing limits use bounded defaults; tail remains capped at 500", async () => {
  const h = harness(
    conversation(
      Array.from({ length: 1100 }, (_, i) => ({
        id: "a" + i,
        type: "agentMessage",
        text: "row" + i,
      })),
    ),
  );
  assert.equal((await h.read("getTranscriptTail")).messages.length, 500);
  assert.equal(
    (await h.read("getTranscriptTail", 2 ** 32)).messages.length,
    500,
  );
  assert.equal((await h.read("getTranscriptPage", "")).messages.length, 1000);
  h.close();
});
test("missing cursor and earliest cursor keep exact found and hasMore semantics", () => {
  const rows = convertCodeTranscript(
    conversation([{ id: "a", type: "agentMessage", text: "A" }]),
  ).rows;
  assert.deepEqual(pageCodeTranscript(rows, "missing", 20), {
    messages: [],
    found: false,
    hasMore: false,
    totalRows: 2,
  });
  assert.deepEqual(pageCodeTranscript(rows, rows[0].uuid, 20), {
    messages: [],
    found: true,
    hasMore: false,
    totalRows: 2,
  });
  assert.deepEqual(pageCodeTranscript([], "", 20), {
    messages: [],
    found: true,
    hasMore: false,
    totalRows: 0,
  });
});
for (const cursor of [null, 4, [], {}])
  test(
    "invalid cursor is rejected before history is read: " + String(cursor),
    async () => {
      const h = harness();
      await assert.rejects(
        h.read("getTranscriptPage", cursor, 20),
        /cursor must be a string/,
      );
      assert.equal(h.loads(), 0);
      h.close();
    },
  );
test("an old unknown record does not hide a clean recent tail", async () => {
  const c = conversation([
    {
      id: "unknown",
      type: "futureWidget",
      text: "SECRET_UNKNOWN",
      reasoning: "RAW_REASONING",
      token: "SECRET_TOKEN",
    },
    ...Array.from({ length: 1200 }, (_, i) => ({
      id: "a" + i,
      type: "agentMessage",
      text: "text " + i,
    })),
  ]);
  const original = structuredClone(c);
  const h = harness(c);
  const tail = await h.read("getTranscriptTail", 200);
  assert.equal(tail.messages.length, 200);
  assert.equal(tail.hasMore, true);
  let all = tail.messages;
  while (true) {
    const p = await h.read("getTranscriptPage", all[0].uuid, 123);
    all = [...p.messages, ...all];
    if (!p.hasMore) break;
  }
  assert.equal(all.length, 1202);
  assert.equal(new Set(all.map((r: any) => r.uuid)).size, all.length);
  assert.equal(all[1].uuid, "turn:item:unknown");
  assert.deepEqual(all[1].claudexUnsupported, ["futureWidget"]);
  assert.equal(all[1].type, "system");
  assert.equal(all[1].subtype, undefined);
  assert.deepEqual(all[1].message.content, []);
  assert.equal(all[1].parentUuid, all[0].uuid);
  assert.equal(all[2].parentUuid, all[1].uuid);
  assert.deepEqual(all[2].message.content, [{ type: "text", text: "text 0" }]);
  assert.doesNotMatch(JSON.stringify(all), /SECRET_|RAW_REASONING/);
  assert.deepEqual(c, original);
  assert.deepEqual(h.calls, []);
  assert.deepEqual(h.logs, []);
  h.close();
});
for (const kind of [
  "computerUse",
  "subAgentActivity",
  "enteredReviewMode",
  "exitedReviewMode",
  "collabAgentToolCall",
  "fileChange",
  "futureType",
  "agentMessage",
]) {
  test(`${kind} without a supported shape retains its cursor and diagnostic`, () => {
    const c = conversation([
      {
        id: "u",
        type: kind,
        payload: { secret: "NO_RAW_PAYLOAD" },
        text: undefined,
      },
    ]);
    const first = convertCodeTranscript(c);
    const second = convertCodeTranscript(c);
    assert.deepEqual(first, second);
    assert.deepEqual(first.unsupported, [kind]);
    assert.equal(first.rows[1].uuid, "turn:item:u");
    assert.deepEqual(first.rows[1].claudexUnsupported, [kind]);
    assert.deepEqual(first.rows[1].message.content, []);
    assert.doesNotMatch(JSON.stringify(first.rows), /NO_RAW_PAYLOAD/);
    assert.equal("claudexSourceItem" in first.rows[1], false);
  });
}
test("unsafe type labels cannot become Markdown links, markup or raw payload", () => {
  const rows = convertCodeTranscript(
    conversation([
      { id: "x", type: "[secret](https://invalid.test)", raw: "SECRET" },
    ]),
  ).rows;
  assert.deepEqual(rows[1].claudexUnsupported, ["unknown-record"]);
  assert.doesNotMatch(JSON.stringify(rows), /https:|SECRET/);
});
test("plain plan messages keep text as assistant content", () => {
  const result = convertCodeTranscript(
    conversation([{ id: "p", type: "plan", text: "1. Inspect\n2. Test" }]),
  );
  assert.deepEqual(result.unsupported, []);
  assert.deepEqual(result.rows[1].message.content, [
    { type: "text", text: "1. Inspect\n2. Test" },
  ]);
});
test("malformed task plan steps fall back rather than crashing history", () => {
  const result = convertCodeTranscript(
    conversation([
      {
        id: "p",
        type: "taskPlan",
        plan: [null, { step: "Read", status: "completed" }],
      },
    ]),
  );
  assert.deepEqual(result.unsupported, ["taskPlan"]);
  assert.deepEqual(result.rows[1].claudexUnsupported, ["taskPlan"]);
});
test("omitted resources and inconsistent turn metadata are recorded without transcript text", () => {
  const c = conversation([
    {
      id: "a",
      type: "agentMessage",
      text: "Visible answer",
      content: [{ type: "secret", raw: "SECRET" }],
      citations: [{ private: "SECRET" } as any],
    },
  ]);
  c.turns[0].stopReason = "length";
  c.turns[0].error = "SECRET";
  const result = convertCodeTranscript(c);
  assert.deepEqual(result.unsupported, [
    "message-resources",
    "turn-status",
    "turn-stop-reason",
  ]);
  assert.deepEqual(result.rows.at(-1)?.claudexUnsupported, [
    "turn-status",
    "turn-stop-reason",
    "message-resources",
  ]);
  assert.deepEqual(result.rows.at(-1)?.message.content, []);
  assert.match(JSON.stringify(result.rows), /Visible answer/);
  assert.doesNotMatch(JSON.stringify(result.rows), /SECRET/);
});
test("an unknown command status leaves its result unresolved", () => {
  const result = convertCodeTranscript(
    conversation([{ id: "c", type: "commandExecution", command: "pwd" }]),
  );
  assert.deepEqual(result.rows.at(-1)?.claudexUnsupported, [
    "unknown-command-status",
  ]);
  assert.equal(
    result.rows.some(
      (r) =>
        Array.isArray(r.message.content) &&
        r.message.content.some((b) => b.type === "tool_result"),
    ),
    false,
  );
});
test("live history with an unknown item closes with only the changed rows", async () => {
  const h = harness(
    conversation([{ id: "x", type: "futureType", hidden: "SECRET" }]),
  );
  h.c.turns[0].status = "inProgress";
  await h.changed();
  assert.equal(h.events.filter((e) => e.type === "message").length, 1);
  assert.equal(
    h.events.some((e) => e.type === "close"),
    false,
  );
  await h.changed();
  assert.equal(
    h.events.filter((e) => e.type === "message").length,
    1,
    "same fingerprint is not emitted twice",
  );
  h.c.turns[0].items.push({ id: "a", type: "agentMessage", text: "New reply" });
  await h.changed();
  assert.equal(h.events.filter((e) => e.type === "message").length, 2);
  const beforeCompletion = h.events.length;
  h.c.turns[0].status = "completed";
  await h.changed();
  const completed = h.events.slice(beforeCompletion);
  assert.deepEqual(completed.map((e) => e.type), [
    "session_updated",
    "message",
    "message",
    "close",
  ]);
  const history = await h.read("getTranscript");
  assert.deepEqual(
    completed.slice(1, 3).map((e) => e.message),
    history.slice(1),
  );
  assert.doesNotMatch(JSON.stringify(h.events), /SECRET/);
  assert.deepEqual(h.logs, []);
  h.close();
});
test("append during backfill keeps old cursor stable and never overlaps pages", async () => {
  const h = harness(
    conversation(
      Array.from({ length: 70 }, (_, i) => ({
        id: "a" + i,
        type: "agentMessage",
        text: "a" + i,
      })),
    ),
  );
  const first = await h.read("getTranscriptTail", 20);
  h.c.turns[0].items.push({ id: "new", type: "agentMessage", text: "new" });
  const older = await h.read("getTranscriptPage", first.messages[0].uuid, 1000);
  const all = [...older.messages, ...first.messages];
  assert.equal(all.length, 71);
  assert.equal(new Set(all.map((r) => r.uuid)).size, all.length);
  assert.equal(older.hasMore, false);
  assert.equal(
    (await h.read("getTranscriptTail", 20)).messages.at(-1).uuid,
    "turn:item:new",
  );
  h.close();
});
test("an account switch while loading a page rejects the stale read", async () => {
  const h = harness();
  let release!: (c: Conversation) => void;
  h.setLoad(
    () =>
      new Promise((resolve) => {
        release = resolve as any;
      }),
  );
  const read = h.read("getTranscriptPage", "", 20);
  h.switchOwner();
  release(h.c);
  await assert.rejects(read, /account|session|changed/i);
  h.close();
});

test("mutable live file records never leave a stale placeholder after completion", async () => {
  const h = harness(
    conversation([
      { id: "f", type: "fileChange", lifecycleStatus: "inProgress" },
    ]),
  );
  h.c.turns[0].status = "inProgress";
  await h.changed();
  assert.equal(
    h.events.some((e) => e.message?.claudexUnsupported),
    false,
  );
  assert.equal(
    (await h.read("getTranscript")).some((r: any) => r.claudexUnsupported),
    false,
  );
  h.c.turns[0].items[0] = {
    id: "f",
    type: "fileChange",
    lifecycleStatus: "completed",
    status: "completed",
    changes: [{ path: "new.txt", kind: "add", diff: "hello\n" }],
  };
  await h.changed();
  assert.equal(h.events.filter((e) => e.type === "message").length, 3);
  assert.equal(
    h.events.some((e) => e.type === "close" || e.type === "transcript_loaded"),
    false,
  );
  const beforeCompletion = h.events.length;
  h.c.turns[0].status = "completed";
  await h.changed();
  assert.deepEqual(
    h.events.slice(beforeCompletion).map((e) => e.type),
    ["session_updated", "close"],
  );
  const history = await h.read("getTranscript");
  assert.equal(
    history.some((r: any) => r.claudexUnsupported),
    false,
  );
  assert.deepEqual(
    h.events.filter((e) => e.type === "message").map((e) => e.message),
    history,
  );
  h.close();
});
test("metadata diagnostics are deferred until completion", async () => {
  const h = harness(
    conversation([
      { id: "a", type: "agentMessage", text: "A", citations: [{} as any] },
    ]),
  );
  h.c.turns[0].status = "inProgress";
  await h.changed();
  h.c.turns[0].items.push({ id: "b", type: "agentMessage", text: "B" });
  await h.changed();
  assert.equal(
    h.events.some((e) => e.message?.claudexUnsupported),
    false,
  );
  delete h.c.turns[0].items[0].citations;
  await h.changed();
  assert.equal(
    h.events.some((e) => e.type === "transcript_loaded" || e.type === "close"),
    false,
  );
  h.c.turns[0].items[0].citations = [{} as any];
  const beforeCompletion = h.events.length;
  h.c.turns[0].status = "completed";
  await h.changed();
  const completed = h.events.slice(beforeCompletion);
  assert.deepEqual(completed.map((e) => e.type), [
    "session_updated",
    "message",
    "close",
  ]);
  const history = await h.read("getTranscript");
  assert.deepEqual(completed[1].message, history.at(-1));
  assert.deepEqual(history.at(-1).claudexUnsupported, ["message-resources"]);
  assert.deepEqual(history.at(-1).message.content, []);
  h.close();
});

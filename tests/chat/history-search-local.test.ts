import assert from "node:assert/strict";
import test from "node:test";
import { searchLocalConversations } from "../../electron/conversations/history-search";

const conversation = (id: string, extra: Record<string, unknown>) =>
  ({
    id,
    title: "Untitled",
    mode: "chat",
    providerId: "p",
    model: "m",
    pinned: false,
    archived: false,
    createdAt: 1,
    updatedAt: 1,
    turns: [],
    ...extra,
  }) as any;

test("desktop history search finds titles, prompts and replies, newest first", () => {
  const all = [
    conversation("old", { title: "旅行计划", updatedAt: 1 }),
    conversation("reply", {
      updatedAt: 3,
      turns: [
        {
          id: "t1",
          prompt: "hi",
          items: [
            {
              id: "i",
              type: "agentMessage",
              text: "我们可以去京都旅行，看樱花。",
            },
          ],
        },
      ],
    }),
    conversation("archived", { title: "旅行", archived: true, updatedAt: 9 }),
    conversation("code", { title: "旅行 app", mode: "code", updatedAt: 5 }),
  ];
  const { results } = searchLocalConversations(all, " 旅行 ");
  assert.deepEqual(
    results.map((r) => r.conversationId),
    ["code", "reply", "old"],
  );
  assert.equal(results[1].turnId, "t1");
  assert.match(results[1].snippet!, /京都旅行/);
  assert.deepEqual(
    searchLocalConversations(all, "旅行", {
      mode: "chat",
      includeArchived: true,
    }).results.map((r) => r.conversationId),
    ["archived", "reply", "old"],
  );
  assert.equal(
    searchLocalConversations(all, "旅行", { limit: 1 }).results.length,
    1,
  );
  assert.throws(() => searchLocalConversations(all, "x", { userId: 7 }));
});

test("project search scopes titles and unloaded transcript matches before the result limit", () => {
  const all = [
    ...Array.from({ length: 50 }, (_, index) =>
      conversation(`other-${index}`, {
        title: "needle",
        projectId: "other",
        updatedAt: 100 + index,
      }),
    ),
    conversation("title", { title: "Needle", projectId: "project" }),
    conversation("text", {
      projectId: "project",
      updatedAt: 2,
      turns: [{ id: "turn", prompt: "a needle in context", items: [] }],
    }),
    conversation("archived", {
      title: "needle",
      archived: true,
      projectId: "project",
      updatedAt: 3,
    }),
    conversation("private", {
      title: "needle",
      incognito: true,
      projectId: "project",
      updatedAt: 4,
    }),
  ];
  const { results } = searchLocalConversations(all, "needle", {
    projectId: "project",
    limit: 50,
    includeArchived: true,
  });
  assert.deepEqual(
    results.map((hit) => hit.conversationId),
    ["archived", "text", "title"],
  );
  assert.equal(results[1].turnId, "turn");
  assert.match(results[1].snippet!, /needle/);
  assert.deepEqual(
    searchLocalConversations(all, "needle", {
      projectId: "project",
      limit: 1,
    }).results.map((hit) => hit.conversationId),
    ["text"],
  );
  assert.deepEqual(
    searchLocalConversations(all, "needle", { projectId: "missing" }).results,
    [],
  );
});

/**
 * R3-S6: the past-chats index — what it finds, and what it must never find.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  ChatSearchIndex,
  searchable,
  tokenize,
} from "../../electron/memory/chat-search";
import { chat, turn } from "../support/memory-fixtures";

const scope = { currentId: "now" };

test("tokenize lowercases words and splits CJK text into characters and pairs", () => {
  assert.deepEqual(tokenize("Hello, World_2!"), ["hello", "world_2"]);
  assert.deepEqual(tokenize("记忆搜索"), [
    "记",
    "记忆",
    "忆",
    "忆搜",
    "搜",
    "搜索",
    "索",
  ]);
});

test("search ranks by relevance, title matches count more, and snippets show the match", () => {
  const conversations = [
    chat("a", "Trip planning", [
      ["Where should we stay in Lisbon?", "Alfama has small hotels."],
    ]),
    chat("b", "Lisbon", [["Best pastries?", "Pastel de nata."]]),
    chat("c", "Taxes", [["How do I file a return?", "Use the online form."]]),
  ];
  const index = new ChatSearchIndex(() => conversations);
  const hits = index.search("lisbon hotels", scope);
  assert.deepEqual(
    hits.map((hit) => hit.id),
    ["a", "b"],
  );
  assert.match(hits[0].snippets.join(" "), /Lisbon/);
  assert.equal(index.search("nonexistentword", scope).length, 0);
  assert.equal(index.search("   ", scope).length, 0);
  assert.equal(index.search("lisbon", scope, 1).length, 1);
});

test("stop words alone still match rather than returning nothing", () => {
  const index = new ChatSearchIndex(() => [
    chat("a", "About it", [["what is the", "the answer"]]),
  ]);
  assert.equal(index.search("the", scope).length, 1);
});

test("finds Chinese text", () => {
  const index = new ChatSearchIndex(() => [
    chat("a", "旅行", [["我想去京都看红叶", "十一月最合适。"]]),
    chat("b", "工作", [["帮我写周报", "好的。"]]),
  ]);
  assert.deepEqual(
    index.search("京都", scope).map((hit) => hit.id),
    ["a"],
  );
});

test("incognito chats, Code sessions and the asking chat are never found", () => {
  const conversations = [
    chat("a", "Secret plan", [["moonlight project", "ok"]], {
      incognito: true,
    }),
    chat("b", "Code work", [["moonlight project", "ok"]], { mode: "code" }),
    chat("now", "Current", [["moonlight project", "ok"]]),
    chat("d", "Earlier", [["moonlight project", "ok"]]),
  ];
  const index = new ChatSearchIndex(() => conversations);
  assert.deepEqual(
    index.search("moonlight", { currentId: "now" }).map((hit) => hit.id),
    ["d"],
  );
  assert.equal(searchable(conversations[0]), false);
  assert.equal(searchable(conversations[1]), false);
  // A chat that turns incognito, or is deleted, leaves the index.
  conversations[3].incognito = true;
  assert.equal(index.search("moonlight", { currentId: "now" }).length, 0);
});

test("a project chat sees only its own project; other chats never see projects", () => {
  const conversations = [
    chat("g", "General", [["budget review", "ok"]]),
    chat("p1", "P1 chat", [["budget review", "ok"]], { projectId: "P1" }),
    chat("p2", "P2 chat", [["budget review", "ok"]], { projectId: "P2" }),
  ];
  const index = new ChatSearchIndex(() => conversations);
  const ids = (projectId?: string) =>
    index
      .search("budget", { currentId: "x", ...(projectId ? { projectId } : {}) })
      .map((hit) => hit.id);
  assert.deepEqual(ids(), ["g"]);
  assert.deepEqual(ids("P1"), ["p1"]);
  assert.deepEqual(ids("P2"), ["p2"]);
});

test("archived chats are found and marked", () => {
  const index = new ChatSearchIndex(() => [
    chat("a", "Old", [["kubernetes upgrade", "ok"]], { archived: true }),
  ]);
  const [hit] = index.search("kubernetes", scope);
  assert.equal(hit.archived, true);
});

test("the index follows edits, new replies and deletions", () => {
  const conversations = [chat("a", "Chat", [["hello there", "hi"]])];
  const index = new ChatSearchIndex(() => conversations);
  assert.equal(index.search("pineapple", scope).length, 0);
  conversations[0].turns.push(turn("I like pineapple", "Noted"));
  conversations[0].updatedAt += 1;
  assert.equal(index.search("pineapple", scope).length, 1);
  conversations[0].title = "Fruit";
  conversations[0].updatedAt += 1;
  assert.equal(index.search("fruit", scope)[0].title, "Fruit");
  conversations.length = 0;
  assert.equal(index.search("pineapple", scope).length, 0);
  assert.equal(index.size(), 0);
});

test("a reply that grows while streaming is picked up", () => {
  const c = chat("a", "Chat", [["tell me", "part"]]);
  const index = new ChatSearchIndex(() => [c]);
  assert.equal(index.search("later", scope).length, 0);
  c.turns[0].items.push({ id: "x", type: "agentMessage", text: "later text" });
  assert.equal(index.search("later", scope).length, 1);
});

test("recent lists newest first with the last exchange, filters by time and honours order", () => {
  const conversations = [
    chat("a", "A", [["first question", "first answer"]], { updatedAt: 1_000 }),
    chat(
      "b",
      "B",
      [
        ["one", "two"],
        ["last question", "last answer"],
      ],
      { updatedAt: 3_000 },
    ),
    chat("c", "C", [["c question", "c answer"]], { updatedAt: 2_000 }),
  ];
  const index = new ChatSearchIndex(() => conversations);
  const ids = (options: object) =>
    index
      .recent({ n: 10, order: "desc", ...options }, scope)
      .map((hit) => hit.id);
  assert.deepEqual(ids({}), ["b", "c", "a"]);
  assert.deepEqual(ids({ order: "asc" }), ["a", "c", "b"]);
  assert.deepEqual(ids({ n: 1 }), ["b"]);
  assert.deepEqual(ids({ before: 3_000 }), ["c", "a"]);
  assert.deepEqual(ids({ after: 1_000 }), ["b", "c"]);
  const [top] = index.recent({ n: 1, order: "desc" }, scope);
  assert.deepEqual(top.snippets, [
    "User: last question",
    "Assistant: last answer",
  ]);
});

test("snippets are short and cut on the match, not the start", () => {
  const long = `${"filler ".repeat(200)}needle ${"tail ".repeat(200)}`;
  const index = new ChatSearchIndex(() => [chat("a", "Long", [[long, "ok"]])]);
  const [hit] = index.search("needle", scope);
  assert.ok(hit.snippets[0].length <= 306);
  assert.match(hit.snippets[0], /needle/);
});

test("clear empties the index", () => {
  const index = new ChatSearchIndex(() => [chat("a", "A", [["x y", "z"]])]);
  assert.equal(index.size(), 1);
  index.clear();
  // It fills again from the conversations on the next question.
  assert.equal(index.size(), 1);
});

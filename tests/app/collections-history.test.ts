import test from "node:test";
import assert from "node:assert/strict";
import type { Conversation } from "../../shared/types";
import { collectionTime } from "../../src/collections/collection-time";
import {
  historyNoun,
  historySnippet,
  historyRows,
  matchesQuery,
  rangeSelection,
} from "../../src/collections/history/history-rows";
import {
  bulkFailure,
  bulkResultMessages,
  runEach,
  selectionActions,
} from "../../src/collections/history/bulk-actions";
import { defaultFilter } from "../../src/sidebar/listFilter";
import { HistoryRowText } from "../../src/collections/history/HistoryPage";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

test("history search includes muted snippets beneath titles, bolds literal matches and never renders snippet markup", () => {
  const conversation = {
    title: "Other title",
    turns: [{ prompt: "Find <script>the needle</script> again", items: [] }],
  } as unknown as Conversation;
  const snippet = historySnippet(conversation, "NEEDLE");
  assert.equal(snippet, "Find <script>the needle</script> again");
  const html = renderToStaticMarkup(
    createElement(HistoryRowText, {
      title: conversation.title,
      snippet,
      query: "needle",
    }),
  );
  assert.match(html, /class="history-snippet"/);
  assert.match(html, /<strong>needle<\/strong>/);
  assert.ok(html.indexOf("Other title") < html.indexOf("history-snippet"));
  assert.ok(!html.includes("<script>"));
  assert.equal(historySnippet(conversation, " "), undefined);
  assert.equal(historySnippet(conversation, "absent"), undefined);
});

// Local-time dates, so the day boundaries hold in any time zone.
const at = (month: number, day: number, hour = 12, minute = 0, year = 2026) =>
  new Date(year, month - 1, day, hour, minute).getTime();

test("collection times count minutes, hours, days, then show the date", () => {
  const now = at(9, 26, 10, 30);
  assert.equal(collectionTime(now, now), "Just now");
  assert.equal(collectionTime(now + 60_000, now), "Just now");
  assert.equal(collectionTime(at(9, 26, 10, 29), now), "1 minute ago");
  assert.equal(collectionTime(at(9, 26, 9, 45), now), "45 minutes ago");
  assert.equal(collectionTime(at(9, 26, 9, 30), now), "1 hour ago");
  assert.equal(collectionTime(at(9, 26, 0, 5), now), "10 hours ago");
  assert.equal(collectionTime(at(9, 25, 8), now), "Yesterday");
  assert.equal(collectionTime(at(9, 24, 12), now), "2 days ago");
  assert.equal(collectionTime(at(9, 20, 12), now), "6 days ago");
  assert.equal(collectionTime(at(9, 16, 12), now), "Sep 16");
  assert.equal(collectionTime(at(12, 30, 12, 0, 2025), now), "Dec 30, 2025");
});

test("just after midnight, late last night is still hours ago", () => {
  const now = at(9, 26, 0, 30);
  assert.equal(collectionTime(at(9, 25, 23, 0), now), "1 hour ago");
  assert.equal(collectionTime(at(9, 25, 0, 10), now), "Yesterday");
});

const row = (id: string, patch: Partial<Conversation> = {}): Conversation => ({
  id,
  title: id,
  mode: "chat",
  providerId: "p",
  model: "m",
  pinned: false,
  archived: false,
  createdAt: at(9, 1),
  updatedAt: at(9, 20),
  turns: [],
  ...patch,
});

test("history lists one surface without incognito rows, pinned ones in place", () => {
  const all = [
    row("older", { updatedAt: at(9, 10) }),
    row("pinned", { pinned: true, updatedAt: at(9, 22) }),
    row("task", { mode: "cowork", updatedAt: at(9, 21) }),
    row("secret", { incognito: true, updatedAt: at(9, 25) }),
    row("code", { mode: "code" }),
    row("archived", { archived: true }),
  ];
  const ids = (mode: Conversation["mode"], status = defaultFilter.status) =>
    historyRows(all, mode, { ...defaultFilter, status }, "", at(9, 26)).map(
      (c) => c.id,
    );
  assert.deepEqual(ids("chat"), ["pinned", "task", "older"]);
  assert.deepEqual(ids("cowork"), ["pinned", "task", "older"]);
  assert.deepEqual(ids("code"), ["code"]);
  assert.deepEqual(ids("chat", "archived"), ["archived"]);
  assert.equal(ids("chat", "all").length, 4);
});

test("history search matches titles, prompts and replies", () => {
  const found = row("x", {
    title: "Release notes",
    turns: [
      {
        id: "t",
        prompt: "Draft the OPS runbook",
        attachments: [],
        items: [{ id: "i", type: "agentMessage", text: "Here is a plan" }],
        status: "completed",
        createdAt: at(9, 20),
      },
    ],
  });
  assert.ok(matchesQuery(found, "  release "));
  assert.ok(matchesQuery(found, "ops"));
  assert.ok(matchesQuery(found, "PLAN"));
  assert.ok(matchesQuery(found, ""));
  assert.ok(!matchesQuery(found, "billing"));
  const rows = historyRows([found, row("other")], "chat", defaultFilter, "ops");
  assert.deepEqual(
    rows.map((c) => c.id),
    ["x"],
  );
});

test("history sorts by name, creation or recency", () => {
  const all = [
    row("b", { title: "beta", createdAt: at(9, 3), updatedAt: at(9, 4) }),
    row("a", { title: "Alpha", createdAt: at(9, 2), updatedAt: at(9, 6) }),
    row("c", { title: "gamma", createdAt: at(9, 5), updatedAt: at(9, 5) }),
  ];
  const ids = (sort: typeof defaultFilter.sort) =>
    historyRows(all, "chat", { ...defaultFilter, sort }).map((c) => c.id);
  assert.deepEqual(ids("name"), ["a", "b", "c"]);
  assert.deepEqual(ids("created"), ["c", "b", "a"]);
  assert.deepEqual(ids("activity"), ["a", "c", "b"]);
});

test("rows are sessions in Code and chats elsewhere", () => {
  assert.equal(historyNoun("code"), "session");
  assert.equal(historyNoun("chat"), "chat");
  assert.equal(historyNoun("cowork"), "chat");
});

test("shift-click selects or clears the whole range from the anchor", () => {
  const order = ["a", "b", "c", "d", "e"];
  const pick = (
    selected: string[],
    anchor: string | undefined,
    target: string,
    extend: boolean,
  ) => [...rangeSelection(order, new Set(selected), anchor, target, extend)];
  assert.deepEqual(pick([], undefined, "b", false), ["b"]);
  assert.deepEqual(pick(["b"], "b", "b", false), []);
  assert.deepEqual(pick(["b"], "b", "d", true).sort(), ["b", "c", "d"]);
  assert.deepEqual(pick(["d"], "d", "b", true).sort(), ["b", "c", "d"]);
  // Shift on a selected row clears the range instead.
  assert.deepEqual(pick(["a", "b", "c", "d"], "a", "c", true), ["d"]);
  // Without a usable anchor, shift-click toggles just the row.
  assert.deepEqual(pick([], undefined, "c", true), ["c"]);
  assert.deepEqual(pick([], "gone", "c", true), ["c"]);
});

test("bulk requests keep going past a failure and report the first one", async () => {
  const seen: string[] = [];
  const result = await runEach(["a", "b", "c", "d"], async (id) => {
    seen.push(id);
    if (id === "b") throw new Error("offline");
    if (id === "d") throw new Error("later");
  });
  assert.deepEqual(seen, ["a", "b", "c", "d"]);
  assert.deepEqual(result.failed, ["b", "d"]);
  assert.equal((result.error as Error).message, "offline");
  assert.deepEqual(await runEach(["a"], async () => {}), { failed: [] });
});

test("bulk failure messages count what failed", () => {
  assert.equal(
    bulkFailure("archive", "chat", 2, 5, new Error("offline")),
    "Couldn't archive 2 of 5 chats: offline",
  );
  assert.equal(
    bulkFailure("delete", "session", 3, 3, "busy"),
    "Couldn't delete 3 sessions: busy",
  );
  assert.equal(
    bulkFailure("unarchive", "chat", 1, 1),
    "Couldn't unarchive the chat.",
  );
});

test("history bulk notices count successes and failures independently without ICU", () => {
  assert.deepEqual(bulkResultMessages("archive", 3, 1), [
    "2 items archived",
    "1 item could not be archived.",
  ]);
  assert.deepEqual(bulkResultMessages("delete", 1, 0), ["1 item deleted"]);
  assert.deepEqual(bulkResultMessages("delete", 2, 2), [
    "2 items could not be deleted.",
  ]);
  assert.deepEqual(bulkResultMessages("unarchive", 1, 0), [
    "1 item unarchived",
  ]);
  assert.deepEqual(bulkResultMessages("unarchive", 1, 1), [
    "1 item could not be unarchived.",
  ]);
  assert.deepEqual(bulkResultMessages("archive", 0, 0), []);
});

test("mixed history selections unpin pinned rows and read unread rows first", () => {
  const rows = [
    row("pinned", { pinned: true, unread: true, projectId: "p" }),
    row("other", { projectId: "p" }),
    row("archived", { archived: true }),
  ];
  const actions = selectionActions(rows);
  assert.equal(actions.pinned, true);
  assert.equal(actions.unread, true);
  assert.deepEqual(
    actions.pin.map((row) => row.id),
    ["pinned"],
  );
  assert.deepEqual(
    actions.read.map((row) => row.id),
    ["pinned"],
  );
  assert.equal(selectionActions(rows.slice(0, 2)).project, true);
  assert.equal(actions.project, false);
  assert.equal(selectionActions([row("empty")]).read.length, 0);
  assert.equal(selectionActions([row("code", { mode: "code" })]).pin.length, 0);
});

test("an empty history title renders the official Untitled placeholder", () => {
  const html = renderToStaticMarkup(
    createElement(HistoryRowText, { title: "", query: "" }),
  );
  assert.match(html, /class="history-untitled">Untitled/);
});

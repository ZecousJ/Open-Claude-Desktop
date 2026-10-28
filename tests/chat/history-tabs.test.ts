/**
 * The Chats and tasks page's tab-style filter: Active, Shared and Archived;
 * Code has no Shared tab.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Conversation } from "../../shared/types";
import {
  historyTabEmptyText,
  historyTabFor,
  historyTabRows,
  historyTabs,
} from "../../src/collections/history/history-rows";

const { HistoryTabs } =
  await import("../../src/collections/history/HistoryControls");

const row = (id: string, patch: Partial<Conversation> = {}): Conversation =>
  ({
    id,
    title: id,
    mode: "chat",
    cwd: "",
    model: "",
    effort: "medium",
    status: "idle",
    turns: [],
    createdAt: 1,
    updatedAt: 1,
    archived: false,
    ...patch,
  }) as Conversation;

test("the hub and Code both label their default tab Active", () => {
  assert.deepEqual(
    historyTabs("chat").map((t) => t.label),
    ["Active", "Shared", "Archived"],
  );
  assert.deepEqual(
    historyTabs("cowork").map((t) => t.value),
    ["all", "shared", "archived"],
  );
  assert.deepEqual(
    historyTabs("code").map((t) => t.label),
    ["Active", "Archived"],
  );
  // Code's page has no Shared tab: a Shared choice reads as Active there.
  assert.equal(historyTabFor("code", "shared"), "all");
  assert.equal(historyTabFor("chat", "shared"), "shared");
});

test("each tab lists its rows", () => {
  const conversations = [
    row("a", { updatedAt: 3 }),
    row("b", { archived: true, updatedAt: 2 }),
    row("c", { mode: "cowork", updatedAt: 1 }),
    row("d", { mode: "code" }),
    row("e", { incognito: true }),
  ];
  const shared = new Set(["a", "b"]);
  const ids = (tab: "all" | "shared" | "archived") =>
    historyTabRows(conversations, "chat", tab, shared).map((c) => c.id);
  assert.deepEqual(ids("all"), ["a", "c"]);
  // Shared chats, archived or not.
  assert.deepEqual(ids("shared"), ["a", "b"]);
  assert.deepEqual(ids("archived"), ["b"]);
  assert.deepEqual(
    historyTabRows(conversations, "code", "all", shared).map((c) => c.id),
    ["d"],
  );
  // The search and the sort still apply.
  assert.deepEqual(
    historyTabRows(conversations, "chat", "all", shared, {
      query: "c",
    }).map((c) => c.id),
    ["c"],
  );
  assert.deepEqual(
    historyTabRows(conversations, "chat", "all", shared, {
      sort: "name",
    }).map((c) => c.id),
    ["a", "c"],
  );
});

test("an empty tab says what will show up there", () => {
  assert.equal(
    historyTabEmptyText("chat", "shared"),
    "Links you share will show up here.",
  );
  assert.equal(historyTabEmptyText("chat", "all"), "No activity yet.");
  assert.equal(historyTabEmptyText("chat", "archived"), "No archived tasks.");
  assert.equal(
    historyTabEmptyText("cowork", "archived", true),
    "Nothing archived yet.",
  );
  assert.equal(historyTabEmptyText("cowork", "archived"), "No archived tasks.");
  assert.equal(
    historyTabEmptyText("code", "all"),
    "Sessions you start will show up here.",
  );
  assert.equal(
    historyTabEmptyText("code", "archived"),
    "Archived sessions will show up here.",
  );
});

test("the tabs are a tab list that controls the list below", () => {
  const html = renderToStaticMarkup(
    createElement(HistoryTabs, {
      id: "h",
      mode: "chat",
      value: "shared",
      onChange: () => {},
    }),
  );
  assert.match(html, /role="tablist"[^>]*aria-label="Filter by"/);
  assert.equal(html.match(/role="tab"/g)?.length, 3);
  assert.match(
    html,
    /id="h-shared" aria-selected="true" aria-controls="h-panel" tabindex="0"/,
  );
  assert.match(html, /id="h-all" aria-selected="false"[^>]*tabindex="-1"/);
});

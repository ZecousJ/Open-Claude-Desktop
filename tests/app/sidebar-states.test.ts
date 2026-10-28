import test from "node:test";
import assert from "node:assert/strict";
import type { Conversation, Turn } from "../../shared/types";
import { effectiveGroupBy, groupRows } from "../../src/sidebar/grouping";
import { sidebarNav, toggleNavItem } from "../../src/sidebar/navItems";
import {
  collapseThreshold,
  initialVisibility,
  peekRequested,
  resizeVisibility,
  sidebarOpen,
  toggleVisibility,
} from "../../src/sidebar/sidebar-visibility";
import { finishedUnseen, needsAttention } from "../../src/conversation/unread";
import { tooltipPosition } from "../../src/ui/tooltip-position";

const day = 86_400_000;
const now = new Date(2026, 8, 25, 15).getTime();
const turn = (status: Turn["status"]): Turn => ({
  id: "t",
  prompt: "",
  attachments: [],
  items: [],
  status,
  createdAt: 0,
});
const row = (id: string, patch: Partial<Conversation> = {}): Conversation => ({
  id,
  title: id,
  mode: "chat",
  providerId: "p",
  model: "m",
  pinned: false,
  archived: false,
  createdAt: now - 40 * day,
  updatedAt: now - 1000,
  turns: [],
  ...patch,
});

test("group by date names the last five days by date and drops the rest into Older", () => {
  const days = (n: number) => row(`d${n}`, { updatedAt: now - n * day });
  const groups = groupRows(
    [days(0), days(1), days(2), days(6), days(7), days(29)],
    "date",
    now,
  );
  // Sept 25 15:00 is the reference: two days back is Sep 23, six back Sep 19.
  assert.deepEqual(
    groups.map((g) => [g.key, g.label, g.rows.map((r) => r.id)]),
    [
      ["day-0", "Today", ["d0"]],
      ["day-1", "Yesterday", ["d1"]],
      ["day-2", "Sep 23", ["d2"]],
      ["day-6", "Sep 19", ["d6"]],
      ["older", "Older", ["d7", "d29"]],
    ],
  );
  // A time after midnight on the same calendar day is still that day.
  const late = row("late", {
    updatedAt: new Date(2026, 8, 24, 0, 5).getTime(),
  });
  assert.equal(groupRows([late], "date", now)[0].label, "Yesterday");
});

test("group by date, type, unread and folder keep the row order", () => {
  const rows = [
    row("today"),
    row("yesterday", { updatedAt: now - day, mode: "cowork", unread: true }),
    row("week", { updatedAt: now - 5 * day }),
    row("old", { updatedAt: now - 90 * day, unread: true }),
  ];
  const labels = (by: Parameters<typeof groupRows>[1]) =>
    groupRows(rows, by, now).map((g) => [g.label, g.rows.map((r) => r.id)]);
  assert.deepEqual(labels("date"), [
    ["Today", ["today"]],
    ["Yesterday", ["yesterday"]],
    ["Sep 20", ["week"]],
    ["Older", ["old"]],
  ]);
  assert.deepEqual(labels("type"), [
    ["Chats", ["today", "week", "old"]],
    ["Tasks", ["yesterday"]],
  ]);
  assert.deepEqual(labels("unread"), [
    ["Unread", ["yesterday", "old"]],
    ["Read", ["today", "week"]],
  ]);
  const code = [
    row("a", { mode: "code", cwd: "/u/claudex" }),
    row("b", { mode: "code", cwd: "/u/hub" }),
    row("c", { mode: "code", cwd: "/u/claudex" }),
  ];
  assert.deepEqual(
    groupRows(code, "folder", now).map((g) => [g.label, g.rows.length]),
    [
      ["claudex", 2],
      ["hub", 1],
    ],
  );
  assert.deepEqual(groupRows(code, "none", now)[0].rows, code);
});

test("each surface only groups the ways it offers", () => {
  assert.equal(effectiveGroupBy("code", "type"), "none");
  assert.equal(effectiveGroupBy("code", "folder"), "folder");
  assert.equal(effectiveGroupBy("cowork", "unread"), "unread");
  assert.equal(effectiveGroupBy("chat", "folder"), "none");
});

test("Edit sidebar moves rows into More per surface", () => {
  const hidden = toggleNavItem([], "artifacts", false);
  assert.deepEqual(hidden, ["artifacts"]);
  const chat = sidebarNav("chat", hidden);
  assert.deepEqual(
    chat.shown.map((i) => i.id),
    ["projects", "artifacts", "api", "status"],
  );
  assert.deepEqual(
    chat.inMore.map((i) => i.id),
    ["scheduled", "customize"],
  );
  // Code: Scheduled and Customize in More too, and no Projects.
  const code = sidebarNav("code", [...hidden, "projects"]);
  assert.deepEqual(
    code.shown.map((i) => i.id),
    ["api", "status"],
  );
  assert.deepEqual(
    code.inMore.map((i) => i.id),
    ["artifacts", "scheduled", "customize"],
  );
  assert.deepEqual(toggleNavItem(hidden, "artifacts", true), []);
});

test("the sidebar collapses below the breakpoint and restores the user's choice", () => {
  let state = initialVisibility(1200);
  assert.equal(sidebarOpen(state), true);
  state = resizeVisibility(state, collapseThreshold());
  assert.equal(sidebarOpen(state), false);
  state = toggleVisibility(state);
  assert.equal(sidebarOpen(state), false, "narrow, it is never a column");
  assert.equal(peekRequested(state), true, "the toggle opens the peek");
  state = resizeVisibility(state, 1200);
  assert.equal(sidebarOpen(state), true);
  state = toggleVisibility(state);
  state = resizeVisibility(resizeVisibility(state, 500), 1200);
  assert.equal(sidebarOpen(state), false, "a hidden sidebar stays hidden");
});

test("a reply that finishes off screen marks the chat unread", () => {
  const before = row("a", { turns: [turn("inProgress")] });
  const after = row("a", { turns: [turn("completed")] });
  assert.equal(finishedUnseen(before, after, false), true);
  assert.equal(finishedUnseen(before, after, true), false);
  assert.equal(finishedUnseen(after, after, false), false);
  assert.equal(
    finishedUnseen(before, { ...after, incognito: true }, false),
    false,
  );
  assert.equal(needsAttention([row("x")], new Set(["x"])), true);
  assert.equal(needsAttention([row("x", { unread: true })], new Set()), true);
  assert.equal(
    needsAttention([row("x", { unread: true, archived: true })], new Set()),
    false,
  );
});

test("tooltips sit under their button, or end before it, inside the window", () => {
  const view = { width: 1164, height: 1049 };
  const size = { width: 140, height: 24 };
  // The incognito button at 1124–1156 × 8–40; tooltip 980–1120, 4px under it.
  const button = { left: 1124, right: 1156, top: 8, bottom: 40 };
  assert.deepEqual(tooltipPosition(button, size, view, "below-before"), {
    left: 980,
    top: 44,
  });
  const clamped = tooltipPosition(button, size, view, "below");
  assert.equal(clamped.left, view.width - 8 - size.width);
  const left = tooltipPosition(
    { left: 0, right: 20, top: 0, bottom: 20 },
    size,
    view,
    "below",
  );
  assert.equal(left.left, 8);
});

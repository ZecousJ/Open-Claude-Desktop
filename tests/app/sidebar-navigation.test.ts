import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Conversation, Project } from "../../shared/types";
import type { MenuEntry } from "../../src/ui/Menu";
import { ConversationGroupStore } from "../../electron/conversations/conversation-groups";
import { rovingStep } from "../../src/sidebar/roving-keys";
import { rowStatus } from "../../src/sidebar/row-status";
import {
  moveToGroupEntries,
  type RowMenuAbilities,
  type RowMenuHandlers,
} from "../../src/sidebar/RowMenu";
import { rowMenuEntries } from "../../src/sidebar/row-menu-entries";
import {
  defaultFilter,
  recentRowsShown,
  sidebarRowBatch,
} from "../../src/sidebar/listFilter";
import {
  historyFilterEntries,
  isDefaultFilter,
} from "../../src/sidebar/HistoryFilter";
import { deleteWording } from "../../src/app/delete-wording";
import { historyEmptyText } from "../../src/collections/history/history-rows";
import {
  currentToasts,
  dismissAllToasts,
  showToast,
} from "../../src/ui/toast-store";

type Item = Extract<MenuEntry, { label: string }>;
const items = (entries: MenuEntry[]) =>
  entries.filter((entry): entry is Item => "label" in entry);
const outline = (entries: MenuEntry[]) =>
  entries.map((entry) =>
    "separator" in entry
      ? "—"
      : "heading" in entry
        ? entry.heading
        : entry.hint
          ? `${entry.label} ${entry.hint}`
          : entry.label,
  );

test("arrow keys loop through the list, Home and End jump, sideways stops at the ends", () => {
  assert.equal(rovingStep("ArrowDown", 2, 3, "vertical"), 0);
  assert.equal(rovingStep("ArrowUp", 0, 3, "vertical"), 2);
  assert.equal(rovingStep("Home", 2, 5, "vertical"), 0);
  assert.equal(rovingStep("End", 0, 5, "vertical"), 4);
  assert.equal(rovingStep("ArrowRight", 1, 2, "horizontal"), 1);
  assert.equal(rovingStep("ArrowLeft", 0, 2, "horizontal"), 0);
  assert.equal(rovingStep("ArrowRight", 0, 2, "horizontal"), 1);
  assert.equal(rovingStep("a", 0, 2, "vertical"), undefined);
  assert.equal(rovingStep("ArrowDown", 0, 0, "vertical"), undefined);
  // Left and right are not the list's.
  assert.equal(rovingStep("ArrowLeft", 1, 3, "vertical"), undefined);
});

test("a row's dot is named for its state, and Chat and Cowork dots can mark read", () => {
  const chat = {
    mode: "chat" as const,
    archived: false,
    unread: false,
    turns: [{}] as Conversation["turns"],
  };
  const idle = { working: false, needsApproval: false, question: false };
  assert.deepEqual(rowStatus(chat, idle), {
    dot: "",
    label: "Done",
    archived: false,
    toggle: { hint: "Click to mark as unread" },
  });
  assert.equal(rowStatus({ ...chat, turns: [] }, idle).label, "Idle");
  assert.deepEqual(rowStatus({ ...chat, unread: true }, idle), {
    dot: "unread",
    label: "Unread response",
    archived: false,
    toggle: { hint: "Click to mark as read" },
  });
  assert.equal(rowStatus(chat, { ...idle, working: true }).label, "Running");
  assert.equal(
    rowStatus(chat, { ...idle, needsApproval: true }).label,
    "Awaiting input",
  );
  assert.equal(
    rowStatus(chat, { ...idle, needsApproval: true, question: true }).label,
    "Awaiting answer",
  );
  // Archived wins over everything and cannot be toggled; Code has no dot toggle.
  const archived = rowStatus(
    { ...chat, archived: true, unread: true },
    { ...idle, working: true },
  );
  assert.equal(archived.archived, true);
  assert.equal(archived.label, "Archived");
  assert.equal(archived.toggle, undefined);
  const code = rowStatus({ ...chat, mode: "code", unread: true }, idle);
  assert.equal(code.label, "Unread response");
  assert.equal(code.toggle, undefined);
});

test("Move to group lists the groups, Ungrouped only inside one, then New group…, with number keys", () => {
  const groups = [
    { id: "a", name: "Alpha" },
    { id: "b", name: "Beta" },
  ];
  const noop = () => {};
  const entries = (groupId?: string) =>
    outline(
      moveToGroupEntries({ groups, groupId, moveTo: noop, newGroup: noop }),
    );
  assert.deepEqual(entries(), ["Alpha 1", "Beta 2", "—", "New group… 3"]);
  assert.deepEqual(entries("a"), [
    "Alpha 1",
    "Beta 2",
    "—",
    "Ungrouped 3",
    "New group… 4",
  ]);
  assert.deepEqual(
    outline(
      moveToGroupEntries({
        groups: [],
        groupId: undefined,
        moveTo: noop,
        newGroup: noop,
      }),
    ),
    ["New group… 1"],
  );
  // Only the first nine are numbered.
  const many = Array.from({ length: 11 }, (_, i) => ({
    id: `g${i}`,
    name: `G${i}`,
  }));
  const hints = items(
    moveToGroupEntries({
      groups: many,
      groupId: undefined,
      moveTo: noop,
      newGroup: noop,
    }),
  ).map((item) => item.hint);
  assert.deepEqual(hints.slice(8), ["9", undefined, undefined, undefined]);
  // Choosing Ungrouped takes the conversation out; the current group is a no-op.
  const calls: (string | null)[] = [];
  const picked = items(
    moveToGroupEntries({
      groups,
      groupId: "a",
      moveTo: (id) => calls.push(id),
      newGroup: noop,
    }),
  );
  picked[0].onSelect?.();
  picked[1].onSelect?.();
  picked.find((item) => item.label === "Ungrouped")?.onSelect?.();
  assert.deepEqual(calls, ["b", null]);
});

test("Add to project becomes Change project, searchable with a create row, and Remove from project follows it", () => {
  const conversation = (extra: Partial<Conversation>) =>
    ({
      id: "c",
      title: "T",
      mode: "chat",
      turns: [],
      ...extra,
    }) as Conversation;
  const projects = [
    { id: "p1", name: "Docs" },
    { id: "p2", name: "Site" },
  ] as Project[];
  const calls: string[] = [];
  const on = new Proxy({} as RowMenuHandlers, {
    get:
      (_target, name: string) =>
      (...args: unknown[]) =>
        calls.push([name, ...args.map(String)].join(":")),
  });
  const can: RowMenuAbilities = {
    splitView: false,
    newWindow: false,
    folder: false,
    terminal: false,
    share: false,
    copyLink: false,
  };
  const entry = (c: Conversation) =>
    items(
      rowMenuEntries({
        conversation: c,
        projects,
        platform: "darwin",
        can,
        moveToGroup: { label: "Move to group", submenu: [] },
        on,
      }),
    ).find((item) => item.label.endsWith("project"));
  const add = entry(conversation({}));
  assert.equal(add?.label, "Add to project");
  // The search can create a project.
  assert.equal(add?.searchable, "Search or create a project");
  assert.equal(add?.searchCreate?.typed, "Create project {name}");
  assert.deepEqual(outline(add!.submenu!), ["Docs", "Site"]);
  add!.searchCreate!.onSelect("Notes");
  const change = entry(conversation({ projectId: "p1" }));
  assert.equal(change?.label, "Change project");
  assert.deepEqual(outline(change!.submenu!), ["Docs", "Site"]);
  const all = items(
    rowMenuEntries({
      conversation: conversation({ projectId: "p1" }),
      projects,
      platform: "darwin",
      can,
      moveToGroup: { label: "Move to group", submenu: [] },
      on,
    }),
  );
  const at = all.findIndex((item) => item.label === "Change project");
  assert.equal(all[at + 1].label, "Remove from project");
  all[at + 1].onSelect?.();
  assert.deepEqual(calls, ["newProject:Notes", "moveToProject:null"]);
  // A project that was deleted still offers the way out.
  assert.equal(
    entry(conversation({ projectId: "gone" }))?.label,
    "Change project",
  );
});

test("the filter menu ends with a way back once anything is changed", () => {
  const noChange = () => {};
  assert.equal(isDefaultFilter(defaultFilter), true);
  for (const mode of ["chat", "code"] as const) {
    const plain = outline(historyFilterEntries(mode, defaultFilter, noChange));
    assert.ok(!plain.some((label) => /Reset|Clear/.test(label)));
    const changed = { ...defaultFilter, sort: "name" as const };
    assert.equal(isDefaultFilter(changed), false);
    const entries = historyFilterEntries(mode, changed, noChange);
    const last = entries.at(-1) as Item;
    assert.equal(
      last.label,
      mode === "code" ? "Clear filters" : "Reset to defaults",
    );
    assert.deepEqual(entries.at(-2), { separator: true });
  }
  let result: unknown;
  const entries = historyFilterEntries(
    "chat",
    { ...defaultFilter, groupBy: "date" },
    (value) => (result = value),
  );
  (entries.at(-1) as Item).onSelect?.();
  assert.deepEqual(result, defaultFilter);
});

test("deleting says what a Code session, a Cowork task and a chat are", () => {
  assert.deepEqual(deleteWording({ mode: "code", title: "Fix build" }), {
    title: "Delete session?",
    body: "“Fix build” will be permanently deleted. This can’t be undone.",
  });
  assert.deepEqual(deleteWording({ mode: "cowork", title: "x" }), {
    title: "Delete task",
    body: "Are you sure you want to delete this task?",
  });
  assert.deepEqual(deleteWording({ mode: "chat", title: "x" }), {
    title: "Delete chat?",
    body: "Are you sure you want to delete this chat?",
  });
});

test("the history page's empty lines follow the original", () => {
  assert.equal(
    historyEmptyText("code", false),
    "Sessions you start will show up here.",
  );
  assert.equal(
    historyEmptyText("code", true),
    "Archived sessions will show up here.",
  );
  assert.equal(historyEmptyText("chat", false), "No activity yet.");
  assert.equal(historyEmptyText("cowork", true), "Nothing archived yet.");
});

test("a group can be renamed or deleted; its conversations stay, ungrouped", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-groups-nav-"));
  try {
    const store = new ConversationGroupStore(root, () => ["a", "b", "c"]);
    const first = store.create("Alpha", "a");
    const alpha = first.groups[0].id;
    store.move("b", alpha);
    const second = store.create("Beta", "c");
    const beta = second.groups[1].id;
    const renamed = store.rename(alpha, "  Gamma  ");
    assert.deepEqual(
      renamed.groups.map((g) => g.name),
      ["Gamma", "Beta"],
    );
    assert.throws(() => store.rename(alpha, "beta"), /already exists/);
    // Keeping its own name in another case is fine.
    assert.equal(store.rename(alpha, "GAMMA").groups[0].name, "GAMMA");
    assert.throws(() => store.rename("gone", "x"), /no longer exists/);
    assert.throws(() => store.rename(alpha, "  "), /Enter a group name/);
    const removed = store.remove(alpha);
    assert.deepEqual(
      removed.groups.map((g) => g.id),
      [beta],
    );
    assert.deepEqual(removed.members, { c: beta });
    assert.throws(() => store.remove(alpha), /no longer exists/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a toast can carry a button, and the same message keeps the newest one", () => {
  dismissAllToasts();
  const first = () => {};
  const second = () => {};
  showToast("Unpinned One", { action: { label: "Undo", onSelect: first } });
  showToast("Unpinned One", { action: { label: "Undo", onSelect: second } });
  const toast = currentToasts().find((t) => t.message === "Unpinned One");
  assert.equal(toast?.count, 2);
  assert.equal(toast?.action?.onSelect, second);
  dismissAllToasts();
});

test("Code's recents show 20 then Show more; Chat's stop at 20 for View all", () => {
  assert.equal(sidebarRowBatch, 20);
  assert.equal(recentRowsShown("code", 20), 20);
  assert.equal(recentRowsShown("code", 40), 40);
  assert.equal(recentRowsShown("chat", 40), 20);
  assert.equal(recentRowsShown("cowork", 60), 20);
});

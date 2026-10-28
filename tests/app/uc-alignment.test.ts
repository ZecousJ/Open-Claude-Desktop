import test, { before } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Item, Turn } from "../../shared/types";
import type { MenuEntry } from "../../src/ui/Menu";
import { historyFilterEntries } from "../../src/sidebar/HistoryFilter";
import { defaultFilter } from "../../src/sidebar/listFilter";
import { MainNav } from "../../src/sidebar/MainNav";
import {
  fitPanelWidth,
  terminalPanelBounds,
} from "../../src/conversation/BackgroundPanelResize";
import { fitBackgroundPanelWidth } from "../../shared/background-panel-layout";
import { ChatTurnContent } from "../../src/transcript/ChatTurnContent";
import {
  DynamicToolView,
  preloadMemoryToolView,
} from "../../src/transcript/tools/DynamicToolView";

before(() => preloadMemoryToolView());
import { memoryToolTitle } from "../../src/transcript/tools/MemoryToolView";

type Entry = Extract<MenuEntry, { label: string }>;
const find = (entries: MenuEntry[], label: string) =>
  entries.find((entry) => "label" in entry && entry.label === label) as
    Entry | undefined;
/** Labels, "—" for a divider, "(off)" after a disabled row. */
const outline = (entries: MenuEntry[]) =>
  entries.map((entry) =>
    "separator" in entry
      ? "—"
      : "label" in entry
        ? `${entry.label}${entry.disabled ? " (off)" : ""}`
        : entry.heading,
  );

test("Code filter menu follows R-Code-Recents筛选菜单 and Show PR status toggles", () => {
  const changes: unknown[] = [];
  const entries = historyFilterEntries(
    "code",
    defaultFilter,
    (value) => changes.push(value.showPrStatus),
    { prStatus: true },
  );
  assert.deepEqual(outline(entries), [
    "Status",
    "Environment",
    "—",
    "Group by",
    "Sort by",
    "—",
    "Show PR status",
  ]);
  const show = find(entries, "Show PR status")!;
  assert.equal(show.checked, true);
  assert.equal(show.keepOpen, true);
  show.onSelect!();
  assert.deepEqual(changes, [false]);
  // The History page's list has no PR glyphs: no entry, no trailing rule.
  assert.deepEqual(
    outline(historyFilterEntries("code", defaultFilter, () => {})).slice(-2),
    ["Group by", "Sort by"],
  );
});

test("Environment lists every captured environment; unreachable ones are disabled", () => {
  const changes: unknown[] = [];
  const entries = historyFilterEntries("code", defaultFilter, (value) =>
    changes.push(value.environment),
  );
  const submenu = find(entries, "Environment")!.submenu!;
  assert.deepEqual(outline(submenu), [
    "All environments",
    "—",
    "Local",
    "Cloud (off)",
    "Remote Control (off)",
    "SSH",
    "Slack (off)",
  ]);
  for (const entry of submenu)
    if ("label" in entry && entry.disabled) {
      assert.ok(entry.title);
      assert.equal(entry.onSelect, undefined);
    }
  find(submenu, "SSH")!.onSelect!();
  assert.deepEqual(changes, ["ssh"]);
});

test("Code Group by shows State disabled after Folder; Chat is unchanged", () => {
  const code = historyFilterEntries("code", defaultFilter, () => {});
  assert.deepEqual(outline(find(code, "Group by")!.submenu!), [
    "Date",
    "Folder",
    "State (off)",
    "Custom groups",
    "—",
    "None",
  ]);
  const chat = historyFilterEntries("chat", defaultFilter, () => {});
  assert.deepEqual(outline(find(chat, "Group by")!.submenu!), [
    "Date",
    "Type",
    "Unread",
    "Custom groups",
    "—",
    "None",
  ]);
  assert.equal(find(chat, "Environment"), undefined);
  assert.equal(find(chat, "Show PR status"), undefined);
});

test("the New row navigates directly without an unsupported blank-window control", () => {
  const html = renderToStaticMarkup(
    createElement(MainNav, {
      mode: "chat",
      page: "chat",
      onNewChat() {},
      onPageChange() {},
      onEditSidebar() {},
    }),
  );
  assert.match(html, /<span>New<\/span><kbd>/);
  assert.doesNotMatch(html, /main-nav-new-window|aria-label="New window"/);
});

test("terminal width drag keeps 260px for the conversation", () => {
  // Wide window: the stored width is kept inside 240–720.
  assert.equal(fitPanelWidth(400, 1164, terminalPanelBounds), 400);
  assert.equal(fitPanelWidth(100, 1164, terminalPanelBounds), 240);
  assert.equal(fitPanelWidth(2000, 1600, terminalPanelBounds), 720);
  // Narrow layout: at most layout − 260, never under 220.
  assert.equal(fitPanelWidth(600, 700, terminalPanelBounds), 440);
  assert.equal(fitPanelWidth(600, 400, terminalPanelBounds), 220);
  // The Background rail keeps its own fit.
  for (const [width, layout] of [
    [300, 900],
    [900, 900],
    [100, 500],
  ])
    assert.equal(
      fitPanelWidth(width, layout),
      fitBackgroundPanelWidth(width, layout),
    );
});

const turn = (items: Item[]): Turn => ({
  id: "t1",
  prompt: "Why?",
  attachments: [],
  status: "completed",
  createdAt: 0,
  items,
});

test("Chat's finished reasoning collapses to Thought for Ns (R-0746 area)", () => {
  const reasoning: Item = {
    id: "r",
    type: "reasoning",
    lifecycleStatus: "completed",
    summary: ["Weighing the options."],
    startedAt: 1_000,
    completedAt: 28_000,
  };
  const reply: Item = { id: "m", type: "agentMessage", text: "Because." };
  const html = renderToStaticMarkup(
    createElement(ChatTurnContent, {
      turn: turn([reasoning, reply]),
      awaitingApproval: false,
      onArtifact() {},
    }),
  );
  assert.match(html, /Thought for 27s/);
  // Without timings the title stays generic.
  const untimed = renderToStaticMarkup(
    createElement(ChatTurnContent, {
      turn: turn([
        { ...reasoning, startedAt: undefined, completedAt: undefined },
        reply,
      ]),
      awaitingApproval: false,
      onArtifact() {},
    }),
  );
  assert.match(untimed, /Thought process/);
  assert.doesNotMatch(untimed, /Thought for/);
});

const memory = (extra: Partial<Item>): Item => ({
  id: "mem",
  type: "dynamicToolCall",
  namespace: "claudex_memory",
  tool: "memory_edits",
  lifecycleStatus: "completed",
  status: "completed",
  success: true,
  ...extra,
});

test("memory_edits calls read as memory rows (R-0777)", () => {
  const add = memory({
    arguments: { command: "add", text: "Prefers metric units" },
    contentItems: [
      { type: "inputText", text: "Saved to memory: Prefers metric units" },
    ],
  });
  assert.equal(memoryToolTitle(add), "Added to memory");
  const html = renderToStaticMarkup(
    createElement(DynamicToolView, { item: add }),
  );
  assert.match(html, /memory-tool-activity/);
  assert.match(html, /Added to memory/);
  assert.match(html, /Prefers metric units/);
  assert.doesNotMatch(html, /claudex_memory/);
  assert.doesNotMatch(html, /&quot;command&quot;/);
  assert.equal(
    memoryToolTitle(memory({ arguments: { command: "view" } })),
    "Read memory",
  );
  assert.equal(
    memoryToolTitle(memory({ arguments: { command: "remove", line: 2 } })),
    "Updated memory",
  );
  assert.equal(
    memoryToolTitle(
      memory({ arguments: { command: "replace", line: 1, text: "x" } }),
    ),
    "Updated memory",
  );
  assert.equal(
    memoryToolTitle(
      memory({
        arguments: { command: "add" },
        lifecycleStatus: "inProgress",
        status: "inProgress",
        success: undefined,
      }),
    ),
    "Adding to memory",
  );
  assert.equal(
    memoryToolTitle(memory({ arguments: { command: "add" }, success: false })),
    "Couldn’t add to memory",
  );
  // Other dynamic tools keep the generic row.
  const other = renderToStaticMarkup(
    createElement(DynamicToolView, {
      item: { ...add, namespace: "other", tool: "thing" },
    }),
  );
  assert.match(other, /Used other · thing/);
});
import { before as beforeChatSteps } from "node:test";
import { preloadChatSteps } from "../../src/transcript/ChatTurnContent";
beforeChatSteps(() => preloadChatSteps());

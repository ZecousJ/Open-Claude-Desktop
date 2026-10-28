import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { routineDom } from "../support/routine-dom";
import { HostContext } from "../../src/host/HostContext";
import { desktopHost } from "../../shared/host";
import { HistoryPage } from "../../src/collections/history/HistoryPage";
import type { Conversation } from "../../shared/types";

const conversation = (id: string, extra: Partial<Conversation> = {}) =>
  ({
    id,
    title: id,
    mode: "cowork",
    providerId: "p",
    model: "m",
    pinned: false,
    archived: false,
    createdAt: 1,
    updatedAt: 2,
    turns: [],
    ...extra,
  }) as Conversation;

test("a history row's menu follows the live order and keys, and Select starts a selection with that row", async () => {
  const updates: unknown[] = [];
  const env = await routineDom({
    hostedShares: async () => [],
    listConversationGroups: async () => ({ groups: [], members: {} }),
    searchChats: async () => [],
  } as never);
  for (const [key, value] of [
    ["innerWidth", 1440],
    ["innerHeight", 900],
  ] as const)
    Object.defineProperty(globalThis, key, { configurable: true, value });
  try {
    const page = () =>
      createElement(
        HostContext.Provider,
        { value: desktopHost },
        createElement(HistoryPage, {
          mode: "cowork",
          conversations: [conversation("alpha", { unread: true })],
          projects: [],
          onNewChat() {},
          onOpenConversation() {},
          onArchive: async () => [],
          onDelete() {},
          onRename() {},
          onMoveToProject() {},
          onUpdateSelection: async (ids, patch) => {
            updates.push([ids, patch]);
            return [];
          },
          onConfirmArchive() {},
        }),
      );
    await env.render(page());
    // Select stays beside an open search field.
    await env.click('button[aria-label="Search your activity"]');
    assert.ok(env.document.querySelector(".collection-search"));
    assert.ok(
      [...env.document.querySelectorAll("button")].some(
        (button) => button.textContent === "Select",
      ),
    );
    await env.click(".history-more");
    const menu = env.document.querySelector('[role="menu"]')!;
    const items = [...menu.querySelectorAll('[role="menuitem"]')];
    assert.deepEqual(
      items.map((item) =>
        (item.textContent ?? "")
          .replace(item.querySelector("kbd")?.textContent ?? "", "")
          .trim()
          .replace(/^[^\x00-\x7f]+/, ""),
      ),
      [
        "Select",
        "Pin",
        "Mark as read",
        "Rename",
        "Add to project",
        "Archive",
        "Delete",
      ],
    );
    assert.deepEqual(
      items.map((item) => item.querySelector("kbd")?.textContent ?? ""),
      ["", "p", "u", "r", "", "a", "d"].map((key) => key),
    );
    await env.event(menu, "keydown", { key: "p" });
    assert.deepEqual(updates, [[["alpha"], { pinned: true }]]);
    assert.equal(env.document.querySelector('[role="menu"]'), null);
    await env.click(".history-more");
    const select = [...env.document.querySelectorAll('[role="menuitem"]')].find(
      (item) => item.textContent?.includes("Select"),
    )!;
    await env.event(select, "click", { button: 0 });
    assert.ok(env.document.querySelector(".history-list.selecting"));
    assert.ok(env.document.querySelector('.history-item[aria-checked="true"]'));
  } finally {
    Reflect.deleteProperty(globalThis, "innerWidth");
    Reflect.deleteProperty(globalThis, "innerHeight");
    await env.clean();
  }
});

/**
 * Go ▸ Previous and Next Session: the stop one step away (src/app/session-cycle.ts),
 * the rows it reads and what the menu state says about it.
 */
import test from "node:test";
import assert from "node:assert/strict";
import type { Conversation } from "../../shared/types";
import { menuStateFor } from "../../src/app/shell-menu";
import { cycleTarget, drawnIds, listedIds } from "../../src/app/session-cycle";

const ids = ["a", "b", "c"];
const session = (id: string) => ({ kind: "session", id });

test("Next walks the rows and wraps through the new conversation", () => {
  assert.deepEqual(cycleTarget(ids, "a", 1), session("b"));
  assert.deepEqual(cycleTarget(ids, "b", 1), session("c"));
  assert.deepEqual(cycleTarget(ids, "c", 1), { kind: "new" });
  // From the new conversation (or a page that is no row) the first row is next.
  assert.deepEqual(cycleTarget(ids, undefined, 1), session("a"));
  assert.deepEqual(cycleTarget(ids, "gone", 1), session("a"));
});

test("Previous walks back and wraps to the last row", () => {
  assert.deepEqual(cycleTarget(ids, "c", -1), session("b"));
  assert.deepEqual(cycleTarget(ids, "b", -1), session("a"));
  assert.deepEqual(cycleTarget(ids, "a", -1), { kind: "new" });
  assert.deepEqual(cycleTarget(ids, undefined, -1), session("c"));
});

test("a single row alternates with the new conversation, and an empty list stays put", () => {
  assert.deepEqual(cycleTarget(["a"], "a", 1), { kind: "new" });
  assert.deepEqual(cycleTarget(["a"], "a", -1), { kind: "new" });
  assert.deepEqual(cycleTarget(["a"], undefined, 1), session("a"));
  assert.equal(cycleTarget([], undefined, 1), undefined);
  assert.equal(cycleTarget([], "a", -1), undefined);
});

const row = (id: string, extra: Partial<Conversation> = {}): Conversation =>
  ({
    id,
    title: id,
    mode: "code",
    archived: false,
    createdAt: 0,
    updatedAt: 0,
    ...extra,
  }) as Conversation;

test("the default list is the pinned rows, then the recent ones, without archived or private chats", () => {
  const all = [
    row("old", { updatedAt: 1 }),
    row("new", { updatedAt: 3 }),
    row("pin", { pinned: true, updatedAt: 0 }),
    row("gone", { archived: true, updatedAt: 9 }),
    row("secret", { incognito: true, updatedAt: 9 }),
    row("chat", { mode: "chat", updatedAt: 9 }),
  ];
  assert.deepEqual(listedIds(all, "code"), ["pin", "new", "old"]);
  // Chat and Cowork share a list, Code has its own.
  assert.deepEqual(listedIds(all, "chat"), ["chat"]);
  assert.deepEqual(listedIds([], "code"), []);
});

test("the drawn rows are read from the sidebar in order, once each", () => {
  const rows = ["x", "y", "x", ""].map((id) => ({
    dataset: { conversationId: id },
  }));
  let asked = "";
  const root = {
    querySelectorAll: (selector: string) => {
      asked = selector;
      return rows;
    },
  } as never;
  assert.deepEqual(drawnIds(root), ["x", "y"]);
  assert.match(asked, /^\.sidebar-scroll /);
});

test("the menu state enables Previous and Next only when the sidebar lists a row", () => {
  const input = {
    mode: "code" as const,
    sidebarOpen: true,
    sidebarEnabled: true,
    canGoBack: false,
    canGoForward: false,
    inCodeConversation: false,
    isOpen: () => false,
    terminalAvailable: false,
    browserAvailable: false,
    artifactOpen: false,
    anyPanelOpen: false,
    canReopenClosed: false,
  };
  assert.equal(menuStateFor(input).canCycleSession, false);
  assert.equal(
    menuStateFor({ ...input, canCycleSession: true }).canCycleSession,
    true,
  );
});

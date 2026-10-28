import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Conversation, Turn } from "../../shared/types";
import { ReplyToolbar } from "../../src/transcript/ReplyToolbar";
import {
  asksFirst,
  closeSpinOff,
  expandedRoom,
  expandedSlots,
  openQuickTask,
  openSpinOff,
  openTaskWindow,
  promptLink,
  setSpinOffMinimized,
  setSpinOffSession,
  spinOffWindows,
  takeSpinOffSeed,
} from "../../src/cowork/spin-off-store";
import { openAddressPrompt } from "../../src/cowork/prompt-links";

const clear = () => {
  for (const item of spinOffWindows()) closeSpinOff(item.id);
};

// Three windows at most; a fourth draft cannot open, but a started task's
// window gives way.
test("three drafts fill the composer; a started task gives way", () => {
  clear();
  assert.equal(openSpinOff("c", "t1"), 0);
  assert.equal(openSpinOff("c", "t2"), 1);
  assert.equal(openSpinOff("c", "t3"), 2);
  assert.equal(openSpinOff("c", "t4"), null);
  const [first] = spinOffWindows();
  setSpinOffSession(first.id, "task-1");
  assert.equal(openSpinOff("c", "t4"), 0);
  assert.equal(spinOffWindows().length, 3);
  assert.ok(!spinOffWindows().some((item) => item.sessionId === "task-1"));
  clear();
});

test("a freed slot is taken again; expanding raises a window", () => {
  clear();
  openSpinOff("c", "a");
  openSpinOff("c", "b");
  const [a, b] = spinOffWindows();
  closeSpinOff(a.id);
  assert.equal(openSpinOff("c", "c"), 0);
  setSpinOffMinimized(b.id, true);
  assert.equal(expandedSlots(spinOffWindows(), 3).has(1), false);
  setSpinOffMinimized(b.id, false);
  // The most recently raised wins the only expanded place.
  assert.deepEqual([...expandedSlots(spinOffWindows(), 1)], [1]);
  clear();
});

test("a Cowork reply's toolbar has More options only with Spin off", () => {
  const turn = {
    id: "t",
    prompt: "Hi",
    attachments: [],
    items: [],
    status: "completed",
    createdAt: 0,
  } as unknown as Turn;
  const conversation = {
    id: "c",
    mode: "cowork",
    turns: [turn],
  } as unknown as Conversation;
  const render = (onSpinOff?: () => void) =>
    renderToStaticMarkup(
      createElement(ReplyToolbar, {
        conversation,
        turn,
        busy: false,
        versions: false,
        onRating: async () => {},
        onRetry: () => {},
        onSelect: () => {},
        onError: () => {},
        onSpinOff,
      }),
    );
  assert.match(
    render(() => {}),
    /aria-label="More options"/,
  );
  assert.doesNotMatch(render(), /More options/);
});

test("a window on a task is raised again instead of opened twice", () => {
  clear();
  assert.equal(openTaskWindow("session_menu", { sessionId: "s1" }), 0);
  openSpinOff("c", "t");
  const [first] = spinOffWindows();
  setSpinOffMinimized(first.id, true);
  assert.equal(openTaskWindow("session_menu", { sessionId: "s1" }), 0);
  assert.equal(spinOffWindows().length, 2);
  assert.equal(spinOffWindows()[0].minimized, false);
  clear();
});

test("Open as quick task: a full row refuses a task, raises for a draft", () => {
  clear();
  openSpinOff("c", "a");
  openSpinOff("c", "b");
  openSpinOff("c", "c");
  assert.equal(openQuickTask("session_menu", { sessionId: "s" }), false);
  const last = spinOffWindows().at(-1)!;
  setSpinOffMinimized(last.id, true);
  assert.equal(openQuickTask("url", { seed: { prompt: "hi" } }), true);
  assert.equal(spinOffWindows().at(-1)!.minimized, false);
  assert.equal(spinOffWindows().length, 3);
  clear();
});

test("a seed is given once; outside prompts ask first", () => {
  clear();
  openTaskWindow("artifact_link", { seed: { prompt: "Plan", unsafe: true } });
  const [item] = spinOffWindows();
  assert.deepEqual(item.seed, { prompt: "Plan", unsafe: true });
  takeSpinOffSeed(item.id);
  assert.equal(spinOffWindows()[0].seed, undefined);
  assert.equal(asksFirst("artifact_link"), true);
  assert.equal(asksFirst("url"), true);
  assert.equal(asksFirst("branch"), false);
  assert.equal(asksFirst("session_menu"), false);
  clear();
});

test("prompt links: /new with composer=mini and words, on a known origin", () => {
  const origins = ["https://app.example", "https://claude.ai"];
  const link = (href: string) => promptLink(href, origins);
  assert.equal(
    link("https://claude.ai/new?q=Draft%20a%20plan&composer=mini"),
    "Draft a plan",
  );
  assert.equal(link("https://app.example/new?composer=mini&q=x"), "x");
  assert.equal(link("https://claude.ai/new?q=x"), null);
  assert.equal(link("https://claude.ai/new?q=%20&composer=mini"), null);
  assert.equal(link("https://evil.example/new?q=x&composer=mini"), null);
  assert.equal(link("https://u:p@claude.ai/new?q=x&composer=mini"), null);
  assert.equal(link("https://claude.ai/chat?q=x&composer=mini"), null);
  assert.equal(
    link(`https://claude.ai/new?composer=mini&q=${"a".repeat(14337)}`),
    null,
  );
  assert.equal(link("not a url"), null);
});

test("an address prompt opens one window per prompt while there is room", () => {
  clear();
  assert.equal(openAddressPrompt("Summarize"), true);
  assert.equal(openAddressPrompt("Summarize"), true);
  assert.equal(spinOffWindows().length, 1);
  assert.equal(spinOffWindows()[0].source, "url");
  openSpinOff("c", "a");
  openSpinOff("c", "b");
  assert.equal(openAddressPrompt("Other"), false);
  clear();
});

test("as many expand as fit 416px each beside 256px collapsed ones", () => {
  assert.equal(expandedRoom(2000, 3), 3);
  assert.equal(expandedRoom(416 * 2 + 256 + 24, 3), 2);
  assert.equal(expandedRoom(500, 3), 1);
  assert.equal(expandedRoom(300, 1), 1);
});

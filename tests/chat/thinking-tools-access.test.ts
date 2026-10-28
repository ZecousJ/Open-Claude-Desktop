import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Item } from "../../shared/types";
import { THINKING_VERBS } from "../../src/transcript/TurnActivity";
import {
  MemoryToolView,
  memoryToolTitle,
  pastChatsTitle,
} from "../../src/transcript/tools/MemoryToolView";
import { WebSearchView } from "../../src/transcript/tools/WebSearchView";
import { stepLine } from "../../src/transcript/chat-step-lines";
import { toolGroupSummary } from "../../src/transcript/tools/tool-group-summary";
import { researchCardText } from "../../src/research/ResearchCard";
import { ComposerAddMenu } from "../../src/composer/ComposerAddMenu";

test("Chat and Cowork use exactly the live October 14 thinking verbs", () => {
  assert.deepEqual(THINKING_VERBS, [
    "Thinking",
    "Sifting",
    "Fathoming",
    "Honing",
    "Weighing",
    "Pondering",
    "Contemplating",
    "Cogitating",
    "Picturing",
    "Figuring",
    "Reckoning",
    "Mulling",
    "Triangulating",
    "Crystallizing",
    "Sleuthing",
    "Untangling",
  ]);
});

const memory = (command: string): Item => ({
  id: command,
  type: "dynamicToolCall",
  namespace: "claudex_memory",
  tool: "memory_edits",
  arguments: { command },
  lifecycleStatus: "completed",
});

test("memory rows distinguish reading, adding, editing, errors and interruption", () => {
  assert.equal(memoryToolTitle(memory("view")), "Read memory");
  assert.equal(memoryToolTitle(memory("add")), "Added to memory");
  assert.equal(memoryToolTitle(memory("remove")), "Updated memory");
  assert.equal(
    memoryToolTitle({ ...memory("view"), lifecycleStatus: "inProgress" }),
    "Reading memory",
  );
  assert.equal(
    memoryToolTitle({ ...memory("add"), lifecycleStatus: "inProgress" }),
    "Adding to memory",
  );
  assert.equal(
    memoryToolTitle({ ...memory("view"), lifecycleStatus: "failed" }),
    "Couldn’t read memory",
  );
  assert.equal(
    memoryToolTitle({
      ...memory("add"),
      lifecycleStatus: "interrupted",
      success: false,
    }),
    "Stopped creating memory",
  );
  assert.equal(
    toolGroupSummary([memory("replace"), memory("view"), memory("add")]),
    "Read, added to, and updated memory",
  );
  assert.equal(
    toolGroupSummary([memory("view"), memory("view")]),
    "Read memory",
  );
  assert.equal(
    pastChatsTitle({ ...memory("view"), tool: "conversation_search" }),
    "Searched past chats",
  );
});

test("stopped searches keep sources and do not become successful or failed searches", () => {
  const item: Item = {
    id: "search",
    type: "webSearch",
    query: "test",
    status: "failed",
    lifecycleStatus: "interrupted",
    sources: [{ url: "https://example.com", title: "Source" }],
  };
  assert.equal(stepLine(item).text, "Stopped searching the web");
  const html = renderToStaticMarkup(createElement(WebSearchView, { item }));
  assert.match(html, /Stopped searching the web/);
  assert.match(html, /Source/);
  assert.doesNotMatch(html, /Failed to search|Searched the web/);
  const complete: Item = {
    ...item,
    status: "completed",
    lifecycleStatus: "completed",
  };
  const mixed = renderToStaticMarkup(
    createElement(WebSearchView, { item: complete, items: [complete, item] }),
  );
  assert.match(mixed, /Stopped searching the web/);
  assert.equal(
    stepLine({ ...complete, lifecycleStatus: "inProgress" }).text,
    "Searching the web",
  );
  assert.equal(stepLine(complete).text, "Searched the web");
});

test("research access failures use the required model or the official fallback", () => {
  const state = {
    state: "failed",
    error: "model_access",
    startedAt: 1,
    sourceCount: 0,
  } as const;
  assert.deepEqual(researchCardText({ ...state, errorModel: "Model X" }), {
    title: "Something went wrong",
    detail: "Research requires Model X, which you don’t have access to",
  });
  assert.equal(
    researchCardText(state).detail,
    "Research requires a model you don’t have access to",
  );
});

test("the tools menu exposes the checked extended thinking toggle without a paywall or preview badge", () => {
  const html = renderToStaticMarkup(
    createElement(ComposerAddMenu, {
      platform: "darwin",
      projects: [],
      webSearch: true,
      webSearchAvailable: true,
      onWebSearch() {},
      thinking: true,
      onThinking() {},
      onClose() {},
      onFiles() {},
      onProject() {},
      onCreateProject() {},
      onSettings() {},
      onUnavailable() {},
    }),
  );
  assert.match(
    html,
    /role="menuitemcheckbox" aria-checked="true"[^>]*>.*?Extended thinking/s,
  );
  assert.doesNotMatch(html, /Research preview|paid plans/);
});

test("a memory row shows a check when done, Removing from memory while it runs and a warning strip when it fails", () => {
  assert.equal(
    memoryToolTitle({ ...memory("remove"), lifecycleStatus: "inProgress" }),
    "Removing from memory",
  );
  const done = renderToStaticMarkup(
    createElement(MemoryToolView, { item: memory("add") }),
  );
  assert.match(done, /Added to memory/);
  assert.match(done, /data-icon="Check"/);
  assert.doesNotMatch(done, /memory-tool-warning/);
  const failed = renderToStaticMarkup(
    createElement(MemoryToolView, {
      item: { ...memory("add"), lifecycleStatus: "failed" },
    }),
  );
  assert.match(failed, /memory-tool-warning/);
  assert.match(failed, /aria-live="assertive"/);
});

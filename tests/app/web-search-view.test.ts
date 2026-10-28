import test, { before } from "node:test";
import { preloadWebFetchRow } from "../../src/transcript/tools/WebFetchRow";
before(() => preloadWebFetchRow());
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ItemView } from "../../src/ui/ItemView";
import type { Item } from "../../shared/types";

const render = (item: Item) =>
  renderToStaticMarkup(
    createElement(ItemView, { item, mode: "chat", onArtifact() {} }),
  );

test("web search activity renders its action and query without raw protocol JSON", () => {
  const running = render({
    id: "search",
    type: "webSearch",
    query: "synthetic <script>",
    action: { type: "search", queries: ["synthetic <script>"] },
    lifecycleStatus: "inProgress",
  });
  assert.match(running, /Searching the web/);
  assert.match(running, /synthetic &lt;script&gt;/);
  assert.doesNotMatch(running, /<script>|"type": "webSearch"/);
  const page = render({
    id: "page",
    type: "webSearch",
    query: "",
    action: { type: "openPage", url: "https://example.invalid/test" },
    lifecycleStatus: "completed",
  });
  assert.match(page, /Fetched/);
  assert.match(page, /https:\/\/example.invalid\/test/);
});

const source = (n: number, extra: Record<string, string> = {}) => ({
  url: `https://site${n}.example/page`,
  title: `Result ${n}`,
  ...extra,
});

test("a finished search shows its result count and lists titles and hosts", () => {
  const html = render({
    id: "ws",
    type: "webSearch",
    query: "synthetic",
    action: { type: "search", query: "synthetic" },
    lifecycleStatus: "completed",
    searchTool: "web_search",
    sources: [
      source(1, { title: "<b>Bold</b> title" }),
      { url: "https://www.site2.example/x" },
      { url: "javascript:alert(1)", title: "bad" },
      source(1),
    ],
  });
  assert.match(html, /Searched the web/);
  assert.match(html, /web-search-meta">2 results</);
  assert.match(html, /role="list" aria-labelledby=/);
  assert.match(html, />Results<\/div>/);
  assert.match(html, /&lt;b&gt;Bold&lt;\/b&gt; title/);
  assert.match(html, /web-search-result-host"><bdi>site1.example</);
  // No title: the address stands in; www. is not part of the host.
  assert.match(html, /web-search-result-host"><bdi>site2.example</);
  assert.doesNotMatch(html, /javascript:|>bad</);
});

test("the results table lists all sources without a ten-result cap", () => {
  const html = render({
    id: "ws",
    type: "webSearch",
    query: "many",
    action: { type: "search", query: "many" },
    lifecycleStatus: "completed",
    sources: Array.from({ length: 13 }, (_, n) => source(n)),
  });
  assert.match(html, /web-search-meta">13 results</);
  assert.equal((html.match(/class="web-search-result"/g) ?? []).length, 13);
  assert.doesNotMatch(html, /Show 3 more/);
  assert.equal((html.match(/class="site-icon /g) ?? []).length, 13);
});

test("a search without a page list keeps its queries and shows no count", () => {
  const html = render({
    id: "ws",
    type: "webSearch",
    query: "only query",
    action: { type: "search", query: "only query" },
    lifecycleStatus: "completed",
  });
  assert.match(html, /Searched the web/);
  assert.match(html, /only query/);
  assert.doesNotMatch(html, /result/);
});

test("failed searches say so and do not open; X searches say X", () => {
  const failed = render({
    id: "ws",
    type: "webSearch",
    query: "q",
    action: { type: "search", query: "q" },
    lifecycleStatus: "failed",
  });
  assert.match(failed, /Failed to search the web/);
  assert.doesNotMatch(failed, /<details/);
  const x = render({
    id: "xs",
    type: "webSearch",
    query: "from:someone",
    action: { type: "search", query: "from:someone" },
    lifecycleStatus: "completed",
    searchTool: "x_search",
    sources: [{ url: "https://x.com/someone/status/1" }],
  });
  assert.match(x, /Searched X/);
  assert.match(x, /web-search-meta">1 result</);
  const running = render({
    id: "xs",
    type: "webSearch",
    query: "live",
    action: { type: "search", query: "live" },
    lifecycleStatus: "inProgress",
    searchTool: "x_search",
  });
  assert.match(running, /Searching X/);
  assert.match(running, /web-search-meta">live</);
});

test("searches in Chat are steps of one group, each with its query and results", async () => {
  const { ChatTurnContent } =
    await import("../../src/transcript/ChatTurnContent");
  const { chatSegments } =
    await import("../../src/transcript/ChatActivityGroup");
  const search = (
    id: string,
    query: string,
    sources: Item["sources"],
  ): Item => ({
    id,
    type: "webSearch",
    query,
    action: { type: "search", query },
    lifecycleStatus: "completed",
    sources,
  });
  const items: Item[] = [
    search("a", "first query", [source(1), source(2)]),
    search("b", "second query", [source(2), source(3)]),
    {
      id: "p",
      type: "webSearch",
      query: "",
      action: { type: "openPage", url: "https://site1.example/page" },
      lifecycleStatus: "completed",
    },
    { id: "m", type: "agentMessage", text: "Done." },
  ];
  // Searches, X searches, failures and opened pages all fold into one group.
  assert.deepEqual(
    chatSegments([
      search("w", "web", [source(1)]),
      { ...search("x", "x", [source(2)]), searchTool: "x_search" },
      { ...search("f", "failed", undefined), lifecycleStatus: "failed" },
    ]).map((segment) => segment.items.map((item) => item.id)),
    [["w", "x", "f"]],
  );
  assert.deepEqual(
    chatSegments(items).map((segment) => segment.items.map((item) => item.id)),
    [["a", "b", "p"], ["m"]],
  );
  const html = renderToStaticMarkup(
    createElement(ChatTurnContent, {
      turn: {
        id: "t",
        prompt: "?",
        attachments: [],
        status: "completed",
        createdAt: 0,
        items,
      },
      awaitingApproval: false,
      onArtifact() {},
    }),
  );
  assert.match(html, /activity-label">Searched the web</);
  // The group is closed once done; each step's row names what it did.
  const { stepLine } = await import("../../src/transcript/chat-step-lines");
  assert.deepEqual(
    items.slice(0, 3).map((item) => stepLine(item)),
    [
      { text: "Searched the web", name: "first query" },
      { text: "Searched the web", name: "second query" },
      { text: "Fetched https://site1.example/page" },
    ],
  );
});
import { before as beforeChatSteps } from "node:test";
import { preloadChatSteps } from "../../src/transcript/ChatTurnContent";
beforeChatSteps(() => preloadChatSteps());

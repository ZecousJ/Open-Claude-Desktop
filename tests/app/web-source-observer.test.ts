import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  augmentWebSearchRequest,
  citationSpan,
  webSourcesFromResponse,
} from "../../server/web-source-observer";
import {
  maxSourcesPerSearch,
  parseWebSourcesSignal,
  sourceUrl,
} from "../../shared/gateway-signals";

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const done = (item: Record<string, unknown>) => ({
  type: "response.output_item.done",
  item,
});

test("web search requests ask for sources; grok models may also search X", () => {
  const request = {
    model: "grok-4",
    include: ["reasoning.encrypted_content"],
    tools: [{ type: "function", name: "exec_command" }, { type: "web_search" }],
  };
  const snapshot = structuredClone(request);
  const plain = augmentWebSearchRequest(request, { xSearch: false });
  assert.deepEqual(request, snapshot, "Codex's request is not changed");
  assert.deepEqual(plain.include, [
    "reasoning.encrypted_content",
    "web_search_call.action.sources",
  ]);
  assert.equal(plain.tools.length, 2);
  const grok = augmentWebSearchRequest(request, { xSearch: true });
  assert.deepEqual(grok.tools.at(-1), { type: "x_search" });
  assert.deepEqual(grok.include, [
    "reasoning.encrypted_content",
    "web_search_call.action.sources",
    "x_search_call.action.sources",
  ]);
  // Idempotent: nothing is added twice.
  assert.deepEqual(augmentWebSearchRequest(grok, { xSearch: true }), grok);
  // Without the web search tool (web search off) nothing changes, X included.
  const off = { model: "grok-4", tools: [{ type: "function", name: "x" }] };
  assert.equal(augmentWebSearchRequest(off, { xSearch: true }), off);
});

test("an OpenAI web search call reports its sources", () => {
  const event = webSourcesFromResponse(
    done({
      id: "ws_1",
      type: "web_search_call",
      status: "completed",
      action: {
        type: "search",
        query: "capital of france",
        sources: [
          { type: "url", url: "https://a.example/x", title: " A  page " },
          { type: "url", url: "https://a.example/x" },
          { type: "url", url: "javascript:alert(1)" },
          { type: "url", url: "data:text/html,hi" },
          { type: "url", url: "https://user:pw@evil.example/" },
          { type: "url", url: "https://b.example/" + "p".repeat(3000) },
          { type: "url", url: "http://c.example/y" },
        ],
      },
    }),
    "thread-1",
  );
  assert.deepEqual(event, {
    kind: "search",
    threadId: "thread-1",
    callId: "ws_1",
    tool: "web_search",
    status: "completed",
    queries: ["capital of france"],
    sources: [
      { url: "https://a.example/x", title: "A page" },
      { url: "http://c.example/y" },
    ],
  });
});

test("grok's X search call is reported as an X search", () => {
  const event = webSourcesFromResponse(
    done({
      id: "xs_1",
      type: "x_search_call",
      status: "failed",
      action: {
        type: "search",
        query: "paris",
        queries: ["paris", "paris news"],
        sources: [{ url: "https://x.com/a/status/1" }],
      },
    }),
    "t",
  );
  assert.equal(event?.kind, "search");
  if (event?.kind !== "search") return;
  assert.equal(event.tool, "x_search");
  assert.equal(event.status, "failed");
  assert.deepEqual(event.queries, ["paris", "paris news"]);
  assert.deepEqual(event.sources, [{ url: "https://x.com/a/status/1" }]);
});

test("sources are capped per search", () => {
  const sources = Array.from({ length: 150 }, (_, i) => ({
    url: `https://s${i}.example/`,
  }));
  const event = webSourcesFromResponse(
    done({ id: "ws", type: "web_search_call", action: { sources } }),
    "t",
  );
  assert.equal(
    event?.kind === "search" && event.sources.length,
    maxSourcesPerSearch,
  );
});

test("message annotations become UTF-16 citations of the message text", () => {
  const text =
    "中文 😀 Paris is the capital ([a.example](https://a.example/x)).";
  const url = "https://a.example/x";
  const u16Start = text.indexOf("([a.example]");
  const u16End = text.indexOf(")).") + 2;
  // OpenAI counts code points: the emoji is one position.
  const points = (index: number) => Array.from(text.slice(0, index)).length;
  const event = webSourcesFromResponse(
    done({
      id: "msg_1",
      type: "message",
      role: "assistant",
      content: [
        {
          type: "output_text",
          text,
          annotations: [
            {
              type: "url_citation",
              url,
              title: "A",
              start_index: points(u16Start),
              end_index: points(u16End),
            },
            { type: "file_citation", start_index: 0, end_index: 2 },
            {
              type: "url_citation",
              url: "javascript:x",
              start_index: 0,
              end_index: 2,
            },
          ],
        },
      ],
    }),
    "t",
  );
  assert.deepEqual(event, {
    kind: "message",
    threadId: "t",
    itemId: "msg_1",
    textLength: text.length,
    textHash: sha(text),
    citations: [{ url, title: "A", start: u16Start, end: u16End }],
  });
});

test("offsets in UTF-16 units or UTF-8 bytes are recognised by the cited page", () => {
  const text = "é 😀 see ([b.example](https://b.example/p)) now";
  const url = "https://b.example/p";
  const start = text.indexOf("(["),
    end = text.indexOf(")) ") + 2;
  const bytes = (index: number) =>
    new TextEncoder().encode(text.slice(0, index)).length;
  assert.deepEqual(citationSpan(text, start, end, url), { start, end });
  assert.deepEqual(citationSpan(text, bytes(start), bytes(end), url), {
    start,
    end,
  });
  // No evidence either way: code points win.
  const plain = "😀abcdef";
  assert.deepEqual(citationSpan(plain, 1, 3, "https://z.example/"), {
    start: 2,
    end: 4,
  });
  // Out of range and empty spans are dropped.
  assert.equal(citationSpan("abc", 2, 9, url), undefined);
  assert.equal(citationSpan("abc", 2, 2, url), undefined);
  assert.equal(citationSpan("abc", -1, 2, url), undefined);
  // A span that would split the emoji is not a reading.
  assert.deepEqual(citationSpan("😀x", 1, 2, url), { start: 2, end: 3 });
});

test("a multi-part message indexes the joined text", () => {
  const first = "One. ",
    second = "Two (https://c.example/).";
  const event = webSourcesFromResponse(
    done({
      id: "msg_2",
      type: "message",
      role: "assistant",
      content: [
        { type: "output_text", text: first, annotations: [] },
        {
          type: "output_text",
          text: second,
          annotations: [
            {
              type: "url_citation",
              url: "https://c.example/",
              start_index: 4,
              end_index: 24,
            },
          ],
        },
      ],
    }),
    "t",
  );
  assert.equal(event?.kind, "message");
  if (event?.kind !== "message") return;
  assert.equal(event.textHash, sha(first + second));
  assert.deepEqual(event.citations[0], {
    url: "https://c.example/",
    start: first.length + 4,
    end: first.length + 24,
  });
});

test("a message without citations, or a user message, reports nothing", () => {
  assert.equal(
    webSourcesFromResponse(
      done({
        id: "m",
        type: "message",
        content: [{ type: "output_text", text: "hi", annotations: [] }],
      }),
      "t",
    ),
    undefined,
  );
  assert.equal(
    webSourcesFromResponse(
      done({ id: "m", type: "message", role: "user", content: [] }),
      "t",
    ),
    undefined,
  );
});

test("xAI's response citations list names the last message", () => {
  const event = webSourcesFromResponse(
    {
      type: "response.completed",
      response: {
        id: "resp_1",
        output: [
          { id: "msg_a", type: "message" },
          { id: "xs_1", type: "x_search_call" },
          { id: "msg_b", type: "message" },
        ],
        citations: [
          "https://x.com/a/status/1",
          { url: "https://d.example/" },
          "https://x.com/a/status/1",
          "ftp://nope.example/",
        ],
      },
    },
    "t",
  );
  assert.deepEqual(event, {
    kind: "citations",
    threadId: "t",
    responseId: "resp_1",
    messageId: "msg_b",
    urls: ["https://x.com/a/status/1", "https://d.example/"],
  });
});

test("nothing is reported without a thread or for other events", () => {
  const search = done({ id: "ws", type: "web_search_call", action: {} });
  assert.equal(webSourcesFromResponse(search, undefined), undefined);
  assert.equal(webSourcesFromResponse(search, "x".repeat(501)), undefined);
  assert.equal(
    webSourcesFromResponse({ type: "response.output_text.delta" }, "t"),
    undefined,
  );
  assert.equal(
    webSourcesFromResponse({ type: "response.completed", response: {} }, "t"),
    undefined,
  );
  assert.equal(webSourcesFromResponse(null, "t"), undefined);
});

test("the main process drops signals that break the limits", () => {
  assert.equal(sourceUrl("https://ok.example/a"), "https://ok.example/a");
  assert.equal(sourceUrl("mailto:a@b.c"), undefined);
  for (const bad of [
    {
      kind: "search",
      threadId: "t",
      callId: "c",
      tool: "bing",
      queries: [],
      sources: [],
      status: "completed",
    },
    {
      kind: "search",
      threadId: "t",
      callId: "c",
      tool: "web_search",
      queries: [],
      sources: [],
      status: "running",
    },
    {
      kind: "message",
      threadId: "t",
      textLength: 5,
      textHash: "zz",
      citations: [],
    },
    {
      kind: "message",
      threadId: "t",
      textLength: 5,
      textHash: "a".repeat(64),
      citations: [{ url: "https://a.example/", start: 2, end: 9 }],
    },
    {
      kind: "citations",
      threadId: "t",
      responseId: "r",
      urls: ["javascript:x"],
    },
    { kind: "other", threadId: "t" },
    {
      kind: "search",
      threadId: "t",
      callId: "c",
      tool: "web_search",
      queries: ["q".repeat(1_100_000)],
      sources: [],
      status: "completed",
    },
  ])
    assert.equal(
      parseWebSourcesSignal(bad),
      undefined,
      JSON.stringify(bad).slice(0, 80),
    );
});

test("a search with the most and longest sources still fits in one signal", () => {
  const long = "https://example.com/" + "a".repeat(2000);
  const sources = Array.from({ length: 150 }, (_, index) => ({
    url: `${long}${index}`,
    title: "\u{1F600}".repeat(400),
    snippet: "\u{1F600}".repeat(800),
  }));
  const event = webSourcesFromResponse(
    {
      type: "response.output_item.done",
      item: {
        type: "web_search_call",
        id: "ws_big",
        status: "completed",
        action: { type: "search", query: "q", sources },
      },
    },
    "thread",
  );
  assert.equal(event?.kind, "search");
  assert.equal(event?.kind === "search" && event.sources.length, 100);
});

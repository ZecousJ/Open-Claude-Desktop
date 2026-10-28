import test, { before } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { McpToolView } from "../../src/transcript/tools/McpToolView";
import {
  recordItemLifecycle,
  recordMcpProgress,
  finishTurn,
} from "../../shared/activity";
import type { Item, Turn } from "../../shared/types";
import { preloadBrowserToolView } from "../../src/transcript/tools/McpToolView";

before(() => preloadBrowserToolView());
const render = (item: Item) =>
  renderToStaticMarkup(createElement(McpToolView, { item }));

test("MCP progress before item start remains visible, then settles without stale updates", () => {
  const turn: Turn = {
    id: "turn",
    prompt: "synthetic",
    attachments: [],
    createdAt: 1,
    status: "inProgress",
    items: [],
  };
  assert.equal(
    recordMcpProgress(turn, "tool", "Searching synthetic records"),
    true,
  );
  assert.match(render(turn.items[0]), /Searching synthetic records/);
  recordItemLifecycle(
    turn,
    {
      id: "tool",
      type: "mcpToolCall",
      server: "fixture",
      tool: "lookup",
      status: "inProgress",
      arguments: { q: "one" },
    },
    false,
  );
  assert.match(render(turn.items[0]), /Using fixture · lookup/);
  assert.match(render(turn.items[0]), /Searching synthetic records/);
  recordItemLifecycle(
    turn,
    {
      id: "tool",
      type: "mcpToolCall",
      server: "fixture",
      tool: "lookup",
      status: "completed",
      result: { content: [{ type: "text", text: "Found one" }] },
    },
    true,
  );
  assert.equal(recordMcpProgress(turn, "tool", "late progress"), false);
  assert.match(render(turn.items[0]), /Found one/);
  assert.doesNotMatch(
    render(turn.items[0]),
    /late progress|Searching synthetic records/,
  );
  finishTurn(turn, "completed");
  assert.equal(recordMcpProgress(turn, "unknown", "late"), false);
  assert.equal(turn.items.length, 1);
});
test("MCP tool presents escaped inputs, text, structured data, bounded images and failures", () => {
  const base: Item = {
    id: "mcp",
    type: "mcpToolCall",
    server: "fixture",
    tool: "read",
    status: "completed",
    arguments: { query: "<script>alert(1)</script>" },
  };
  const good = render({
    ...base,
    result: {
      content: [
        { type: "text", text: "result <b>safe</b>" },
        { type: "image", mimeType: "image/png", data: "aGVsbG8=" },
        { type: "image", mimeType: "image/svg+xml", data: "PHN2Zz4=" },
        {
          type: "resource",
          resource: { uri: "file:///synthetic/item", text: "resource text" },
        },
      ],
      structuredContent: { count: 1 },
    },
  });
  assert.match(good, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(good, /result &lt;b&gt;safe&lt;\/b&gt;/);
  assert.match(good, /data:image\/png;base64,aGVsbG8=/);
  assert.doesNotMatch(good, /data:image\/svg\+xml|PHN2Zz4=/);
  assert.match(good, /file:\/\/\/synthetic\/item/);
  assert.match(good, /&quot;count&quot;: 1/);
  const failed = render({
    ...base,
    status: "failed",
    error: { message: "Synthetic denied" },
    result: null,
  });
  assert.match(failed, /fixture · read failed/);
  assert.match(failed, /Synthetic denied/);
});

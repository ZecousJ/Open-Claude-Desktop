import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AgentPriorTool } from "../../src/transcript/agents/AgentPriorTool";
test("prior tool row opens its actual bounded MCP input and result", () => {
  const html = renderToStaticMarkup(
    createElement(AgentPriorTool, {
      item: {
        id: "tool",
        type: "mcpToolCall",
        server: "Claudex Docs",
        tool: "Edit doc",
        arguments: { document: "synthetic" },
        result: {
          content: [{ type: "text", text: "Updated synthetic document" }],
        },
      },
    }),
  );
  assert.match(html, /Used Claudex Docs: Edit doc/);
  assert.match(html, /<details/);
  assert.match(html, /synthetic/);
  assert.match(html, /Updated synthetic document/);
  assert.doesNotMatch(html, /raw protocol/);
});

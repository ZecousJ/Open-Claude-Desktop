import test from "node:test";
import assert from "node:assert/strict";
import { projectAgentItems } from "../../electron/conversations/agent-transcript-item";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AgentTranscriptBody } from "../../src/transcript/agents/AgentTranscriptBody";
test("child tool projection keeps bounded image results and explicitly marks oversized output", () => {
  const image = {
    type: "image",
    mimeType: "image/png",
    data: "A".repeat(100_000),
  };
  const small = projectAgentItems([
    { id: "mcp", type: "mcpToolCall", result: { content: [image] } },
  ]);
  assert.equal(small[0].result?.content[0].data, image.data);
  assert.equal(small[0].resultOmitted, false);
  const huge = projectAgentItems([
    {
      id: "large",
      type: "mcpToolCall",
      result: { content: [{ ...image, data: "A".repeat(2_200_000) }] },
    },
  ]);
  assert.equal(huge[0].result, undefined);
  assert.equal(huge[0].resultOmitted, true);
  assert.match(
    renderToStaticMarkup(createElement(AgentTranscriptBody, { items: huge })),
    /Large result omitted from this transcript/,
  );
  const many = projectAgentItems(
    Array.from({ length: 5 }, (_, i) => ({
      id: String(i),
      type: "mcpToolCall",
      result: { content: [{ ...image, data: "A".repeat(1_000_000) }] },
    })),
  );
  assert.equal(many.filter((item) => item.resultOmitted).length, 1);
});

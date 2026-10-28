import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ItemView } from "../../src/ui/ItemView";
import type { Item } from "../../shared/types";
import { toolSummary } from "../../src/code-tools/code-tool-model";
const render = (item: Item) =>
  renderToStaticMarkup(
    createElement(ItemView, { item, mode: "code", onArtifact() {} }),
  );

test("dynamic tool shows running, completed and failed states without raw protocol dumps", () => {
  const base: Item = {
    id: "dynamic",
    type: "dynamicToolCall",
    namespace: "fixture",
    tool: "lookup",
    arguments: { query: "<script>bad</script>" },
    status: "inProgress",
    lifecycleStatus: "inProgress",
  };
  const running = render(base);
  assert.match(running, /Using fixture: lookup/);
  assert.match(running, /&lt;script&gt;bad&lt;\/script&gt;/);
  assert.doesNotMatch(running, /<script>|"type": "dynamicToolCall"/);
  const completed = render({
    ...base,
    status: "completed",
    lifecycleStatus: "completed",
    success: true,
    contentItems: [
      { type: "inputText", text: "Safe <b>text</b>" },
      { type: "inputImage", imageUrl: "https://example.invalid/private" },
    ],
  });
  assert.match(completed, /Safe &lt;b&gt;text&lt;\/b&gt;/);
  assert.match(completed, /Image result available in the tool response/);
  assert.doesNotMatch(completed, /<img|example\.invalid\/private/);
  const failed = render({
    ...base,
    status: "failed",
    lifecycleStatus: "failed",
    success: false,
  });
  assert.match(failed, /Failed to use fixture: lookup/);
});
test("a failed connector call in Code is a red row with the error, then name: value arguments (R-0837)", () => {
  const html = render({
    id: "mcp-failed",
    type: "mcpToolCall",
    server: "preview",
    tool: "preview_eval",
    status: "failed",
    lifecycleStatus: "failed",
    arguments: { expression: "location.href" },
    error: { message: "MCP error -32602: serverId is required" },
  });
  assert.match(html, /data-failed="true">Failed to use preview: preview eval</);
  assert.match(html, /code-tool-call-error[^>]*>MCP error -32602/);
  assert.match(html, /<code>expression:<\/code>location\.href/);
  assert.doesNotMatch(html, /Input|Output/);
  const listed = render({
    id: "mcp-ok",
    type: "mcpToolCall",
    server: "preview",
    tool: "preview_list",
    status: "completed",
    lifecycleStatus: "completed",
    arguments: {},
    result: { content: [{ type: "text", text: "[]" }] },
  });
  assert.match(listed, /Used preview: preview list/);
  assert.match(listed, /code-tool-call-text">\[\]</);
});
test("a tool group counts its failed calls (R-0816)", () => {
  const call = (id: string, failed: boolean): Item => ({
    id,
    type: "mcpToolCall",
    server: "preview",
    tool: "t",
    status: failed ? "failed" : "completed",
    lifecycleStatus: failed ? "failed" : "completed",
  });
  assert.equal(
    toolSummary([call("a", false), call("b", true)]),
    "Used 2 tools (1 failed)",
  );
});
test("collaboration cards show agent states and sub-agent activity without leaking raw JSON", () => {
  const call: Item = {
    id: "collab",
    type: "collabAgentToolCall",
    tool: "spawnAgent",
    status: "inProgress",
    lifecycleStatus: "inProgress",
    prompt: "Review <private> fixture",
    receiverThreadIds: ["agent-one"],
    agentsStates: {
      "agent-one": { status: "running", message: "Reading synthetic file" },
    },
  };
  const running = render(call);
  assert.match(running, /Running agent/);
  assert.match(running, /1 agent/);
  assert.match(running, /Review &lt;private&gt; fixture/);
  assert.match(running, /Reading synthetic file/);
  const done = render({
    ...call,
    status: "completed",
    lifecycleStatus: "completed",
  });
  assert.match(done, /Ran agent/);
  assert.match(
    render({
      id: "activity",
      type: "subAgentActivity",
      kind: "interrupted",
      agentPath: "root\/worker",
    }),
    /Agent stopped/,
  );
});

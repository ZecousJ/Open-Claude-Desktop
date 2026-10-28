import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  McpToolView,
  preloadBrowserToolView,
} from "../../src/transcript/tools/McpToolView";
import { DynamicToolView } from "../../src/transcript/tools/DynamicToolView";
import { setLocale } from "../../src/i18n";
import type { Item } from "../../shared/types";

// A connector or MCP tool's row title is a sentence with the tool's name in
// it; the document translator only matches whole texts, so it is built from
// the catalog's templates.
before(async () => {
  await Promise.all([preloadBrowserToolView(), setLocale("zh-CN")]);
});
after(() => setLocale("en-US"));

const mcp = (status: Item["status"]): Item => ({
  id: "m",
  type: "mcpToolCall",
  server: "Docs",
  tool: "edit",
  status,
});
const dynamic = (status: Item["status"]): Item => ({
  id: "d",
  type: "dynamicToolCall",
  namespace: "Gmail",
  tool: "search",
  status,
});
const view = (item: Item) =>
  renderToStaticMarkup(
    createElement(item.type === "mcpToolCall" ? McpToolView : DynamicToolView, {
      item,
    }),
  );

test("MCP tool rows read in the chosen language", () => {
  assert.match(view(mcp("inProgress")), /正在使用 Docs · edit/);
  assert.match(view(mcp("completed")), /使用了 Docs: edit/);
  assert.match(view(mcp("failed")), /Docs · edit 失败/);
});

test("connector tool rows read in the chosen language", () => {
  assert.match(view(dynamic("completed")), /使用了 Gmail · search/);
  assert.match(view(dynamic("failed")), /Gmail · search 失败/);
});

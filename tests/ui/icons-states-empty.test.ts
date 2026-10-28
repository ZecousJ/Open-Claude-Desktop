import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { McpToolState } from "../../shared/settings-desktop-api";
import { pluginEmptyMessage } from "../../src/plugins/plugin-model";
import {
  filterConnectorTools,
  ToolPermissions,
} from "../../src/settings/tabs/ToolPermissions";
import { environmentMenu } from "../../src/ssh/model";

test("plugin browser empty lines use the live punctuation and filter branches", () => {
  assert.equal(pluginEmptyMessage({}, false), "No plugins available");
  assert.equal(
    pluginEmptyMessage({ category: "design" }, false),
    "No plugins match your filters",
  );
  assert.equal(
    pluginEmptyMessage({ marketplace: "official" }, false),
    "No plugins match your filters",
  );
  assert.equal(
    pluginEmptyMessage({ query: "missing" }, false),
    "No plugins match your search.",
  );
});

test("connector tools search trims and ignores case without changing permissions", () => {
  const tools = [
    { name: "Read_file", enabled: true, approval: "approve" },
    { name: "Write_file", enabled: false },
  ] as McpToolState[];
  assert.deepEqual(filterConnectorTools(tools, " READ_ "), [tools[0]]);
  assert.deepEqual(filterConnectorTools(tools, "   "), tools);
  assert.deepEqual(filterConnectorTools(tools, "missing"), []);
  assert.equal(filterConnectorTools(tools, "write")[0], tools[1]);
  const html = renderToStaticMarkup(
    createElement(ToolPermissions, {
      server: "Files",
      tools: [],
      editable: true,
      onSet() {},
    }),
  );
  assert.match(html, /aria-label="Search tools"/);
  assert.match(html, /connector-tools-empty">No tools match your search\.</);
});

test("SSH connections provide search and the live no-match line", () => {
  const entries = environmentMenu({
    selected: { kind: "local" },
    hosts: [],
    statuses: {},
    ssh: true,
    onLocal() {},
    onHost() {},
    onAdd() {},
  });
  const ssh = entries.find(
    (entry) => "label" in entry && entry.label === "SSH",
  );
  assert.ok(ssh && "label" in ssh);
  assert.equal(ssh.searchable, "Search");
  assert.equal(ssh.searchEmpty, "No matching connections");
});

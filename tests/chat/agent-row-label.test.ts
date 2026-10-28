import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CodeAgentRow } from "../../src/transcript/agents/SingleAgentEvent";
import { currentLocale, setLocale } from "../../src/i18n";
import type { WorkflowSummary } from "../../shared/workflow-model";

const task = (status: WorkflowSummary["status"]): WorkflowSummary => ({
  id: "a",
  kind: "agent",
  conversationId: "c",
  title: "Build docs",
  description: "",
  startedAt: 1,
  status,
  agents: [],
  phases: [],
});
const label = (status: WorkflowSummary["status"]) =>
  /aria-label="([^"]*)"/.exec(
    renderToStaticMarkup(
      createElement(CodeAgentRow, { task: task(status), onOpen() {} }),
    ),
  )?.[1];

test("an agent row names its state in words, never the raw status", async () => {
  assert.equal(label("running"), "Build docs, running. Open the agent");
  assert.equal(label("completed"), "Build docs. Open the agent");
  assert.equal(label("failed"), "Build docs, failed. Open the agent");
  assert.equal(label("stopped"), "Build docs, stopped. Open the agent");
  const previous = currentLocale();
  try {
    await setLocale("zh-CN");
    assert.equal(label("failed"), "Build docs，失败。打开该智能体");
    assert.equal(label("stopped"), "Build docs，已停止。打开该智能体");
  } finally {
    await setLocale(previous);
  }
});

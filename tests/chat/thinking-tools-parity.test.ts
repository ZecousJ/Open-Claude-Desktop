import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Conversation, Item, Settings } from "../../shared/types";
import { webFetchError, webFetchErrors } from "../../shared/web-fetch";
import {
  agentMessageOrigin,
  agentMessageTitle,
  peerMessage,
  recordAgentsStopped,
} from "../../shared/agent-messages";
import {
  cacheChangeBodies,
  cacheChangeTitles,
} from "../../src/cowork/cache-change-copy";
import { needsCacheConfirmation } from "../../shared/cowork-cache";
import {
  onDemandThinking,
  thinkingSummariesNotice,
  thinkingSummaryForTurn,
} from "../../shared/thinking-summaries";
import { projectAgentTranscript } from "../../electron/conversations/agent-transcript";
import { projectAgentItems } from "../../electron/conversations/agent-transcript-item";
import AgentMessageAttribution from "../../src/transcript/agents/AgentMessageAttributionContent";
import WebFetchErrorContent from "../../src/transcript/tools/WebFetchErrorContent";
import { AgentTranscriptBody } from "../../src/transcript/agents/AgentTranscriptBody";
import { WorkflowPhase } from "../../src/transcript/workflow/WorkflowPhase";
import { WorkflowTask } from "../../src/transcript/workflow/WorkflowTask";
import type { WorkflowSummary } from "../../shared/workflow-model";

const conversation = (patch: Partial<Conversation> = {}): Conversation => ({
  id: "session",
  title: "Fixture",
  mode: "code",
  providerId: "service",
  model: "model",
  pinned: false,
  archived: false,
  createdAt: 1,
  updatedAt: 1,
  turns: [
    {
      id: "turn",
      prompt: "Hello",
      attachments: [],
      createdAt: 1,
      status: "completed",
      items: [],
    },
  ],
  ...patch,
});
const settings = {} as Settings;

test("web fetch errors use the live bundle's eight failure messages, not raw codes", () => {
  for (const [code, message] of Object.entries(webFetchErrors)) {
    const item: Item = {
      id: code,
      type: "webSearch",
      action: { type: "openPage", url: "https://example.com" },
      error: { code },
    };
    assert.equal(webFetchError(item), message);
    assert.equal(
      webFetchError({
        ...item,
        error: undefined,
        result: {
          is_error: true,
          content: [
            { type: "text", text: JSON.stringify([{ error_type: code }]) },
          ],
        },
      }),
      message,
    );
    assert.equal(
      webFetchError({
        ...item,
        type: "dynamicToolCall",
        tool: "web_fetch",
        error: undefined,
        contentItems: [
          { type: "inputText", text: JSON.stringify([{ error_type: code }]) },
        ],
      }),
      message,
    );
    assert.equal(
      webFetchError(
        projectAgentItems([
          { ...item, type: "mcpToolCall", tool: "WebFetch" },
        ])[0],
      ),
      message,
    );
  }
  assert.equal(new Set(Object.values(webFetchErrors)).size, 8);
  assert.equal(
    webFetchError({
      id: "failure",
      type: "webSearch",
      action: { type: "openPage" },
      status: "failed",
    }),
    "An unknown error occurred",
  );
  assert.equal(
    webFetchError({
      id: "search",
      type: "webSearch",
      action: { type: "search" },
      error: "SITE_BLOCKED",
    }),
    undefined,
  );
  assert.equal(
    webFetchError({
      id: "success",
      type: "webSearch",
      action: { type: "openPage" },
    }),
    undefined,
  );
});

test("fetch errors are accessible warning tooltips rather than untranslated error codes", () => {
  const html = renderToStaticMarkup(
    createElement(WebFetchErrorContent, {
      item: {
        id: "fetch",
        type: "webSearch",
        action: { type: "openPage" },
        error: { code: "ROBOTS_DISALLOWED" },
      },
    }),
  );
  assert.match(
    html,
    /aria-label="This website has blocked Claudex via robots.txt rules"/,
  );
  assert.doesNotMatch(html, /ROBOTS_DISALLOWED/);
});

test("every added message has all eleven locale translations", async () => {
  const keys = new Set([
    ...Object.values(webFetchErrors),
    ...Object.values(cacheChangeTitles),
    ...Object.values(cacheChangeBodies),
    "Switch to {targetLabel}",
    "Extended thinking",
    "Standard",
    "Agent: {name}",
    "Sent by a subagent",
    "Report from subagent",
    "Message from subagent",
    "Message from another session",
    "Message from {name}",
    "All background agents stopped",
    "Other agents",
    "Thinking summaries will appear from the next response.",
    "Some agent activity isn’t shown. This session is too large to load in full.",
  ]);
  for (const locale of [
    "zh-CN",
    "ja-JP",
    "ko-KR",
    "de-DE",
    "fr-FR",
    "es-ES",
    "es-419",
    "it-IT",
    "pt-BR",
    "id-ID",
    "hi-IN",
  ]) {
    const catalog = (await import(`../../shared/i18n/catalogs/${locale}.ts`))
      .default;
    for (const key of keys)
      assert.equal(typeof catalog[key], "string", `${locale}: ${key}`);
  }
});

test("cache-cost confirmations are Cowork-only, skip an unused task and cover all change kinds", () => {
  const empty = conversation({ mode: "cowork" });
  assert.equal(needsCacheConfirmation("cowork", empty), false);
  empty.turns[0].items.push({
    id: "reply",
    type: "agentMessage",
    text: "Hello",
  });
  assert.equal(needsCacheConfirmation("cowork", empty), true);
  assert.equal(needsCacheConfirmation("chat", empty), false);
  assert.equal(needsCacheConfirmation("code", conversation()), false);
  assert.equal(cacheChangeTitles.thinking, "Change thinking mode?");
  assert.equal(cacheChangeTitles.effort, "Change effort level?");
  assert.equal(cacheChangeTitles.model, "Switch model?");
  for (const body of Object.values(cacheChangeBodies)) {
    assert.match(body, /slower and use more tokens/);
    assert.match(body, /<bold>\{targetLabel\}<\/bold>/);
    assert.match(body, /full history gets re-read on your next message\.$/);
  }
});

test("on-demand thinking is local Code and flag gated, and affects the next request", () => {
  const session = conversation();
  assert.equal(onDemandThinking(session, settings), true);
  assert.deepEqual(thinkingSummaryForTurn(session, settings), {
    summary: "none",
  });
  session.thinkingSummariesWanted = true;
  assert.deepEqual(thinkingSummaryForTurn(session, settings), {
    summary: "auto",
  });
  assert.equal(thinkingSummariesNotice(session, settings, true), true);
  assert.equal(thinkingSummariesNotice(session, settings, false), false);
  session.turns[0].items.push({
    id: "thought",
    type: "reasoning",
    summary: ["A summary"],
  });
  assert.equal(thinkingSummariesNotice(session, settings, true), false);
  assert.equal(
    thinkingSummariesNotice(conversation({ turns: [] }), settings, true),
    false,
  );
  for (const excluded of [
    conversation({ mode: "chat" }),
    conversation({ mode: "cowork" }),
    conversation({ environment: { kind: "space", spaceId: "remote" } }),
  ]) {
    assert.equal(onDemandThinking(excluded, settings), false);
    assert.deepEqual(thinkingSummaryForTurn(excluded, settings), {});
  }
  assert.deepEqual(
    thinkingSummaryForTurn(session, {
      ...settings,
      ccdThinkingSummaryOnDemand: false,
    }),
    {},
  );
});

test("peer reports and relayed agents retain attribution across the native transcript boundary", () => {
  const report: Item = {
    id: "report",
    type: "userMessage",
    content: [
      {
        type: "text",
        text: '<subagent_notification>{"agent_id":"child","status":{"completed":"Result"}}</subagent_notification>',
      },
    ],
  };
  const projected = projectAgentItems([report])[0];
  assert.equal(projected.type, "peerMessage");
  assert.equal(projected.text, "Result");
  assert.equal(
    agentMessageTitle(agentMessageOrigin(projected)!),
    "Report from subagent",
  );
  assert.equal(
    peerMessage({
      ...report,
      content: [{ type: "text", text: "An ordinary user message" }],
    }),
    undefined,
  );
  assert.equal(
    peerMessage({
      ...report,
      content: [
        {
          type: "text",
          text: "<subagent_notification>broken</subagent_notification>",
        },
      ],
    }),
    undefined,
  );
  const relayed = {
    ...projected,
    origin: {
      kind: "peer" as const,
      subagent: true,
      relayedAgent: { name: "<child>" },
    },
  };
  const markup = renderToStaticMarkup(
    createElement(AgentMessageAttribution, { item: relayed }),
  );
  assert.match(markup, /Message from subagent/);
  assert.match(markup, /Agent: <bdi>&lt;child&gt;<\/bdi>/);
  assert.match(
    renderToStaticMarkup(
      createElement(AgentMessageAttribution, {
        item: {
          ...relayed,
          origin: { kind: "peer", relayedAgent: {} },
        },
      }),
    ),
    /Sent by a subagent/,
  );
  assert.equal(
    agentMessageTitle({ kind: "peer", name: "Peer" }),
    "Message from {name}",
  );
  assert.equal(
    agentMessageTitle({ kind: "peer" }),
    "Message from another session",
  );
});

test("agent stop notices wait for the last active agent and are not duplicated", () => {
  const session = conversation();
  const item: Item = {
    id: "spawn",
    type: "collabAgentToolCall",
    receiverThreadIds: ["a", "b"],
    agentsStates: { a: { status: "interrupted" }, b: { status: "running" } },
  };
  session.turns[0].items.push(item);
  recordAgentsStopped(session);
  assert.equal(session.turns[0].items.length, 1);
  item.agentsStates.b.status = "interrupted";
  recordAgentsStopped(session);
  recordAgentsStopped(session);
  assert.equal(session.turns[0].items.length, 2);
  assert.equal(session.turns[0].items.at(-1)?.notice, "agents_killed");
});

test("the native 500-item transcript cap reports omissions, not a false empty state", () => {
  const project = (count: number) =>
    projectAgentTranscript(
      {
        turns: [
          {
            status: "completed",
            items: Array.from({ length: count }, (_, index) => ({
              id: String(index),
              type: "agentMessage",
              text: "Hello",
            })),
          },
        ],
      },
      "model",
      "prompt",
    );
  assert.equal(project(500).truncated, false);
  const truncated = project(501);
  assert.equal(truncated.truncated, true);
  assert.equal(truncated.items.length, 500);
  assert.equal(truncated.items[0].id, "1");
  assert.match(
    renderToStaticMarkup(createElement(AgentTranscriptBody, truncated)),
    /Some agent activity isn’t shown\. This session is too large to load in full\./,
  );
});

test("all four phase-empty messages already match the official state mapping", () => {
  for (const [taskStatus, copy] of Object.entries({
    running: "No agents have started yet",
    completed: "No agents ran in this phase",
    stopped: "Stopped before any agents started",
    failed: "Failed before any agents started",
  })) {
    const markup = renderToStaticMarkup(
      createElement(WorkflowPhase, {
        phase: { name: "Review", agents: [], completed: 0, status: "queued" },
        startedAt: 1,
        now: 2,
        initiallyOpen: true,
        taskStatus: taskStatus as
          "running" | "completed" | "stopped" | "failed",
      }),
    );
    assert.ok(markup.includes(copy));
  }
});

test("unphased agents use Other agents only alongside another phase", () => {
  const workflow: WorkflowSummary = {
    id: "workflow",
    kind: "workflow",
    conversationId: "session",
    title: "Fixture",
    description: "",
    startedAt: 1,
    status: "completed",
    agents: [],
    phases: [
      { name: "Review", agents: [], completed: 0, status: "completed" },
      { name: "Agents", agents: [], completed: 0, status: "completed" },
    ],
  };
  const markup = () =>
    renderToStaticMarkup(
      createElement(WorkflowTask, { workflow, now: 2, onError() {} }),
    );
  assert.match(markup(), /Other agents/);
  workflow.phases.shift();
  assert.doesNotMatch(markup(), /Other agents/);
});

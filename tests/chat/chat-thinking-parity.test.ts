import assert from "node:assert/strict";
import test, { before } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Item, Turn } from "../../shared/types";
import { webFetchPage } from "../../shared/web-fetch-item";
import {
  WebFetchRow,
  webFetchLabel,
  preloadWebFetchRow,
} from "../../src/transcript/tools/WebFetchRow";
import { ChatStepsGroup } from "../../src/transcript/ChatStepsGroup";
import { ItemView } from "../../src/ui/ItemView";
import {
  thoughtExpanded,
  setThoughtExpanded,
} from "../../src/transcript/thought-expansion";
import { codeToolCallLabel } from "../../src/code-tools/CodeToolCall";
import {
  AgentItems,
  preloadThinkingToolRecap,
} from "../../src/transcript/agents/AgentItems";
import { TranscriptViewContext } from "../../src/transcript-view/transcript-view-store";
import type { Conversation } from "../../shared/types";
import { toolGroupCaption } from "../../shared/tool-group-caption";
import { projectAgentItems } from "../../electron/conversations/agent-transcript-item";
import { readSource } from "../support/read-source";

const page: Item = {
  id: "fetch",
  type: "webSearch",
  status: "completed",
  action: { type: "openPage", url: "https://example.com/page" },
  result: { content: [{ title: "An <untrusted> title" }] },
};
before(() => preloadWebFetchRow());
before(() => preloadThinkingToolRecap());

test("fetch rows use titles, hostname while running and URL on failure", () => {
  assert.equal(webFetchPage(page).title, "An <untrusted> title");
  assert.equal(
    webFetchLabel({ ...page, status: "inProgress" }),
    "Fetching from example.com",
  );
  assert.equal(
    webFetchLabel({ ...page, action: {}, status: "inProgress" }),
    "Fetching from site",
  );
  assert.equal(
    webFetchLabel({ ...page, status: "failed" }),
    "Failed to fetch <b>https://example.com/page</b>",
  );
  const html = renderToStaticMarkup(createElement(WebFetchRow, { item: page }));
  assert.match(html, /Fetched/);
  assert.match(html, /An &lt;untrusted&gt; title/);
  assert.match(html, /target="_blank" rel="noopener noreferrer"/);
  assert.match(html, /width="16" height="16"/);
  assert.doesNotMatch(html, /<untrusted>|Opened a page/);
  const unsafe = renderToStaticMarkup(
    createElement(WebFetchRow, {
      item: {
        ...page,
        action: { type: "openPage", url: "javascript:alert(1)" },
      },
    }),
  );
  assert.doesNotMatch(unsafe, /href="javascript:/);
});

test("native fetch tools retain result titles and failure states", () => {
  const item: Item = {
    id: "native",
    type: "mcpToolCall",
    tool: "WebFetch",
    arguments: { url: "https://example.com" },
    status: "completed",
    result: { content: [{ type: "text", text: '[{"title":"Native title"}]' }] },
  };
  assert.equal(webFetchPage(item).title, "Native title");
  assert.match(
    renderToStaticMarkup(
      createElement(ItemView, { item, mode: "code", onArtifact() {} }),
    ),
    /Native title/,
  );
  assert.match(
    webFetchLabel({ ...item, result: { is_error: true } }),
    /Failed to fetch/,
  );
});

test("thought expansion defaults open and survives keyed remounts", () => {
  const key = "fixture:thinking:thought";
  assert.equal(thoughtExpanded(key), true);
  setThoughtExpanded(key, false);
  assert.equal(thoughtExpanded(key), false);
  assert.equal(thoughtExpanded("another:thinking:thought"), true);
  setThoughtExpanded(key, true);
  const thought: Item = {
    id: "visible-thought",
    type: "reasoning",
    summary: ["Reviewing the evidence.\nFull thought body."],
    status: "completed",
  };
  const turn: Turn = {
    id: "visible-turn",
    prompt: "Test",
    attachments: [],
    createdAt: 1,
    status: "completed",
    items: [thought],
  };
  const html = renderToStaticMarkup(
    createElement(ChatStepsGroup, {
      items: turn.items,
      turn,
      active: false,
      awaitingApproval: false,
      onArtifact() {},
    }),
  );
  // A finished group stays closed to its row; its thought steps open by
  // default once it is opened.
  assert.match(html, /aria-expanded="false"/);
  assert.doesNotMatch(html, /Full thought body/);
  assert.match(
    renderToStaticMarkup(
      createElement(ItemView, { item: thought, mode: "code", onArtifact() {} }),
    ),
    /class="activity reasoning" open=""/,
  );
});

test("REPL tools render Running code rather than the generic tool label", () => {
  for (const tool of [
    "REPL",
    "JavaScript",
    "AppifactRepl",
    "mcp__node_repl__js",
  ]) {
    const item: Item = {
      id: tool,
      type: "dynamicToolCall",
      tool,
      status: "inProgress",
    };
    assert.equal(codeToolCallLabel(item), "Running code…");
    assert.match(
      renderToStaticMarkup(
        createElement(ItemView, { item, mode: "chat", onArtifact() {} }),
      ),
      /Running code…/,
    );
  }
});

test("thinking view places a recap before each tool run without inventing one", () => {
  const items: Item[] = [
    {
      id: "reason",
      type: "reasoning",
      summary: ["Inspecting the project.\nDetailed reasoning."],
      status: "completed",
    },
    {
      id: "cmd",
      type: "commandExecution",
      command: "pwd",
      status: "completed",
    },
    {
      id: "cmd2",
      type: "commandExecution",
      command: "ls",
      status: "completed",
    },
  ];
  const turn: Turn = {
    id: "recap-turn",
    items,
    prompt: "Test",
    attachments: [],
    createdAt: 1,
    status: "completed",
  };
  const html = renderToStaticMarkup(
    createElement(TranscriptViewContext.Provider, {
      value: "thinking",
      children: createElement(AgentItems, {
        conversation: {
          id: "recap-session",
          turns: [turn],
          mode: "code",
        } as Conversation,
        turn,
        mode: "code",
        onArtifact() {},
        onOpenWorkflow() {},
      }),
    }),
  );
  assert.match(html, /thinking-tool-recap">Inspecting the project\./);
  assert.equal((html.match(/thinking-tool-recap/g) ?? []).length, 1);
  assert.ok(
    html.indexOf("thinking-tool-recap") <
      html.indexOf(
        "code-command-label",
        html.indexOf("thinking-tool-recap") + 1,
      ),
  );
});

test("leaving group indentation uses 400ms without retiming row collapse", () => {
  const css = readSource(
    new URL("../../src/transcript/chat-transcript.css", import.meta.url),
    "utf8",
  );
  assert.match(
    css,
    /transition: padding-inline-start 400ms cubic-bezier\(0\.22, 1, 0\.36, 1\)/,
  );
  assert.match(css, /step-slot-out var\(--motion-base\) var\(--steps-ease\)/);
});

test("served tool captions survive the desktop transcript boundary and respect group identity", () => {
  const item: Item = {
    id: "caption-tool",
    type: "dynamicToolCall",
    tool: "Read",
    status: "completed",
    display_group: {
      id: "group",
      is_complete: true,
      summary: "Checked the project configuration",
    },
  };
  const projected = projectAgentItems([item]);
  assert.equal(toolGroupCaption(projected), item.display_group?.summary);
  assert.equal(
    toolGroupCaption([{ ...item, display_group: undefined }]),
    undefined,
  );
  assert.equal(
    toolGroupCaption([item, { ...item, display_group: { id: "other" } }]),
    undefined,
  );
  assert.equal(
    toolGroupCaption([
      {
        ...item,
        display_group: {
          id: "group",
          run: {
            anchor_id: "run",
            state: "working",
            summary: "Inspecting the configuration",
            summary_source: "worker_caption",
          },
        },
      },
    ]),
    "Inspecting the configuration",
  );
  assert.equal(
    toolGroupCaption([
      {
        ...item,
        display_group: {
          id: "group",
          run: {
            anchor_id: "run",
            state: "failed",
            summary: "Checked the configuration",
          },
        },
      },
    ]),
    undefined,
  );
});

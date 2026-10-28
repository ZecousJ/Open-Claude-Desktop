/**
 * Replays of recorded-shape streams through the real reducers (R45f): the
 * Codex app-server's notifications (`item/started`, `item/completed`,
 * `turn/completed`), the upstream Responses events the gateway observes
 * (web_search_call sources, message annotations) and the Research tools'
 * calls go through the engine, the gateway observer and the Research
 * extension exactly as at run time, and the resulting turn is rendered by
 * the transcript component.
 *
 * The fixtures in tests/fixtures/replay/*.jsonl have the protocol's shapes
 * (0.144.1 notifications, OpenAI Responses events) with synthetic content.
 * No real upstream stream is recorded yet (R45 Q2/SP-4); replace them by a
 * recording when one exists: every line is `{codex}`, `{upstream}`, `{tool}`
 * or `{tick}`.
 */
import test, { before } from "node:test";
import { preloadMarkdownRenderer } from "../../src/ui/MarkdownRenderer";

before(() => preloadMarkdownRenderer());
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Engine } from "../../electron/engine/engine";
import { Store } from "../../electron/store/store";
import {
  createResearchExtension,
  ResearchReports,
} from "../../electron/ipc/research";
import { webSourcesFromResponse } from "../../server/web-source-observer";
import { openPolicy, type ClientPolicy } from "../../shared/client-policy";
import type { Conversation } from "../../shared/types";
import { ChatTurnContent } from "../../src/transcript/ChatTurnContent";
import { stepLine } from "../../src/transcript/chat-step-lines";
import { resetResearchStores } from "../../src/research/useResearchDraft";

type Line =
  | { codex: { method: string; params: unknown } }
  | { upstream: unknown }
  | { tool: string; arguments: unknown }
  | { tick: number };

const recording = (name: string): Line[] =>
  fs
    .readFileSync(
      path.join(
        import.meta.dirname,
        "..",
        "fixtures",
        "replay",
        `${name}.jsonl`,
      ),
      "utf8",
    )
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));

function replay(name: string, research: boolean) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-replay-"));
  const store = new Store(root);
  const c: Conversation = {
    id: "conv-1",
    title: "Replay",
    mode: "chat",
    providerId: "default",
    model: "m",
    pinned: false,
    archived: false,
    createdAt: 1,
    updatedAt: 1,
    threadId: "thread-a",
    webSearch: true,
    research,
    cwd: root,
    turns: [
      {
        id: "turn-1",
        prompt: "Question",
        attachments: [],
        createdAt: 1000,
        status: "inProgress",
        items: [],
      },
    ],
  };
  store.conversations = [c];
  const engine = new Engine(
    store,
    "unused",
    () => "",
    () => {},
  );
  const policy = { ...openPolicy } as ClientPolicy;
  engine.policy = () => policy;
  let clock = 5000;
  engine.extensions.add(
    createResearchExtension({
      policy: () => policy,
      catalogItem: () => undefined,
      reports: new ResearchReports(root),
      push: () => {},
      now: () => clock,
    }),
  );
  const internals = engine as any;
  internals.routes.set("thread-a", c.id);
  const provider = store.settings.providers[0];
  if (research)
    internals.turnExtras(internals.turnContext(c, provider, "m", "chat"));
  const done = (async () => {
    for (const line of recording(name)) {
      if ("codex" in line) internals.notification(line.codex);
      else if ("upstream" in line) {
        const signal = webSourcesFromResponse(line.upstream, "thread-a");
        if (signal) internals.signals.webSources(signal);
      } else if ("tick" in line) clock += line.tick;
      else
        await engine.extensions.handleDynamicTool({
          conversation: c,
          turn: c.turns[0],
          threadId: "thread-a",
          turnId: "turn-1",
          callId: `call-${line.tool}`,
          namespace: null,
          tool: line.tool,
          arguments: line.arguments,
          changed: () => {},
        });
    }
  })();
  return {
    c,
    done,
    html: () =>
      renderToStaticMarkup(
        createElement(ChatTurnContent, {
          turn: c.turns[0],
          awaitingApproval: false,
          onArtifact() {},
        }),
      ),
    close() {
      store.flush();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

test("a web search stream ends as a search row with its sources and a cited reply", async () => {
  resetResearchStores();
  const run = replay("web-search", false);
  try {
    await run.done;
    const [search, message] = run.c.turns[0].items;
    assert.equal(search.type, "webSearch");
    assert.equal(search.lifecycleStatus, "completed");
    assert.equal(search.searchTool, "web_search");
    assert.deepEqual(
      search.sources?.map((source) => source.url),
      [
        "https://en.wikipedia.org/wiki/Paris",
        "https://www.britannica.com/place/Paris",
      ],
      "duplicates in the upstream list collapse",
    );
    assert.equal(message.type, "agentMessage");
    assert.equal(message.citations?.length, 2);
    assert.equal(run.c.turns[0].status, "completed");
    const html = run.html();
    assert.match(html, /Searched the web/);
    assert.match(html, /capital of France/);
    assert.match(html, /Paris is the capital of France/);
    // Each citation replaced the "([site](url))" text with a chip.
    assert.doesNotMatch(html, /\(\[Wikipedia\]/);
    assert.match(html, /wikipedia/i);
    assert.match(html, /britannica/i);
  } finally {
    run.close();
  }
});

test("a Research stream ends as a done research turn with a card, counts and a report", async () => {
  resetResearchStores();
  const run = replay("research-run", true);
  try {
    await run.done;
    const turn = run.c.turns[0];
    assert.equal(turn.research?.state, "done");
    assert.equal(turn.research?.title, "Desktop Sidebar Density");
    // Six results over three searches, one page repeated.
    assert.equal(turn.research?.sourceCount, 5);
    assert.equal(turn.research?.searchCount, 3);
    assert.equal(
      (turn.research?.completedAt ?? 0) - (turn.research?.startedAt ?? 0),
      65_000,
    );
    assert.equal(turn.research?.reportSource, "tool");
    const html = run.html();
    assert.match(html, /class="research-card/);
    assert.match(html, /5 sources/);
    assert.doesNotMatch(html, /research_plan|research_report/);
    // Each search is a step of the "Searched the web" group (closed once
    // done; its rows open with it).
    assert.match(html, /class="activity-label">Searched the web</);
    const searches = turn.items.filter((item) => item.type === "webSearch");
    assert.equal(searches.length, 3);
    assert.ok(
      searches.some(
        (item) => stepLine(item).name === "desktop sidebar row height",
      ),
    );
    assert.match(html, /I checked the sidebar guidance/);
  } finally {
    run.close();
  }
});
import { before as beforeChatSteps } from "node:test";
import { preloadChatSteps } from "../../src/transcript/ChatTurnContent";
beforeChatSteps(() => preloadChatSteps());

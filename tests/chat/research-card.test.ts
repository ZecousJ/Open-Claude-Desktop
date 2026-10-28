import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ResearchState } from "../../shared/research";
import type { Item, Turn } from "../../shared/types";
import {
  ResearchCard,
  researchCardText,
  researchHosts,
} from "../../src/research/ResearchCard";
import { researchSources } from "../../src/research/ResearchSources";
import {
  getResearchPanel,
  noteResearchEvent,
  openResearchPanel,
  resetResearchStores,
  useTurnResearch,
} from "../../src/research/useResearchDraft";
import { ChatTurnContent } from "../../src/transcript/ChatTurnContent";

const start = Date.UTC(2026, 8, 24, 9);

const search = (id: string, urls: string[]): Item => ({
  id,
  type: "webSearch",
  query: id,
  action: { type: "search", query: id },
  lifecycleStatus: "completed",
  sources: urls.map((url) => ({ url, title: `Page ${url}` })),
});

const turn = (items: Item[], research?: ResearchState): Turn => ({
  id: "t1",
  prompt: "Research sidebars",
  attachments: [],
  status: research?.state === "done" ? "completed" : "inProgress",
  createdAt: start,
  items,
  ...(research ? { research } : {}),
});

test("the card's lines follow the research's phase", () => {
  const now = start + 178_000;
  assert.deepEqual(
    researchCardText(
      { state: "planning", startedAt: start, sourceCount: 0 },
      now,
    ),
    { title: "Researching...", detail: "Creating my research plan..." },
  );
  assert.deepEqual(
    researchCardText(
      {
        state: "gathering",
        title: "Sidebars",
        startedAt: start,
        sourceCount: 185,
      },
      now,
    ),
    { title: "Sidebars", detail: "185 sources and counting..." },
  );
  assert.deepEqual(
    researchCardText(
      {
        state: "done",
        title: "Plan title",
        startedAt: start,
        completedAt: start + 46_000,
        sourceCount: 1,
        report: { title: "Report title", path: "research/c/r.md", bytes: 10 },
      },
      now,
    ),
    { title: "Report title", detail: "1 source" },
  );
  assert.deepEqual(
    researchCardText(
      {
        state: "failed",
        startedAt: start,
        completedAt: start + 5000,
        sourceCount: 3,
      },
      now,
    ),
    { title: "Something went wrong", detail: "" },
  );
});

test("the card stacks at most three distinct sites", () => {
  const t = turn([
    search("a", [
      "https://one.example/a",
      "https://one.example/b",
      "https://two.example/",
    ]),
    search("b", ["https://three.example/", "https://four.example/"]),
  ]);
  assert.deepEqual(researchHosts(t), [
    "one.example",
    "two.example",
    "three.example",
  ]);
  // Newest first, one row per page.
  const sources = researchSources(t);
  assert.equal(sources.length, 5);
  assert.match(sources[0].url, /four\.example/);
});

test("the card is one button labelled with its two lines", () => {
  const research: ResearchState = {
    state: "done",
    title: "Sidebars",
    startedAt: start,
    completedAt: start + 60_000,
    sourceCount: 2,
  };
  const html = renderToStaticMarkup(
    createElement(ResearchCard, {
      turn: turn([search("a", ["https://one.example/"])], research),
      research,
      onOpen() {},
    }),
  );
  assert.match(html, /class="research-card research-done"/);
  assert.match(html, /role="button"/);
  assert.match(
    html,
    /aria-label="Sidebars: 2 sources\. Open research panel\."/,
  );
  assert.doesNotMatch(html, /aria-disabled/);
  // Without a way to open the panel it says so.
  const inert = renderToStaticMarkup(
    createElement(ResearchCard, { turn: turn([], research), research }),
  );
  assert.match(inert, /aria-disabled="true"/);
});

test("pushed progress wins over the stored state only when it is further along", () => {
  resetResearchStores();
  const stored: ResearchState = {
    state: "gathering",
    startedAt: start,
    sourceCount: 10,
  };
  const t = turn([], stored);
  let seen: ResearchState | undefined;
  const Probe = () => {
    seen = useTurnResearch({ id: "c1" }, t);
    return null;
  };
  renderToStaticMarkup(createElement(Probe));
  assert.equal(seen, stored);
  noteResearchEvent("c1", "t1", { ...stored, sourceCount: 12 });
  renderToStaticMarkup(createElement(Probe));
  assert.equal(seen?.sourceCount, 12);
  noteResearchEvent("c1", "t1", {
    ...stored,
    state: "planning",
    sourceCount: 0,
  });
  renderToStaticMarkup(createElement(Probe));
  assert.equal(seen, stored);
  // Another conversation's events are not this turn's.
  noteResearchEvent("c2", "t1", { ...stored, state: "done", sourceCount: 99 });
  renderToStaticMarkup(createElement(Probe));
  assert.equal(seen, stored);
  resetResearchStores();
});

test("opening the panel replaces the tool panel and the file", () => {
  resetResearchStores();
  const calls: string[] = [];
  openResearchPanel(
    {
      setPanel: () => void calls.push("panel"),
      setArtifact: () => void calls.push("artifact"),
    },
    "c1",
    "t1",
  );
  assert.deepEqual(calls, ["panel", "artifact"]);
  assert.deepEqual(getResearchPanel(), {
    conversationId: "c1",
    turnId: "t1",
    view: "report",
  });
  resetResearchStores();
});

test("a Research turn shows its card and hides the research tools", () => {
  const research: ResearchState = {
    state: "gathering",
    title: "Sidebar density",
    startedAt: start,
    sourceCount: 1,
  };
  const items: Item[] = [
    {
      id: "plan",
      type: "dynamicToolCall",
      tool: "research_plan",
      status: "completed",
    } as Item,
    {
      id: "writing",
      type: "dynamicToolCall",
      tool: "research_start_report",
      status: "completed",
    },
    search("a", ["https://one.example/"]),
    { id: "msg", type: "agentMessage", text: "Looking into it." },
  ];
  const html = renderToStaticMarkup(
    createElement(ChatTurnContent, {
      turn: turn(items, research),
      awaitingApproval: false,
      onArtifact() {},
    }),
  );
  assert.match(html, /class="research-card research-gathering"/);
  assert.match(html, /Sidebar density/);
  assert.doesNotMatch(html, /research_plan/);
  assert.doesNotMatch(html, /research_start_report/);
  // The card follows the first reply.
  assert.ok(html.indexOf("Looking into it.") < html.indexOf("research-card"));
  // A turn without research has no card.
  const plain = renderToStaticMarkup(
    createElement(ChatTurnContent, {
      turn: turn([items.at(-1)!]),
      awaitingApproval: false,
      onArtifact() {},
    }),
  );
  assert.doesNotMatch(plain, /research-card/);
});
import { before as beforeChatSteps } from "node:test";
import { preloadChatSteps } from "../../src/transcript/ChatTurnContent";
beforeChatSteps(() => preloadChatSteps());

import test, { before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { act, createElement } from "react";
import { parseHTML } from "linkedom";
import { renderToStaticMarkup } from "react-dom/server";
import type { ResearchState } from "../../shared/research";
import type { Conversation, Turn } from "../../shared/types";
import {
  ResearchCard,
  researchCardText,
  researchStartingMessages,
} from "../../src/research/ResearchCard";
import {
  ResearchPanel,
  ResearchProgress,
  researchSteps,
} from "../../src/research/ResearchPanel";
import { ResearchSources } from "../../src/research/ResearchSources";
import {
  resetResearchStores,
  setResearchPanel,
} from "../../src/research/useResearchDraft";
import { preloadMarkdownRenderer } from "../../src/ui/MarkdownRenderer";
import { ResearchReport } from "../../src/research/ResearchReport";

before(() => preloadMarkdownRenderer());

test("research card surfaces use official radius, CDS borders, shadows and expanded selection", () => {
  const css = readFileSync(
    new URL("../../src/research/research.css", import.meta.url),
    "utf8",
  );
  assert.match(css, /padding: 0 16px 16px/);
  assert.match(css, /border: 1px solid var\(--cds-border\)/);
  assert.match(css, /border-radius: var\(--msg-block-radius, 0\.75rem\)/);
  assert.match(css, /box-shadow: 0 1px 2px 0 #0000000d/);
  assert.match(
    css,
    /background: color-mix\(in oklab, var\(--cds-surface-3\) 50%, transparent\)/,
  );
  assert.match(css, /box-shadow: var\(--cds-shadow-sm\)/);
  assert.match(
    css,
    /\.research-card\[aria-expanded="true"\] \{\s*border-color: var\(--cds-fill-accent-hover\) !important/,
  );
  assert.doesNotMatch(css, /border: 1px solid #2e2e2e/);
});

const initial: ResearchState = {
  state: "starting",
  startedAt: 1,
  sourceCount: 0,
};
const sources = Array.from({ length: 30 }, (_, index) => ({
  url: `https://site${index}.example/page`,
  title: `Page ${index}`,
  snippet: `Source excerpt ${index}`,
}));
const renderProgress = (research: ResearchState) =>
  renderToStaticMarkup(
    createElement(ResearchProgress, { research, sources, onOpenSources() {} }),
  );

test("research has the official eleven starting lines and a writing subtitle", () => {
  assert.equal(researchStartingMessages.length, 11);
  assert.equal(new Set(researchStartingMessages).size, 11);
  for (const [index, title] of researchStartingMessages.entries())
    assert.deepEqual(researchCardText(initial, 1, index), {
      title,
      detail: "",
    });
  assert.equal(
    researchCardText({ ...initial, state: "writing" }).detail,
    "Writing and citing report...",
  );
});

test("timeline titles follow plan, searching, gathering, writing and completion", () => {
  const planning = researchSteps(initial);
  assert.equal(planning[0].title, "Creating my research plan...");
  assert.deepEqual(
    planning.map((step) => step.shown),
    [true, false, false],
  );
  assert.equal(
    researchSteps({ ...initial, state: "gathering" })[1].title,
    "Searching for sources...",
  );
  assert.equal(
    researchSteps({ ...initial, state: "gathering", sourceCount: 1 })[1].title,
    "Gathering 1 source and counting...",
  );
  assert.equal(
    researchSteps({ ...initial, state: "gathering", sourceCount: 30 })[1].title,
    "Gathering 30 sources and counting...",
  );
  const writing = researchSteps({
    ...initial,
    state: "writing",
    sourceCount: 30,
  });
  assert.deepEqual(
    writing.map((step) => step.title),
    [
      "Research plan created",
      "Gathered 30 sources",
      "Writing and citing report...",
    ],
  );
  assert.ok(writing.every((step) => step.shown));
  assert.equal(
    researchSteps({ ...initial, state: "done", sourceCount: 1 })[1].title,
    "Gathered 1 source",
  );
  assert.equal(
    researchSteps({ ...initial, state: "done" })[2].title,
    "Boom! Research report is ready",
  );
});

test("timeline expands plan text and source snippets without truncating to 25 rows", () => {
  const fullPlan = renderProgress({
    ...initial,
    state: "planning",
    plan: "Investigate **primary evidence** before comparing sources.",
  });
  assert.match(fullPlan, /<strong>primary evidence<\/strong>/);
  const planning = renderProgress({
    ...initial,
    state: "planning",
    questions: ["Compare primary sources"],
  });
  assert.match(planning, /aria-expanded="true"/);
  assert.match(planning, /Compare primary sources/);
  assert.doesNotMatch(
    planning,
    /No plan was made|Research stopped|Planning research…/,
  );
  const gathering = renderProgress({
    ...initial,
    state: "gathering",
    sourceCount: 30,
    questions: ["The plan"],
  });
  assert.match(gathering, /aria-expanded="false"/);
  assert.match(gathering, /Source excerpt 29/);
  assert.match(gathering, /<details/);
  assert.doesNotMatch(gathering, /more in Sources/);
  const done = renderProgress({ ...initial, state: "done", sourceCount: 30 });
  assert.match(done, /Boom! Research report is ready/);
  assert.doesNotMatch(done, /shimmer-text/);
});

test("timeline reports interruption and model access failures with official copy", () => {
  assert.match(
    renderProgress({ ...initial, state: "interrupted" }),
    /Interrupted/,
  );
  assert.match(
    renderProgress({ ...initial, state: "failed" }),
    /Something went wrong/,
  );
  assert.match(
    renderProgress({ ...initial, state: "failed", error: "research_failed" }),
    /Couldn’t complete research/,
  );
  assert.match(
    renderProgress({
      ...initial,
      state: "failed",
      error: "model_access",
      errorModel: "Opus",
    }),
    /Research requires Opus, which you don’t have access to/,
  );
  assert.doesNotMatch(
    renderProgress({ ...initial, state: "failed", writingStartedAt: 2 }),
    /Writing and citing report/,
  );
});

test("the panel has official accessible labels and no invented report menu", () => {
  const turn: Turn = {
    id: "t",
    prompt: "Research",
    attachments: [],
    createdAt: 1,
    status: "completed",
    items: [],
    research: { ...initial, state: "done" },
  };
  const conversation = { id: "c" } as Conversation;
  const render = (view: "report" | "sources") =>
    renderToStaticMarkup(
      createElement(ResearchPanel, {
        turn,
        conversation,
        target: { conversationId: "c", turnId: "t", view },
        notify() {},
      }),
    );
  assert.match(render("report"), /aria-label="Research panel"/);
  assert.match(render("report"), /aria-label="Close"/);
  assert.match(render("report"), /Boom! Research report is ready/);
  assert.doesNotMatch(
    render("report"),
    /More options|Download as Markdown|Back to the report|Close Research/,
  );
  assert.match(render("sources"), /aria-label="Research sources"/);
  assert.match(render("sources"), /aria-label="Back"/);
  assert.match(render("sources"), /0 sources/);
  assert.match(render("sources"), /No sources found/);
  turn.status = "inProgress";
  turn.research = { ...initial, state: "gathering", sourceCount: 2 };
  assert.match(render("sources"), /2 sources and counting/);
});

test("cards reconnect using the turn's actual connection state and mark the expanded card", () => {
  resetResearchStores();
  const turn = { id: "t", items: [], reconnecting: "Waiting for the host" };
  const render = (research: ResearchState) =>
    renderToStaticMarkup(
      createElement(ResearchCard, { turn, research, onOpen() {} }),
    );
  assert.match(render(initial), /Reconnecting\.\.\./);
  assert.doesNotMatch(render({ ...initial, state: "done" }), /Reconnecting/);
  setResearchPanel({ conversationId: "c", turnId: "t", view: "report" });
  assert.match(render(initial), /aria-expanded="true"/);
  resetResearchStores();
});

test("sources retain snippets safely and use the official empty state", () => {
  assert.match(
    renderToStaticMarkup(createElement(ResearchSources, { sources: [] })),
    /No sources found/,
  );
  const html = renderToStaticMarkup(
    createElement(ResearchSources, {
      sources: [
        {
          url: "https://source.example",
          title: "Source",
          snippet: "<script>unsafe</script>",
        },
      ],
    }),
  );
  assert.match(html, /&lt;script&gt;unsafe&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>/);
});

test("timeline switches expanded steps, shows three favicons and opens the sources view", async () => {
  const { window, document } = parseHTML(
    "<html><body><main></main></body></html>",
  );
  const globals = { window, document, IS_REACT_ACT_ENVIRONMENT: true };
  const saved = new Map(
    Object.keys(globals).map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value,
    });
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.querySelector("main")!);
  let opened = false;
  try {
    await act(() =>
      root.render(
        createElement(ResearchProgress, {
          research: {
            ...initial,
            state: "gathering",
            sourceCount: 30,
            questions: ["Compare the evidence"],
          },
          sources,
          onOpenSources() {
            opened = true;
          },
        }),
      ),
    );
    const steps = () => [
      ...document.querySelectorAll<HTMLButtonElement>("h4 button"),
    ];
    assert.equal(steps()[1].getAttribute("aria-expanded"), "true");
    await act(() => steps()[0].click());
    assert.equal(steps()[0].getAttribute("aria-expanded"), "true");
    assert.equal(steps()[1].getAttribute("aria-expanded"), "false");
    assert.equal(
      document.querySelectorAll(".research-card-icons .site-icon").length,
      3,
    );
    assert.match(document.body.textContent!, /Compare the evidence/);
    await act(() => steps()[0].click());
    assert.equal(steps()[1].getAttribute("aria-expanded"), "true");
    await act(() =>
      document
        .querySelector<HTMLButtonElement>(".research-source-count")!
        .click(),
    );
    assert.equal(opened, true);
  } finally {
    await act(() => root.unmount());
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

test("completed tool reports remain readable in the transcript after the panel becomes a timeline", async () => {
  const { window, document } = parseHTML(
    "<html><body><main></main></body></html>",
  );
  const requests: string[] = [];
  Object.assign(window, {
    desktop: {
      readResearchReport: async (conversationId: string, turnId: string) => {
        requests.push(`${conversationId}/${turnId}`);
        return {
          title: "Research findings",
          markdown: "# Research findings\n\nEvidence from primary sources.",
        };
      },
    },
  });
  const globals = { window, document, IS_REACT_ACT_ENVIRONMENT: true };
  const saved = new Map(
    Object.keys(globals).map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value,
    });
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.querySelector("main")!);
  try {
    await act(() =>
      root.render(
        createElement(ResearchReport, {
          conversationId: "c",
          turnId: "t",
          onArtifact() {},
        }),
      ),
    );
    assert.deepEqual(requests, ["c/t"]);
    assert.equal(
      document.querySelector("h1")?.textContent,
      "Research findings",
    );
    assert.match(document.body.textContent!, /Evidence from primary sources/);
  } finally {
    await act(() => root.unmount());
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

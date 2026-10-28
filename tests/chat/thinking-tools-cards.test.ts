import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  QuestionsCard,
  questionCardProgress,
} from "../../src/approval/QuestionsCard";
import { Figure } from "../../src/changes/ImageCompareDialog";
import {
  ResearchCard,
  researchCardText,
} from "../../src/research/ResearchCard";
import { WebSearchView } from "../../src/transcript/tools/WebSearchView";
import type { Item } from "../../shared/types";
import { readSource } from "../support/read-source";

const questions = ["first", "second", "third"].map((id) => ({
  id,
  question: id,
  options: [{ label: "Yes" }],
}));

test("questions retain navigation and block submission of an unanswered page", () => {
  const html = renderToStaticMarkup(
    createElement(QuestionsCard, {
      questions,
      busy: false,
      frontmost: false,
      mac: false,
      onSubmit() {},
    }),
  );
  assert.match(html, /aria-label="Show previous question" disabled/);
  assert.match(html, /1 of 3/);
  assert.match(html, /aria-label="Show next question"/);
  assert.deepEqual(
    questionCardProgress(questions, 2, { third: "Yes" }, {}, {}),
    {
      canAdvance: false,
      unanswered: 0,
      reason: "Question 1 is unanswered",
    },
  );
  assert.equal(
    questionCardProgress(
      questions,
      2,
      { third: "Yes" },
      {},
      {
        first: true,
        second: true,
      },
    ).canAdvance,
    true,
  );
  assert.equal(
    questionCardProgress(questions, 1, {}, {}, {}).reason,
    "Choose an option or skip this question",
  );
  assert.equal(
    questionCardProgress(
      questions,
      0,
      { first: "\u0000other" },
      {
        first: "   ",
      },
      {},
    ).canAdvance,
    false,
  );
  assert.equal(
    questionCardProgress(
      questions,
      0,
      { first: "\u0000other" },
      {
        first: "Custom answer",
      },
      {},
    ).canAdvance,
    true,
  );
});

test("single questions have no pager and busy cards disable both carets", () => {
  const render = (count: number, busy: boolean) =>
    renderToStaticMarkup(
      createElement(QuestionsCard, {
        questions: questions.slice(0, count),
        busy,
        frontmost: false,
        mac: false,
        onSubmit() {},
      }),
    );
  assert.doesNotMatch(
    render(1, false),
    /Show previous question|Show next question/,
  );
  assert.match(render(2, true), /aria-label="Show next question" disabled/);
});

test("search results merge without query groups and empty results show zero", () => {
  const item: Item = {
    id: "one",
    type: "webSearch",
    lifecycleStatus: "completed",
    sources: [{ url: "https://example.com/a", title: "First" }],
  };
  const second: Item = {
    ...item,
    id: "two",
    sources: [
      { url: "https://example.com/a", title: "First" },
      { url: "https://example.org/b", title: "Second" },
    ],
  };
  const html = renderToStaticMarkup(
    createElement(WebSearchView, { item, items: [item, second] }),
  );
  assert.match(html, />2 results</);
  assert.equal((html.match(/role="listitem"/g) ?? []).length, 2);
  assert.match(html, /width:16px;height:16px/);
  assert.doesNotMatch(html, /web-search-group|queries|Show .* more/);
  const empty = renderToStaticMarkup(
    createElement(WebSearchView, { item: { ...item, sources: [] } }),
  );
  assert.match(empty, />0 results</);
  assert.doesNotMatch(empty, /role="list"/);
});

test("research uses completed and source-searching fallbacks and panel aria", () => {
  const research = { state: "done" as const, startedAt: 0, sourceCount: 0 };
  assert.deepEqual(researchCardText(research), {
    title: "Research complete",
    detail: "0 sources",
  });
  assert.equal(
    researchCardText({ ...research, state: "gathering" }).detail,
    "Searching for sources...",
  );
  assert.equal(
    researchCardText({ ...research, state: "gathering", sourceCount: 1 })
      .detail,
    "1 source and counting...",
  );
  assert.equal(
    researchCardText({ ...research, state: "interrupted" }).detail,
    "Interrupted",
  );
  const html = renderToStaticMarkup(
    createElement(ResearchCard, {
      turn: { items: [] },
      research: { ...research, state: "failed" },
      onOpen() {},
    }),
  );
  assert.match(
    html,
    /aria-label="Something went wrong\. Open research panel\."/,
  );
});

test("diff figures already own unavailable and 320px framing, not the lightbox", () => {
  const render = (src: string | null | undefined) =>
    renderToStaticMarkup(
      createElement(Figure, {
        label: "Before",
        alt: "image.png before the change",
        src,
      }),
    );
  assert.match(
    render(null),
    /<figure.*<figcaption>.*Before.*Image not available/,
  );
  assert.match(render(undefined), /aria-busy="true"/);
  assert.doesNotMatch(render(undefined), /Image not available/);
  assert.match(render("data:image/png;base64,AA=="), /<img.*draggable="false"/);
  const markdown = readSource(
    new URL("../../src/ui/MarkdownImage.tsx", import.meta.url),
    "utf8",
  );
  assert.match(
    markdown,
    /onError=\{\(\) => setState\(\{ kind: "failed" \}\)\}/,
  );
  assert.match(markdown, /This image didn’t load\./);
  const css = readSource(
    new URL("../../src/transcript/chat-transcript.css", import.meta.url),
    "utf8",
  );
  assert.match(
    css,
    /border-radius:\s*calc\(\s*var\(--cds-radius, 6px\) \+ 0\.25rem/,
  );
  assert.match(css, /overflow-y: clip/);
  assert.match(css, /\.chat-step-slot:last-child > div \{\s*border-bottom: 0/);
});

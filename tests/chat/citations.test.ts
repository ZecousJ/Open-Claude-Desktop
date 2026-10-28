import test, { before } from "node:test";
import { preloadMarkdownRenderer } from "../../src/ui/MarkdownRenderer";

before(() => preloadMarkdownRenderer());
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  cardPosition,
  chipLabel,
  citationRender,
  fencedRanges,
  siteName,
  sourceHost,
  stripMarkers,
  turnSources,
  xaiInlineCitations,
} from "../../src/citations/citations";
import { Markdown } from "../../src/ui/components";
import { ChatTurnContent } from "../../src/transcript/ChatTurnContent";
import type { Item, Turn } from "../../shared/types";

const marker = (n: number) => `${n}`;
const cite = (text: string, fragment: string, url: string, title?: string) => {
  const start = text.indexOf(fragment);
  assert.ok(start >= 0, fragment);
  return {
    url,
    start,
    end: start + fragment.length,
    ...(title ? { title } : {}),
  };
};

test("site names drop www, the public suffix and generic second levels", () => {
  assert.equal(sourceHost("https://www.Example.com/a"), "example.com");
  assert.equal(sourceHost("javascript:alert(1)"), undefined);
  assert.equal(
    sourceHost("https://evil.example@good.example/x"),
    "good.example",
  );
  assert.equal(siteName("en.wikipedia.org"), "wikipedia");
  assert.equal(siteName("bbc.co.uk"), "bbc");
  assert.equal(siteName("abc.net.au"), "abc");
  assert.equal(siteName("x.com"), "x");
  assert.equal(siteName("localhost"), "localhost");
  assert.equal(siteName("192.0.2.1"), "192.0.2.1");
  assert.equal(
    chipLabel({
      sources: [
        { url: "https://en.wikipedia.org/a", host: "en.wikipedia.org" },
        { url: "https://b.example/", host: "b.example" },
        { url: "https://c.example/", host: "c.example" },
      ],
    }),
    "wikipedia +2",
  );
});

test("an annotation span is followed by its chip; titles and snippets come from the turn's results", () => {
  const text = "The sky is blue. Grass is green.";
  const render = citationRender(
    {
      text,
      citations: [cite(text, "The sky is blue.", "https://sky.example/why")],
    },
    new Map([
      [
        "https://sky.example/why",
        {
          url: "https://sky.example/why",
          title: "Why blue",
          snippet: "Rayleigh",
        },
      ],
    ]),
  );
  assert.ok(render);
  assert.equal(render.text, `The sky is blue.${marker(0)} Grass is green.`);
  assert.deepEqual(render.groups, [
    {
      sources: [
        {
          url: "https://sky.example/why",
          host: "sky.example",
          title: "Why blue",
          snippet: "Rayleigh",
        },
      ],
    },
  ]);
});

test("OpenAI's link-only citation spans are replaced by the chip; neighbours share one", () => {
  const text =
    "Fact one ([a.example](https://a.example/1)) ([b.example](https://b.example/2)). Next.";
  const render = citationRender({
    text,
    citations: [
      cite(text, "([a.example](https://a.example/1))", "https://a.example/1"),
      cite(text, "([b.example](https://b.example/2))", "https://b.example/2"),
    ],
  });
  assert.ok(render);
  assert.equal(render.text, `Fact one${marker(0)}. Next.`);
  assert.equal(render.groups[0].sources.length, 2);
  assert.equal(chipLabel(render.groups[0]), "a +1");
});

test("citations at the same place merge and repeat URLs count once", () => {
  const text = "Claim.";
  const render = citationRender({
    text,
    citations: [
      { url: "https://a.example/", start: 0, end: 6 },
      { url: "https://a.example/#part", start: 0, end: 6 },
      { url: "https://b.example/", start: 0, end: 6 },
    ],
  });
  assert.ok(render);
  assert.equal(render.text, `Claim.${marker(0)}`);
  assert.deepEqual(
    render.groups[0].sources.map((source) => source.host),
    ["a.example", "b.example"],
  );
});

test("xAI inline [[n]](url) links become chips when no annotations were recorded", () => {
  const text =
    "Grok says so [[1]](https://x.com/a/status/1)[[2]](https://news.example/b).";
  assert.equal(xaiInlineCitations(text).length, 2);
  const render = citationRender({ text });
  assert.ok(render);
  assert.equal(render.text, `Grok says so${marker(0)}.`);
  assert.deepEqual(
    render.groups[0].sources.map((source) => source.host),
    ["x.com", "news.example"],
  );
});

test("citations in fenced code, out of range or unsafe are dropped; forged markers are removed", () => {
  const text = "Intro.\n\n```js\nconst a = 1;\n```\n\nEnd 9.";
  assert.deepEqual(fencedRanges(text), [[8, 30]]);
  const inCode = text.indexOf("const");
  assert.equal(
    citationRender({
      text,
      citations: [
        { url: "https://a.example/", start: inCode, end: inCode + 5 },
        { url: "javascript:alert(1)", start: 0, end: 6 },
        { url: "https://b.example/", start: 0, end: 999 },
      ],
    }),
    undefined,
  );
  const render = citationRender({
    text,
    citations: [{ url: "https://a.example/", start: 0, end: 6 }],
  });
  assert.ok(render);
  assert.equal(
    render.text,
    `Intro.${marker(0)}\n\n\`\`\`js\nconst a = 1;\n\`\`\`\n\nEnd 9.`,
  );
  assert.equal(stripMarkers(`a${marker(3)}b`), "ab");
});

test("overlapping spans are placed after the earlier one", () => {
  const text = "Alpha beta gamma.";
  const render = citationRender({
    text,
    citations: [
      { url: "https://a.example/", start: 0, end: 10 },
      { url: "https://b.example/", start: 6, end: 17 },
    ],
  });
  assert.ok(render);
  assert.equal(render.text, `Alpha beta${marker(0)} gamma.${marker(1)}`);
});

test("offsets are UTF-16: emoji and CJK before the span keep the chip in place", () => {
  const text = "🙂 中文句子。Then more.";
  const render = citationRender({
    text,
    citations: [cite(text, "中文句子。", "https://zh.example/")],
  });
  assert.ok(render);
  assert.equal(render.text, `🙂 中文句子。${marker(0)}Then more.`);
});

test("a chip that would cut a word moves to the end of the word, or of the sentence in full-width text", () => {
  const word = "The skyline is blue and the grass is green.";
  const inWord = citationRender({
    text: word,
    citations: [
      cite(word, "The sky", "https://a.example/"),
      cite(word, "the gra", "https://b.example/"),
    ],
  });
  assert.ok(inWord);
  assert.equal(
    inWord.text,
    `The skyline${marker(0)} is blue and the grass${marker(1)} is green.`,
  );
  // The chip goes behind the punctuation that ends the word.
  const punctuated = "It is (as noted) blue, they say.";
  const comma = citationRender({
    text: punctuated,
    citations: [cite(punctuated, "blu", "https://a.example/")],
  });
  assert.equal(comma?.text, `It is (as noted) blue,${marker(0)} they say.`);
  // Two chips that move to the same place share it.
  const shared = citationRender({
    text: word,
    citations: [
      cite(word, "The sky", "https://a.example/"),
      cite(word, "The skyl", "https://b.example/"),
    ],
  });
  assert.equal(shared?.groups.length, 1);
  assert.equal(shared?.groups[0].sources.length, 2);
  const wide = "天空是蓝色的，因为光被散射。下一句话。";
  const sentence = citationRender({
    text: wide,
    citations: [cite(wide, "天空", "https://zh.example/")],
  });
  assert.equal(
    sentence?.text,
    `天空是蓝色的，${marker(0)}因为光被散射。下一句话。`,
  );
  // A table cell keeps its chip inside the cell.
  const row = "| name | value |\n| --- | --- |\n| alpha | beta gamma |";
  const cell = citationRender({
    text: row,
    citations: [cite(row, "alp", "https://a.example/")],
  });
  assert.equal(
    cell?.text,
    `| name | value |\n| --- | --- |\n| alpha${marker(0)} | beta gamma |`,
  );
});

test("chips on a table cell's edge go back into the cell; numbers and running-text pipes are not breaks", () => {
  const table = "| a | b |\n| --- | --- |\n| alpha | beta |";
  // At the start of the next cell: back to the end of the cell before.
  const start = citationRender({
    text: table,
    citations: [cite(table, "alpha | ", "https://a.example/")],
  });
  assert.equal(
    start?.text,
    `| a | b |\n| --- | --- |\n| alpha${marker(0)} | beta |`,
  );
  // In the spaces before the closing pipe: right after the cell's text.
  const spaces = citationRender({
    text: table,
    citations: [cite(table, "alpha ", "https://a.example/")],
  });
  assert.equal(
    spaces?.text,
    `| a | b |\n| --- | --- |\n| alpha${marker(0)} | beta |`,
  );
  // A pipe in running text does not end a word.
  const running = "Use a|b here.";
  assert.equal(
    citationRender({
      text: running,
      citations: [cite(running, "Use a", "https://a.example/")],
    })?.text,
    `Use a|b${marker(0)} here.`,
  );
  // A full-width comma between digits is part of the number.
  const number = "人口约1，000万人。下一句。";
  assert.equal(
    citationRender({
      text: number,
      citations: [cite(number, "人口", "https://a.example/")],
    })?.text,
    `人口约1，000万人。${marker(0)}下一句。`,
  );
});

test("a reply without citations renders unchanged", () => {
  assert.equal(
    citationRender({ text: "Plain [link](https://a.example)." }),
    undefined,
  );
  assert.equal(citationRender({ text: "" }), undefined);
});

test("Markdown shows chips for markers and never inside code, links or addresses", () => {
  const groups = [
    {
      sources: [
        { url: "https://en.wikipedia.org/wiki/Sky", host: "en.wikipedia.org" },
      ],
    },
    { sources: [{ url: "https://b.example/", host: "b.example" }] },
  ];
  const html = renderToStaticMarkup(
    createElement(Markdown, {
      text: `Sky${marker(0)} and \`co${marker(1)}de\` and [link${marker(1)}](https://l.example/${marker(0)}) and ${marker(7)}.\n\n## Head${marker(1)}`,
      citations: groups,
    }),
  );
  assert.equal((html.match(/class="citation-chip"/g) ?? []).length, 4);
  assert.match(html, /Sky<button[^>]*>wikipedia<\/button>/);
  assert.match(html, /<code>code<\/code>/);
  assert.match(html, /href="https:\/\/l.example\/"/);
  assert.match(
    html,
    /<\/a><button[^>]*>b<\/button><button[^>]*>wikipedia<\/button>/,
  );
  assert.match(html, /<h2>Head<button/);
  assert.doesNotMatch(html, /|/);
  // Without the prop nothing changes.
  const plain = renderToStaticMarkup(createElement(Markdown, { text: "Sky." }));
  assert.equal(plain, "<p>Sky.</p>");
});

test("Chat replies with recorded citations show chips with the search's titles", () => {
  const text = "Water boils at 100 °C at sea level.";
  const items: Item[] = [
    {
      id: "ws",
      type: "webSearch",
      query: "boiling point",
      action: { type: "search", query: "boiling point" },
      lifecycleStatus: "completed",
      sources: [
        { url: "https://www.chem.example/boil", title: "Boiling <b>point</b>" },
      ],
    },
    {
      id: "msg",
      type: "agentMessage",
      text,
      citations: [
        { url: "https://www.chem.example/boil", start: 0, end: text.length },
      ],
    },
  ];
  const turn: Turn = {
    id: "t",
    prompt: "?",
    attachments: [],
    status: "completed",
    createdAt: 0,
    items,
  };
  assert.equal(turnSources(turn).size, 1);
  const html = renderToStaticMarkup(
    createElement(ChatTurnContent, {
      turn,
      awaitingApproval: false,
      onArtifact() {},
    }),
  );
  assert.match(
    html,
    /sea level\.<button[^>]*class="citation-chip"[^>]*>Boiling &lt;b&gt;point&lt;\/b&gt;<\/button>/,
  );
  assert.match(html, /aria-label="Source: chem.example"/);
  assert.match(html, /Searched the web/);
  // The search is a step of the group, with its query.
  assert.match(html, /chat-step-name">boiling point</);
});

test("the card sits below the chip, inside the window, or above when there is no room", () => {
  const view = { width: 800, height: 600 };
  const size = { width: 300, height: 120 };
  assert.deepEqual(
    cardPosition({ left: 100, top: 100, bottom: 118 }, size, view),
    {
      left: 100,
      top: 124,
    },
  );
  assert.deepEqual(
    cardPosition({ left: 700, top: 100, bottom: 118 }, size, view),
    {
      left: 492,
      top: 124,
    },
  );
  assert.deepEqual(
    cardPosition({ left: 100, top: 550, bottom: 568 }, size, view),
    {
      left: 100,
      top: 424,
    },
  );
});

test("site icons are asked once per host, in batches, and only raster data URLs are kept", async () => {
  const { requestFavicons, faviconFor, resetFavicons } =
    await import("../../src/research/useFavicons");
  const calls: string[][] = [];
  const png = "data:image/png;base64,iVBORw0KGgo=";
  const global = globalThis as { window?: unknown };
  const previous = global.window;
  global.window = {
    desktop: {
      getFavicons: async (hosts: string[]) => {
        calls.push(hosts);
        return Object.fromEntries(
          hosts.map((host) => [
            host,
            host === "a.example"
              ? png
              : host === "svg.example"
                ? "data:image/svg+xml;base64,PHN2Zz4="
                : null,
          ]),
        );
      },
    },
  };
  try {
    resetFavicons();
    const many = Array.from({ length: 55 }, (_, n) => `h${n}.example`);
    requestFavicons(["a.example", "svg.example", "Bad Host", ...many]);
    requestFavicons(["a.example"]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(
      calls.map((batch) => batch.length),
      [50, 7],
    );
    assert.equal(faviconFor("a.example"), png);
    assert.equal(faviconFor("svg.example"), null);
    assert.equal(faviconFor("Bad Host"), undefined);
  } finally {
    resetFavicons();
    global.window = previous;
  }
});

test("a reply left in progress by a finished turn still shows its chips", () => {
  const text = "Water boils at 100 °C at sea level.";
  const turn: Turn = {
    id: "t",
    prompt: "?",
    attachments: [],
    status: "completed",
    createdAt: 0,
    items: [
      {
        id: "msg",
        type: "agentMessage",
        text,
        lifecycleStatus: "inProgress",
        citations: [
          { url: "https://chem.example/boil", start: 0, end: text.length },
        ],
      },
    ],
  };
  const html = renderToStaticMarkup(
    createElement(ChatTurnContent, {
      turn,
      awaitingApproval: false,
      onArtifact() {},
    }),
  );
  assert.match(html, /class="citation-chip"[^>]*>chem<\/button>/);
});

test("the pill's card lists every page it cites, each with its title and site name", async () => {
  const { CitationCard } = await import("../../src/citations/CitationCard");
  const html = renderToStaticMarkup(
    createElement(CitationCard, {
      group: {
        sources: [
          {
            url: "https://en.wikipedia.org/wiki/Python",
            host: "en.wikipedia.org",
            title: "Python (programming language)",
          },
          {
            url: "https://liquidweb.com/python",
            host: "liquidweb.com",
            title: "Latest Python Version",
          },
        ],
      },
      onOpen() {},
    }),
  );
  assert.equal((html.match(/class="citation-card-item"/g) ?? []).length, 2);
  assert.match(html, /citation-card-title">Python \(programming language\)</);
  assert.match(html, /citation-card-host">Wikipedia</);
  assert.match(html, /citation-card-host">Liquidweb</);
});
import { before as beforeChatSteps } from "node:test";
import { preloadChatSteps } from "../../src/transcript/ChatTurnContent";
beforeChatSteps(() => preloadChatSteps());

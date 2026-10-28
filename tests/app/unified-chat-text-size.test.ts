import test, { before } from "node:test";
import assert from "node:assert/strict";
import { createElement, createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import postcss from "postcss";
import { parse as parseSelector, type Selector } from "css-what";
import type { Conversation } from "../../shared/types";
import { fixtureSnapshot } from "../../scripts/preview/app-fixture";
import { AppContext, type AppController } from "../../src/app/AppContext";
import { ConversationTranscript } from "../../src/transcript/ConversationTranscript";
import { preloadMarkdownRenderer } from "../../src/ui/MarkdownRenderer";
import { preloadChatSteps } from "../../src/transcript/ChatTurnContent";
import { readSource } from "../support/read-source";

before(() => Promise.all([preloadMarkdownRenderer(), preloadChatSteps()]));
const noop = () => {};
const read = (path: string) =>
  readSource(new URL(`../../src/${path}`, import.meta.url), "utf8");
const sheets = [
  "transcript/chat-transcript.css",
  "transcript/assistant-bubbles.css",
  "transcript/code-transcript.css",
  "transcript/transcript-text-size.css",
  "live-web/transcript.css",
  "live-web/composer.css",
  "styles/chat-phone-parity.css",
].map((path) => postcss.parse(read(path)));

function specificity(tokens: Selector[]): number {
  return tokens.reduce((value, token) => {
    if (token.type === "attribute")
      return value + (token.name === "id" ? 10000 : 100);
    if (token.type === "tag" || token.type === "pseudo-element")
      return value + 1;
    if (token.type !== "pseudo" || token.name === "where") return value;
    if (["is", "not", "has"].includes(token.name) && Array.isArray(token.data))
      return value + Math.max(0, ...token.data.map(specificity));
    return value + 100;
  }, 0);
}

/** Real stylesheet selector/cascade checks, not browser layout acceptance.
 * Root separately measures these states through the actual Settings UI. */
function declaration(element: Element, property: string, coarse = false) {
  let winner: { rank: number; value: string } | undefined;
  for (const sheet of sheets)
    sheet.walkRules((rule) => {
      for (
        let parent:
          | postcss.AtRule
          | postcss.Rule
          | postcss.Root
          | postcss.Document
          | undefined = rule.parent;
        parent;
        parent = parent.parent
      ) {
        if (parent.type !== "atrule") continue;
        if (parent.name === "container" || /keyframes/.test(parent.name))
          return;
        if (parent.name !== "media") continue;
        const width = coarse ? 390 : 1440;
        for (const match of parent.params.matchAll(
          /\((min|max)-width:\s*([\d.]+)px\)/g,
        ))
          if (
            match[1] === "min"
              ? width < Number(match[2])
              : width > Number(match[2])
          )
            return;
        if (/pointer:\s*coarse|hover:\s*none/.test(parent.params) && !coarse)
          return;
        if (/pointer:\s*fine|hover:\s*hover/.test(parent.params) && coarse)
          return;
      }
      for (const selector of postcss.list.comma(rule.selector)) {
        let matches = false;
        try {
          if (!selector.includes("::"))
            matches = element.matches(
              selector.replace(
                /:(hover|focus-visible|focus-within|focus|active)(?![\w-])/g,
                ":not(*)",
              ),
            );
        } catch {}
        if (!matches) continue;
        const rank = Math.max(...parseSelector(selector).map(specificity));
        rule.walkDecls((decl) => {
          if (decl.prop !== property) return;
          const next = rank + (decl.important ? 1000000 : 0);
          if (!winner || winner.rank <= next)
            winner = { rank: next, value: decl.value };
        });
      }
    });
  return winner?.value;
}
function custom(
  element: Element,
  name: string,
  coarse: boolean,
): string | undefined {
  const own = declaration(element, name, coarse);
  return (
    own ??
    (element.parentElement
      ? custom(element.parentElement, name, coarse)
      : undefined)
  );
}
function style(
  element: Element,
  property: string,
  coarse = false,
): string | undefined {
  const own = declaration(element, property, coarse);
  if (!own || own === "inherit")
    return element.parentElement
      ? style(element.parentElement, property, coarse)
      : undefined;
  let resolved = own.replace(
    /var\((--[\w-]+)(?:,\s*([^()]+))?\)/g,
    (_all, name: string, fallback: string) =>
      custom(element, name, coarse) ?? fallback?.trim() ?? "",
  );
  const maximum = /^max\(([\d.]+)px,\s*([\d.]+)px\)$/.exec(resolved);
  if (maximum)
    resolved = `${Math.max(Number(maximum[1]), Number(maximum[2]))}px`;
  return resolved;
}

function transcript(
  mode: Conversation["mode"],
  size: "s" | "m" | "l",
  unified = true,
) {
  const snapshot = fixtureSnapshot({ states: true });
  snapshot.settings.transcriptTextSize = size;
  const conversation = structuredClone(
    snapshot.conversations.find((c) => c.id === "c-run-chat")!,
  );
  conversation.mode = mode;
  conversation.turns = [
    {
      ...conversation.turns[0],
      status: "completed",
      prompt: "A prompt.",
      items: [
        {
          id: "reply",
          type: "agentMessage",
          text: "First paragraph.\n\nSecond paragraph.",
        },
      ],
    },
  ];
  const rendered = renderToStaticMarkup(
    createElement(
      AppContext.Provider,
      { value: { snapshot } as unknown as AppController },
      createElement(ConversationTranscript, {
        conversation,
        mode,
        presentation: unified ? "chat" : undefined,
        sending: false,
        running: false,
        approvals: [],
        replyFeedback: {},
        onReplyFeedback: async () => {},
        onArtifact: noop,
        onOpenWorkflow: noop,
        onEditPrompt: async () => true,
        onRetryResponse: noop,
        onContinue: noop,
        onSelectVersion: noop,
        onError: noop,
        scrollRef: createRef<HTMLDivElement>(),
        onScroll: noop,
        onWheel: noop,
        away: false,
        onJumpToLatest: noop,
      }),
    ),
  );
  const shownMode = unified && mode !== "code" ? "chat" : mode;
  return parseHTML(
    `<html data-theme="dark" data-chat-text-size="${size}"><body><div class="app mode-${shownMode}" data-execution-mode="${mode}">${rendered}</div></body></html>`,
  ).document;
}

test("real unified Chat and stored Cowork frames cascade to the measured 14/20, 15/22 and 16/24 Prose", () => {
  for (const mode of ["chat", "cowork"] as const)
    for (const [size, font, line, userFont, userLine] of [
      ["s", "14px", "20px", "14px", "20px"],
      ["m", "15px", "22px", "15px", "20px"],
      ["l", "16px", "24px", "16px", "24px"],
    ] as const) {
      const document = transcript(mode, size);
      assert.equal(
        document
          .querySelector(".messages-scroll")
          ?.getAttribute("data-presentation"),
        "chat",
      );
      const frame = document.querySelector('[data-cds="AssistantMessage"]')!;
      assert.equal(
        frame.getAttribute("data-text-size"),
        size === "m" ? null : size === "s" ? "sm" : "lg",
      );
      const prose = frame.querySelector('[data-cds="Prose"]')!;
      const paragraphs = prose.querySelectorAll("p");
      assert.equal(paragraphs.length, 2);
      for (const element of [prose, ...paragraphs]) {
        assert.equal(style(element, "font-size"), font, `${mode}/${size} font`);
        assert.equal(
          style(element, "line-height"),
          line,
          `${mode}/${size} line`,
        );
      }
      const user = document.querySelector('[data-cds="UserMessage"]')!;
      assert.equal(style(user, "font-size"), userFont);
      assert.equal(style(user, "line-height"), userLine);
      assert.equal(style(frame, "gap"), "8px");
      assert.equal(
        style(frame.querySelector(".assistant-message-body")!, "gap"),
        "8px",
      );
      assert.equal(
        declaration(paragraphs[1], "margin-top"),
        "var(--reply-flow)",
      );
      assert.equal(custom(paragraphs[1], "--reply-flow", false), "0.75em");
    }
});

test("the independent legacy Cowork and Code DOM never gain the unified text-size projection", () => {
  for (const [size, legacyFont, legacyLine] of [
    ["s", "15px", "22px"],
    ["l", "18px", "27px"],
  ] as const) {
    const legacy = transcript("cowork", size, false);
    assert.equal(
      legacy
        .querySelector(".messages-scroll")
        ?.getAttribute("data-presentation"),
      null,
    );
    assert.equal(legacy.querySelector('[data-cds="AssistantMessage"]'), null);
    const prose = legacy.querySelector(".markdown")!;
    assert.equal(style(prose, "font-size"), legacyFont);
    assert.equal(style(prose, "line-height"), legacyLine);
    const code = transcript("code", size);
    assert.equal(
      code.querySelector(".messages-scroll")?.getAttribute("data-presentation"),
      null,
    );
    assert.equal(code.querySelector('[data-cds="AssistantMessage"]'), null);
    const user = code.querySelector(".user-message")!;
    assert.equal(
      custom(user, "--message-text", false),
      size === "s" ? "13px" : "15px",
    );
    assert.equal(
      custom(user, "--message-line", false),
      size === "s" ? "19px" : "22px",
    );
  }
});

test("unified composer variables stay 15/21 at every transcript size while Code, legacy and the coarse floor retain their branches", () => {
  for (const size of ["s", "m", "l"] as const) {
    const document = parseHTML(
      `<html data-chat-text-size="${size}"><body><div class="app web mode-chat"><div class="composer-wrap chat-composer" data-presentation="chat"><div class="composer-input-row"><textarea></textarea></div></div><div class="composer-wrap chat-composer"><div class="composer-input-row"><textarea></textarea></div></div><div class="composer-wrap code-composer"><textarea></textarea></div></div></body></html>`,
    ).document;
    const composer = document.querySelector(
      '[data-presentation="chat"] textarea',
    )!;
    assert.equal(style(composer, "font-size"), "15px");
    assert.equal(style(composer, "line-height"), "21px");
    assert.equal(style(composer, "font-size", true), "16px");
    assert.equal(style(composer, "line-height", true), "22px");
    const legacy = document.querySelector(
      ".composer-wrap:not([data-presentation]):not(.code-composer) textarea",
    )!;
    assert.equal(
      style(legacy, "font-size"),
      size === "s" ? "14px" : size === "l" ? "16px" : "15px",
    );
    const code = document.querySelector(".code-composer")!;
    assert.equal(
      custom(code, "--prompt-text", false),
      size === "s" ? "13px" : size === "l" ? "15px" : "14px",
    );
    assert.equal(declaration(code, "--composer-text"), undefined);
  }
});

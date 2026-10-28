import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AssistantMessage } from "../../src/transcript/AssistantMessage";
import { ReplyBanner } from "../../src/transcript/ReplyBanner";
import {
  MessageActions,
  overflowActions,
  type MessageAction,
} from "../../src/transcript/MessageActions";
import { importedConversation } from "../../electron/conversations/history-archive";
import { buildConversationSnapshot } from "../../electron/conversations/conversation-snapshot";
import { parseSharedChat } from "../../shared/sharing";

test("assistant stacks preserve ordinary replies and the bubbles gate", () => {
  const render = (bubble: boolean, bubbles = true) =>
    renderToStaticMarkup(
      createElement(AssistantMessage, {
        bubble,
        bubbles,
        children: createElement("p", null, "Reply"),
      }),
    );
  assert.match(
    render(false),
    /class="assistant-message-frame" data-cds="AssistantMessage"/,
  );
  assert.match(render(false), /class="assistant-message-body"><p>Reply<\/p>/);
  assert.doesNotMatch(render(false), /data-cds-bubble-stack|data-variant/);
  assert.equal(
    renderToStaticMarkup(
      createElement(AssistantMessage, {
        bubble: false,
        frame: false,
        children: createElement("p", null, "Legacy"),
      }),
    ),
    "<p>Legacy</p>",
  );
  assert.match(render(true), /data-cds-bubble-stack=""/);
  assert.doesNotMatch(render(true), /data-variant/);
  assert.match(render(true, false), /data-variant="bubble"/);
  assert.doesNotMatch(render(true, false), /data-cds-bubble-stack/);
  const css = fs.readFileSync(
    new URL("../../src/transcript/assistant-bubbles.css", import.meta.url),
    "utf8",
  );
  assert.match(css, /--cds-message-bubble-stack-gap: 4px/);
  assert.match(css, /--cds-message-bubble-radius-meeting: 4px/);
  assert.match(
    css,
    /padding-inline-start: calc\(var\(--cds-message-bubble-pad-x\) \+ 1.5em\)/,
  );
});

test("floating overflow retains the first eligible action and excludes pinned, pressed and Speak", () => {
  const action = (id: string, kind?: MessageAction["kind"]): MessageAction => ({
    id,
    kind,
    content: createElement("button", null, id),
  });
  const actions = [
    action("time"),
    action("retry", "retry"),
    action("edit", "edit"),
    action("copy", "copy"),
  ];
  assert.deepEqual(
    overflowActions(actions, true).map((item) => item.id),
    ["edit", "copy"],
  );
  assert.deepEqual(overflowActions(actions, false), []);
  assert.deepEqual(overflowActions(actions.slice(1), true), []);
  for (const extra of [
    { pinned: true },
    { pressed: false },
    { "aria-pressed": false },
    { kind: "speak" as const },
  ]) {
    assert.deepEqual(
      overflowActions(
        actions.map((item) =>
          item.id === "copy" ? { ...item, ...extra } : item,
        ),
        true,
      ),
      [],
    );
  }
  const html = renderToStaticMarkup(
    createElement(MessageActions, { actions, floating: true }),
  );
  assert.match(html, /More options/);
  assert.match(html, />retry</);
  assert.doesNotMatch(html, />edit<|>copy</);
});

test("outcome notices use the official banner and secondary action layout", () => {
  const html = renderToStaticMarkup(
    createElement(ReplyBanner, {
      mode: "chat",
      buttons: [{ label: "Continue", onClick() {} }],
      children: "Claudex reached its tool-use limit for this turn.",
    }),
  );
  assert.match(html, /data-cds="Banner"/);
  assert.match(html, /data-cta-layout="inline"/);
  assert.match(html, /data-action-align="first-line"/);
  assert.doesNotMatch(html, /usage-banner|primary/);
});

test("shared-session author metadata survives profile import, publishing and reading", () => {
  const sessionAuthors = {
    viewerAccountUuid: "viewer",
    ownerAccountUuid: "owner",
  };
  const conversation = importedConversation({
    id: "chat",
    title: "Chat",
    mode: "chat",
    providerId: "p",
    model: "m",
    createdAt: 1,
    updatedAt: 1,
    pinned: false,
    archived: false,
    sessionAuthors,
    turns: [
      {
        id: "turn",
        prompt: "Hello",
        attachments: [],
        status: "completed",
        createdAt: 1,
        items: [{ id: "reply", type: "agentMessage", text: "Hi" }],
      },
    ],
  })!;
  assert.deepEqual(conversation.sessionAuthors, sessionAuthors);
  const snapshot = buildConversationSnapshot(conversation, {
    maxArtifactBytes: 1024,
    maxSnapshotBytes: 10000,
  });
  assert.deepEqual(snapshot.sessionAuthors, sessionAuthors);
  const content = parseSharedChat({
    token: "a".repeat(32),
    kind: "conversation",
    title: "Chat",
    snapshot,
  });
  assert.deepEqual(content?.sessionAuthors, sessionAuthors);
  assert.equal(
    importedConversation({
      ...conversation,
      sessionAuthors: { viewerAccountUuid: 1 },
    })?.sessionAuthors,
    undefined,
  );
});

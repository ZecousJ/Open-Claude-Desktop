import test from "node:test";
import assert from "node:assert/strict";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Conversation } from "../../shared/types";
import { AppContext, type AppController } from "../../src/app/AppContext";
import { MiniTaskComposer } from "../../src/cowork/MiniTaskComposer";
import { MiniSessionView } from "../../src/cowork/MiniSessionView";

const app = (conversations: Conversation[] = []) =>
  ({
    snapshot: {
      settings: {
        providers: [],
        effort: "medium",
        mcpServers: {},
      },
      projects: [],
      platform: "darwin",
      approvals: [],
      conversations,
    },
    policy: { attachments: { types: ["txt"] } },
    notify: () => {},
    report: () => {},
    updatePreference: async () => {},
    upsert: () => {},
    setSnapshot: () => {},
    startProject: () => {},
    setPage: () => {},
  }) as unknown as AppController;

const render = (element: ReactElement, controller = app()) =>
  renderToStaticMarkup(
    createElement(AppContext.Provider, { value: controller }, element),
  );

const composer = (extra: Partial<Parameters<typeof MiniTaskComposer>[0]>) =>
  createElement(MiniTaskComposer, {
    placeholder: "What else can I work on?",
    text: "",
    setText: () => {},
    attachments: [],
    setAttachments: () => {},
    focus: false,
    unsafe: false,
    starting: false,
    onStart: () => {},
    permission: false,
    providerId: "p",
    model: "m",
    onModel: () => {},
    ...extra,
  });

// A quick task's row has the place and permission as icons, then the model and
// Start task.
test("a quick task's composer: place and permission icons, model, Start task", () => {
  const html = render(
    composer({
      permission: true,
      place: { setCwd: () => {}, setProjectId: () => {} },
    }),
  );
  assert.match(html, /<fieldset class="mini-composer"/);
  assert.match(html, /placeholder="What else can I work on\?"/);
  assert.match(html, /class="cowork-place-collapsed"[^>]*aria-label="Project/);
  assert.match(html, /task-permission-trigger mode-default icon-only/);
  assert.match(html, /class="mini-composer-model-button"/);
  assert.match(html, /aria-label="Start task"[^>]*disabled=""/);
  assert.doesNotMatch(html, /Use caution/);
});

test("a spun-off or outside prompt's composer offers neither place nor permission", () => {
  const html = render(
    composer({
      placeholder: "How should I spin off this task for you?",
      text: "Plan it",
      unsafe: true,
    }),
  );
  assert.doesNotMatch(html, /cowork-place-collapsed|task-permission-trigger/);
  assert.match(html, /role="status"[^>]*>.*Use caution before running/);
  assert.doesNotMatch(html, /aria-label="Start task"[^>]*disabled/);
});

const turn = (status: string, items: unknown[] = []) => ({
  id: "t1",
  prompt: "Plan the trip",
  attachments: [],
  items,
  status,
  createdAt: 0,
});
const task = (extra: Partial<Conversation> = {}) =>
  ({
    id: "s1",
    title: "Trip",
    mode: "cowork",
    providerId: "p",
    model: "m",
    turns: [turn("inProgress")],
    ...extra,
  }) as unknown as Conversation;

test("the live view: Connecting… until the task arrives", () => {
  const html = render(
    createElement(MiniSessionView, { sessionId: "s1", shown: true }),
  );
  assert.match(html, /class="mini-session-connecting">Connecting…/);
});

test("the live view: the prompt, Working on it…, a reply field that stops", () => {
  const html = render(
    createElement(MiniSessionView, { sessionId: "s1", shown: true }),
    app([task()]),
  );
  assert.match(html, /Plan the trip/);
  assert.match(html, /Working on it…/);
  assert.match(html, /placeholder="Reply to Claudex…"/);
  assert.match(html, /aria-label="Stop response"/);
});

test("the live view: a task that never got going, and an archived one", () => {
  const failed = render(
    createElement(MiniSessionView, { sessionId: "s1", shown: true }),
    app([task({ turns: [turn("failed")] as never })]),
  );
  assert.match(failed, /Couldn’t set up this task/);
  assert.match(failed, /aria-label="Send message"/);
  const archived = render(
    createElement(MiniSessionView, { sessionId: "s1", shown: true }),
    app([task({ archived: true, turns: [turn("completed")] as never })]),
  );
  assert.match(archived, /This task is archived/);
  assert.doesNotMatch(archived, /Reply to Claudex/);
});

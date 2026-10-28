import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { act, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { Engine } from "../../electron/engine/engine";
import { Store } from "../../electron/store/store";
import { TitleOfferGenerator } from "../../electron/engine/title-offers";
import { registerConversationHandlers } from "../../electron/ipc/conversations";
import {
  pendingTitleOffer,
  respondToTitleOffer,
} from "../../shared/title-offers";
import type { Conversation, Turn } from "../../shared/types";
import { TitleOfferCard } from "../../src/title-offers/TitleOfferCard";

const turn = (id: string): Turn => ({
  id,
  prompt: `Work on ${id}`,
  attachments: [],
  status: "completed",
  createdAt: 1,
  items: [{ id: `${id}-reply`, type: "agentMessage", text: `Finished ${id}` }],
});
const session = (extra: Partial<Conversation> = {}): Conversation => ({
  id: "session",
  title: "Original topic",
  mode: "code",
  providerId: "provider",
  model: "model",
  pinned: false,
  archived: false,
  createdAt: 1,
  updatedAt: 1,
  turns: [turn("first"), turn("second")],
  ...extra,
});
const proposed = () => ({
  proposedTitle: "New topic",
  at: 10,
  titleAtOffer: "Original topic",
  turnId: "second",
  state: "offered" as const,
});

test("a generated title follows the work: the session is renamed, no offer", async () => {
  const conversation = session();
  let saves = 0;
  const generator = new TitleOfferGenerator(
    () => async () => '{"proposedTitle":" New topic "}',
    () => conversation,
    () => saves++,
  );
  await generator.afterTurn(conversation, conversation.turns.at(-1)!);
  assert.equal(conversation.title, "New topic");
  assert.equal(conversation.titleOffer, undefined);
  assert.equal(pendingTitleOffer(conversation), false);
  assert.equal(conversation.titleOfferCheckedTurnId, "second");
  assert.equal(saves, 1);
});

test("a title the person chose is offered a change, not renamed", async () => {
  const conversation = session({ titleSetByUser: true });
  let calls = 0;
  let saves = 0;
  const generator = new TitleOfferGenerator(
    () => async (prompt, options) => {
      calls++;
      const input = JSON.parse(prompt.input);
      assert.equal(input.currentTitle, "Original topic");
      assert.match(input.transcript, /Work on second/);
      assert.match(prompt.instructions, /substantially changed/);
      assert.equal(options?.maxOutputTokens, 1024);
      return '{"proposedTitle":" New topic "}';
    },
    () => conversation,
    () => saves++,
  );
  await generator.afterTurn(conversation, conversation.turns.at(-1)!);
  assert.equal(conversation.title, "Original topic");
  assert.equal(conversation.titleOffer?.proposedTitle, "New topic");
  assert.equal(conversation.titleOffer?.titleAtOffer, "Original topic");
  assert.equal(conversation.titleOffer?.turnId, "second");
  assert.equal(conversation.titleOfferCheckedTurnId, "second");
  assert(pendingTitleOffer(conversation));
  await generator.afterTurn(conversation, conversation.turns.at(-1)!);
  assert.equal(calls, 1);
  assert.equal(saves, 1);
});

test("first turns, failures, shell commands, compactions, suppressed and non-Code sessions do not call a model", async () => {
  const variants = [
    session({ turns: [turn("first")] }),
    session({ mode: "chat" }),
    session({ mode: "cowork" }),
    session({ incognito: true }),
    session({ archived: true }),
    session({ titleOffersSuppressed: true }),
    session({ titleOffer: proposed(), titleSetByUser: true }),
    session({
      turns: [turn("first"), { ...turn("second"), status: "failed" }],
    }),
    session({
      turns: [turn("first"), { ...turn("second"), status: "interrupted" }],
    }),
    session({ turns: [turn("first"), { ...turn("second"), shell: true }] }),
    session({
      turns: [turn("first"), { ...turn("second"), compaction: "manual" }],
    }),
  ];
  for (const conversation of variants) {
    const generator = new TitleOfferGenerator(
      () => async () => assert.fail("unexpected request"),
      () => conversation,
      () => assert.fail("unexpected save"),
    );
    await generator.afterTurn(conversation, conversation.turns.at(-1)!);
  }
});

test("unchanged topics, repeated declined titles and malformed or failing replies never create offers", async () => {
  for (const answer of [
    '{"proposedTitle":null}',
    '{"proposedTitle":"Original topic"}',
    '{"proposedTitle":"New topic"}',
    "{}",
    "not JSON",
    '{"proposedTitle":42}',
    '{"proposedTitle":""}',
    JSON.stringify({ proposedTitle: "x".repeat(81) }),
    JSON.stringify({ proposedTitle: "two\nlines" }),
  ]) {
    const conversation = session({
      titleOffer: { ...proposed(), state: "kept" },
    });
    const generator = new TitleOfferGenerator(
      () => async () => answer,
      () => conversation,
      () => {},
    );
    await generator.afterTurn(conversation, conversation.turns.at(-1)!);
    assert.equal(conversation.titleOffer?.state, "kept");
  }
  const conversation = session();
  const generator = new TitleOfferGenerator(
    () => async () => {
      throw Error("offline");
    },
    () => conversation,
    () => assert.fail("unexpected save"),
  );
  await generator.afterTurn(conversation, conversation.turns.at(-1)!);
  assert.equal(conversation.titleOffer, undefined);
});

test("late results cannot overwrite a rename, suppression, newer turn, deleted session or stopped engine", async () => {
  for (const change of [
    "rename",
    "suppress",
    "turn",
    "delete",
    "stop",
  ] as const) {
    const conversation = session();
    let current: Conversation | undefined = conversation;
    let resolve!: (answer: string) => void;
    const generator = new TitleOfferGenerator(
      () => () =>
        new Promise((done) => {
          resolve = done;
        }),
      () => current,
      () => assert.fail("stale save"),
    );
    const pending = generator.afterTurn(
      conversation,
      conversation.turns.at(-1)!,
    );
    if (change === "rename") conversation.title = "Manually named";
    if (change === "suppress") conversation.titleOffersSuppressed = true;
    if (change === "turn") conversation.turns.push(turn("third"));
    if (change === "delete") current = undefined;
    if (change === "stop") generator.stop();
    resolve('{"proposedTitle":"New topic"}');
    await pending;
    assert.equal(conversation.titleOffer, undefined);
  }
});

test("Accept, Dismiss and suppression are versioned, persisted and broadcast by the shared desktop/runner handler", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-title-offer-"));
  try {
    const store = new Store(root);
    const conversation = session({ titleOffer: proposed() });
    store.conversations.push(conversation);
    const pushed: unknown[] = [];
    const handlers = new Map<string, (...args: any[]) => any>();
    registerConversationHandlers(
      (name, handler) => handlers.set(name, handler),
      {
        store,
        engine: {},
        replyFeedback: {},
        selectedAttachments: new Map(),
        allowedFolder() {},
        noActive() {},
        push: (event: unknown) => pushed.push(event),
      } as never,
    );
    const update = handlers.get("updateConversation")!;
    update(conversation.id, {
      titleOfferResponse: { at: 9, action: "accept" },
    });
    assert.equal(conversation.title, "Original topic");
    update(conversation.id, {
      titleOfferResponse: { at: 10, action: "accept" },
    });
    assert.equal(conversation.title, "New topic");
    assert.equal(
      new Store(root).conversation(conversation.id).titleOffer?.state,
      "accepted",
    );
    conversation.title = "Original topic";
    conversation.titleOffer = proposed();
    update(conversation.id, { titleOfferResponse: { at: 10, action: "keep" } });
    assert.equal(conversation.title, "Original topic");
    assert.equal(conversation.titleOffer.state, "kept");
    assert(!conversation.titleOffersSuppressed);
    update(conversation.id, {
      titleOfferResponse: { at: 10, action: "accept" },
    });
    assert.equal(conversation.title, "Original topic");
    conversation.titleOffer = proposed();
    update(conversation.id, {
      titleOfferResponse: { at: 10, action: "suppress" },
    });
    assert.equal(
      new Store(root).conversation(conversation.id).titleOffersSuppressed,
      true,
    );
    assert.equal(conversation.titleOffer.state, "suppressed");
    delete conversation.titleOffersSuppressed;
    conversation.titleOffer = proposed();
    update(conversation.id, { titleOffersSuppressed: true });
    assert.equal(conversation.titleOffer.state, "suppressed");
    assert(!pendingTitleOffer(conversation));
    assert.equal(pushed.length, 6);
    assert.throws(() =>
      update(conversation.id, {
        titleOfferResponse: { at: 10, action: "invalid" },
      }),
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("manual rename invalidates an offer; resolved cards keep their proposal without action buttons", () => {
  const conversation = session({ titleOffer: proposed() });
  const render = () =>
    renderToStaticMarkup(
      createElement(TitleOfferCard, { conversation, onError() {} }),
    );
  const pending = render();
  assert.match(pending, /role="group"/);
  for (const label of ["New title", "New topic", "Accept", "Dismiss"])
    assert(pending.includes(label));
  assert(!pending.includes("Don&#x27;t suggest again"));
  assert.match(pending, /data-no-translate/);
  respondToTitleOffer(conversation, { at: 10, action: "keep" });
  assert.match(render(), /Kept title/);
  assert(
    // The resolved row is itself a button (the live step row), but it
    // offers no Accept/Dismiss actions any more.
    !/Accept|Dismiss/.test(render()) && render().includes("title-offer-row"),
  );
  conversation.titleOffer = proposed();
  conversation.title = "Manual title";
  assert(!pendingTitleOffer(conversation));
  assert.equal(
    respondToTitleOffer(conversation, { at: 10, action: "accept" }),
    false,
  );
  assert.equal(conversation.title, "Manual title");
});

test("the engine produces offers after real turn/completed notifications, not from opening-prompt punctuation", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-title-engine-"));
  const store = new Store(root);
  try {
    const conversation = session({ threadId: "thread", titleSetByUser: true });
    conversation.turns.at(-1)!.status = "inProgress";
    store.conversations.push(conversation);
    const events: unknown[] = [];
    const engine = new Engine(
      store,
      "unused",
      () => "",
      (event) => events.push(event),
    );
    const internals = engine as any;
    internals.routes.set("thread", conversation.id);
    internals.titleOffers = new TitleOfferGenerator(
      () => async () => '{"proposedTitle":"New topic"}',
      () => conversation,
      (updated) => internals.changed(updated, true),
    );
    internals.notification({
      method: "turn/completed",
      params: {
        threadId: "thread",
        turn: { id: "second", status: "completed" },
      },
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(conversation.titleOffer?.proposedTitle, "New topic");
    store.flush();
    assert.equal(
      new Store(root).conversation(conversation.id).titleOffer?.turnId,
      "second",
    );
    assert(events.length > 0);
  } finally {
    store.flush();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("card buttons send versioned responses, block duplicate clicks and recover from errors", async () => {
  const { window } = parseHTML("<html><body><main></main></body></html>");
  const globals = {
    IS_REACT_ACT_ENVIRONMENT: true,
    window,
    document: window.document,
    navigator: { userAgent: "node" },
  };
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
  const root = createRoot(window.document.querySelector("main")!);
  try {
    for (const [label, action] of [
      ["Accept", "accept"],
      ["Dismiss", "keep"],
    ]) {
      const conversation = session({ titleOffer: proposed() });
      const errors: unknown[] = [];
      let calls = 0;
      let fail!: (error: Error) => void;
      Object.assign(window, {
        desktop: {
          updateConversation(id: string, patch: unknown) {
            calls++;
            assert.equal(id, conversation.id);
            assert.deepEqual(patch, { titleOfferResponse: { at: 10, action } });
            return new Promise((_resolve, reject) => {
              fail = reject;
            });
          },
        },
      });
      await act(async () =>
        root.render(
          createElement(TitleOfferCard, {
            key: action,
            conversation,
            onError: (error) => errors.push(error),
          }),
        ),
      );
      const button = [...window.document.querySelectorAll("button")].find(
        (item) => item.textContent === label,
      )!;
      await act(async () => {
        button.click();
        button.click();
      });
      assert.equal(calls, 1);
      assert(
        [...window.document.querySelectorAll("button")].every(
          (item) => item.disabled,
        ),
      );
      await act(async () => fail(Error("offline")));
      assert.equal(errors.length, 1);
      assert(!button.disabled);
      assert(pendingTitleOffer(conversation));
    }
  } finally {
    await act(async () => root.unmount());
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

test("title checks are spaced out: after the second turn, then every five", async () => {
  const { dueForCheck } = await import("../../electron/engine/title-offers");
  const turns = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      id: `t${i}`,
      status: "completed",
    })) as never;
  assert.equal(dueForCheck({ turns: turns(1) } as never), false);
  assert.equal(dueForCheck({ turns: turns(2) } as never), true);
  assert.equal(
    dueForCheck({ turns: turns(6), titleOfferCheckedTurnId: "t1" } as never),
    false,
  );
  assert.equal(
    dueForCheck({ turns: turns(7), titleOfferCheckedTurnId: "t1" } as never),
    true,
  );
});

test("a pending title offer has two actions; Don't suggest again lives in the resolved row and the menus", async () => {
  const { window } = parseHTML("<html><body><main></main></body></html>");
  const globals = {
    IS_REACT_ACT_ENVIRONMENT: true,
    window,
    document: window.document,
    navigator: { userAgent: "node" },
  };
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
  const root = createRoot(window.document.querySelector("main")!);
  try {
    await act(async () =>
      root.render(
        createElement(TitleOfferCard, {
          conversation: session({ titleOffer: proposed() }),
          onError: () => {},
        }),
      ),
    );
    const labels = [...window.document.querySelectorAll("button")].map(
      (item) => item.textContent,
    );
    assert.equal(labels.join("|"), "Dismiss|Accept");
  } finally {
    await act(async () => root.unmount());
    for (const [key, value] of saved) {
      if (value) Object.defineProperty(globalThis, key, value);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

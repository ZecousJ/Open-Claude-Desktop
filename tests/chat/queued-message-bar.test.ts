import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Conversation } from "../../shared/types";
import {
  QueuedMessageBar,
  type QueuedMessageBarProps,
} from "../../src/composer/QueuedMessageBar";
import {
  addQueued,
  clearQueued,
  queuedMessages,
  queuedPreview,
  removeQueued,
  type QueuedMessage,
} from "../../src/composer/queue";
import { sendQueuedNow } from "../../src/composer/queue";

const base = {
  attachments: [],
  state: "queued" as const,
  mode: "code" as const,
  providerId: "p",
  model: "m",
  webSearch: false,
};
const entry = (id: string, text: string, extra: Partial<QueuedMessage> = {}) =>
  ({ ...base, id, text, ...extra }) as QueuedMessage;
const noop = () => {};
const render = (props: Partial<QueuedMessageBarProps>) =>
  renderToStaticMarkup(
    createElement(QueuedMessageBar, {
      entries: [],
      onCancel: noop,
      onEdit: noop,
      onSteer: noop,
      onReorder: noop,
      onClearAll: noop,
      ...props,
    }),
  );

const conversation = (id: string, running: boolean) =>
  ({
    id,
    turns: [
      {
        id: "t",
        status: running ? "inProgress" : "completed",
        items: [],
      },
    ],
  }) as unknown as Conversation;

// One message is a band with Send now, Edit in composer and Remove from queue.
test("one queued message is a band with its three actions", () => {
  const html = render({ entries: [entry("a", "Run   the\ntests")] });
  assert.match(html, /class="queued-bar-band"/);
  assert.match(html, />1 message queued</);
  assert.match(html, />Run the tests</);
  assert.match(html, /aria-label="Send now"/);
  assert.match(html, /aria-label="Edit in composer"/);
  assert.match(html, /aria-label="Remove from queue"/);
  assert.match(html, /Claudex reads this message at its next step\./);
});

test("a message the turn took reads Sent and has no actions", () => {
  const html = render({ entries: [entry("a", "Hi", { state: "steered" })] });
  assert.match(html, /data-testid="queued-row-sent"/);
  assert.match(html, />Sent</);
  assert.doesNotMatch(html, /aria-label="Send now"/);
  assert.doesNotMatch(html, /aria-label="Remove from queue"/);
});

test("Send now spins while the turn is being handed the message", () => {
  const html = render({ entries: [entry("a", "Hi", { steering: true })] });
  assert.match(html, /aria-busy="true"/);
  assert.match(html, /Sending…/);
});

test("two or more fold into a button naming the next one", () => {
  const html = render({ entries: [entry("a", "First"), entry("b", "Second")] });
  assert.match(html, /<button[^>]*class="queued-bar-band queued-bar-summary"/);
  assert.match(html, /aria-expanded="false"/);
  assert.match(html, />2 messages queued</);
  assert.match(html, />Next: First</);
  assert.doesNotMatch(html, /Second/);
});

test("the open list has handles, a menu per row and Clear all", () => {
  const html = render({
    initiallyExpanded: true,
    entries: [
      entry("s", "Taken", { state: "steered" }),
      entry("a", "First"),
      entry("b", "Second"),
    ],
  });
  assert.match(html, /role="list" aria-label="Queued messages"/);
  assert.match(html, /aria-label="Collapse queued messages"/);
  assert.equal(html.match(/role="listitem"/g)?.length, 3);
  assert.equal(html.match(/aria-label="Reorder queued message"/g)?.length, 2);
  assert.equal(html.match(/aria-label="Queued message actions"/g)?.length, 2);
  assert.match(html, />Clear all</);
  // The taken one reads Sent and cannot be moved or removed.
  assert.match(html, /data-entry="s"[^>]*data-sent="true"/);
});

test("a single waiting message among taken ones cannot be dragged", () => {
  const html = render({
    initiallyExpanded: true,
    entries: [entry("s", "Taken", { state: "steered" }), entry("a", "First")],
  });
  assert.doesNotMatch(html, /Reorder queued message/);
  assert.match(html, /Queued message actions/);
});

test("the preview names files and images and collapses white space", () => {
  assert.equal(
    queuedPreview({
      text: "  Look\n at  ",
      attachments: [
        { id: "1", name: "a.ts", path: "/a.ts", kind: "text", size: 1 },
        { id: "2", name: "b.png", path: "/b.png", kind: "image", size: 1 },
      ],
    }),
    "Look at @a.ts [Image]",
  );
  assert.equal(queuedPreview({ text: " ", attachments: [] }), "…");
});

test("Clear all keeps the messages the turn already took", () => {
  addQueued("qb-1", { ...base, text: "a" });
  const taken = addQueued("qb-1", { ...base, text: "t", state: "steered" });
  addQueued("qb-1", { ...base, text: "b" });
  clearQueued("qb-1");
  assert.deepEqual(
    queuedMessages("qb-1").map((item) => item.text),
    ["t"],
  );
  removeQueued("qb-1", taken.id);
});

test("Send now hands a waiting message to the running turn", async () => {
  const added = addQueued("qb-2", { ...base, text: "steer me" });
  const upserts: Conversation[] = [];
  const calls: unknown[][] = [];
  (globalThis as { window?: unknown }).window = {
    desktop: {
      steerTurn: async (...args: unknown[]) => {
        calls.push(args);
        return { messageId: "m-1", conversation: conversation("qb-2", true) };
      },
    },
  };
  try {
    const result = await sendQueuedNow(
      conversation("qb-2", true),
      added.id,
      (c) => upserts.push(c),
    );
    assert.equal(result, "steered");
    assert.deepEqual(calls, [["qb-2", "steer me", []]]);
    const [after] = queuedMessages("qb-2");
    assert.equal(after.state, "steered");
    assert.equal(after.messageId, "m-1");
    assert.equal(after.steering, undefined);
    assert.equal(upserts.length, 1);
  } finally {
    removeQueued("qb-2", added.id);
    delete (globalThis as { window?: unknown }).window;
  }
});

test("Send now keeps the message queued when the turn cannot take it", async () => {
  const added = addQueued("qb-3", { ...base, text: "later" });
  (globalThis as { window?: unknown }).window = {
    desktop: { steerTurn: async () => null },
  };
  try {
    const result = await sendQueuedNow(
      conversation("qb-3", true),
      added.id,
      noop,
    );
    assert.equal(result, "held");
    const [after] = queuedMessages("qb-3");
    assert.equal(after.state, "queued");
    assert.equal(after.steering, undefined);
  } finally {
    removeQueued("qb-3", added.id);
    delete (globalThis as { window?: unknown }).window;
  }
});

test("Send now on an idle conversation sends that message first", async () => {
  const first = addQueued("qb-4", { ...base, text: "one", error: "failed" });
  const second = addQueued("qb-4", { ...base, text: "two" });
  const sent: string[] = [];
  const result = await sendQueuedNow(
    conversation("qb-4", false),
    second.id,
    noop,
    async (item) => {
      sent.push(item.text);
    },
  );
  assert.equal(result, "sent");
  assert.deepEqual(sent, ["two"]);
  assert.deepEqual(
    queuedMessages("qb-4").map((item) => item.text),
    ["one"],
  );
  removeQueued("qb-4", first.id);
});

import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ChatQueuedRows,
  queuedStatus,
  type Placement,
} from "../../src/composer/ChatQueuedMessages";
import {
  addQueued,
  moveQueued,
  queuedMessages,
  removeQueued,
  type QueuedMessage,
} from "../../src/composer/queue";

const entry = {
  text: "Second message",
  attachments: [],
  state: "queued" as const,
  mode: "chat" as const,
  providerId: "p",
  model: "m",
  webSearch: false,
};
const noop = () => {};
const render = (
  entries: QueuedMessage[],
  placement: Placement = "end",
  actions = true,
) =>
  renderToStaticMarkup(
    createElement(ChatQueuedRows, {
      rows: entries.map((value) => ({ entry: value, exiting: false })),
      placement,
      ...(actions ? { onRemove: noop, onEdit: noop, onSendNow: noop } : {}),
    }),
  );
const make = (patch: Partial<QueuedMessage> = {}): QueuedMessage => ({
  ...entry,
  id: "x",
  ...patch,
});

// A queued message is a right-aligned bubble with Send now, Edit in composer
// and Remove from queue; one the running turn took reads Sent.
test("a queued message is a bubble with its three actions", () => {
  const html = render([make()]);
  assert.match(html, /class="chat-queued-bubble"/);
  assert.match(html, /Second message/);
  assert.match(html, /aria-label="Send now"/);
  assert.match(html, /aria-label="Edit in composer"/);
  assert.match(html, /aria-label="Remove from queue"/);
  assert.match(html, /data-placement="end"/);
});

test("a taken message reads Sent and has no actions", () => {
  const html = render([make({ state: "steered" })]);
  assert.match(html, /Sent/);
  assert.doesNotMatch(html, /Send now/);
});

test("with no room at the end the actions sit inside the bubble", () => {
  const html = render([make()], "start");
  assert.match(html, /data-side="inside"/);
  assert.match(html, /--queued-reserve:86px/);
});

test("no rows draw nothing; the status counts waiting messages", () => {
  assert.equal(render([]), "");
  assert.equal(queuedStatus(0), "");
  assert.match(queuedStatus(1), /^1 message queued/);
  assert.match(queuedStatus(3), /^3 messages queued/);
});

test("waiting messages move among themselves; taken ones keep their places", () => {
  const a = addQueued("q-3", { ...entry, text: "a" });
  const taken = addQueued("q-3", { ...entry, text: "t", state: "steered" });
  const b = addQueued("q-3", { ...entry, text: "b" });
  const c = addQueued("q-3", { ...entry, text: "c" });
  const order = () => queuedMessages("q-3").map((value) => value.text);
  try {
    moveQueued("q-3", c.id, a.id);
    assert.deepEqual(order(), ["c", "t", "a", "b"]);
    moveQueued("q-3", c.id, undefined);
    assert.deepEqual(order(), ["a", "t", "b", "c"]);
    // A taken message is not moved.
    moveQueued("q-3", taken.id, a.id);
    assert.deepEqual(order(), ["a", "t", "b", "c"]);
  } finally {
    for (const value of [a, taken, b, c]) removeQueued("q-3", value.id);
  }
});

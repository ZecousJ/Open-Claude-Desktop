import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Conversation, Turn } from "../../shared/types";
import {
  CoworkActiveList,
  activeCoworkTasks,
  activeListLimit,
} from "../../src/cowork/CoworkActiveList";

const conversation = (
  id: string,
  patch: Partial<Conversation> = {},
): Conversation => ({
  id,
  title: id,
  mode: "cowork",
  providerId: "p",
  model: "m",
  pinned: false,
  archived: false,
  createdAt: 0,
  updatedAt: 0,
  turns: [],
  ...patch,
});
const running = [{ status: "inProgress" } as Turn];

test("Active prioritizes attention and completed unread Cowork tasks", () => {
  const list = activeCoworkTasks([
    conversation("read", { updatedAt: 9 }),
    conversation("unread", { unread: true, updatedAt: 2 }),
    conversation("running", { turns: running, updatedAt: 5 }),
    conversation("chat", { mode: "chat", unread: true, updatedAt: 8 }),
    conversation("code", { mode: "code", unread: true, updatedAt: 8 }),
    conversation("archived", { archived: true, unread: true }),
    conversation("incognito", { incognito: true, unread: true }),
  ]);
  assert.deepEqual(
    list.map((c) => c.id),
    ["unread", "running"],
  );
  const many = Array.from({ length: 12 }, (_, i) =>
    conversation(`t${i}`, { unread: true, updatedAt: i }),
  );
  assert.equal(activeCoworkTasks(many).length, many.length);
  assert.deepEqual(
    activeCoworkTasks(
      [conversation("running", { turns: running }), conversation("attention")],
      [{ conversationId: "attention" }],
    ).map((item) => item.id),
    ["attention", "running"],
  );
});

test("Clear active offers the finished tasks only; nothing active hides the block", () => {
  const noop = () => {};
  const render = (conversations: Conversation[], onClear = noop) =>
    renderToStaticMarkup(
      createElement(CoworkActiveList, {
        conversations,
        onOpen: noop,
        onClear,
      }),
    );
  assert.equal(render([conversation("read")]), "");
  const html = render([
    conversation("Done task", {
      unread: true,
      turns: [{ status: "completed" } as Turn],
      updatedAt: Date.now() - 86_400_000 * 3,
    }),
  ]);
  assert.match(html, /Active/);
  assert.match(html, />Clear active</);
  assert.match(html, /href="\/chat\/Done%20task"/);
  assert.match(html, /3 days ago/);
  assert.match(html, /cowork-home-ready_review/);
  // A task still running cannot be cleared: no button while it is the only one.
  assert.doesNotMatch(
    render([conversation("Busy", { turns: running })]),
    /Clear active/,
  );
});

test("Active renders five rows, separators, and Show more", () => {
  const many = Array.from({ length: 6 }, (_, index) =>
    conversation(`task-${index}`, { unread: true, updatedAt: index }),
  );
  const html = renderToStaticMarkup(
    createElement(CoworkActiveList, {
      conversations: many,
      onOpen: () => {},
      onClear: () => {},
    }),
  );
  assert.equal((html.match(/class="cowork-active-rows"/g) ?? []).length, 1);
  assert.equal((html.match(/<hr/g) ?? []).length, activeListLimit - 1);
  assert.match(html, />Show more</);
});

test("pinned headings distinguish pinned-only from pinned and active", () => {
  const render = (conversations: Conversation[]) =>
    renderToStaticMarkup(
      createElement(CoworkActiveList, {
        conversations,
        onOpen: () => {},
        onClear: () => {},
      }),
    );
  const pinned = conversation("pin", { pinned: true });
  assert.match(render([pinned]), /<h3>Pinned<\/h3>/);
  assert.match(
    render([{ ...pinned, turns: [{ status: "completed" } as Turn] }]),
    /data-icon="Pin"/,
  );
  assert.match(
    render([pinned, conversation("active", { unread: true })]),
    /<h3>Pinned or active<\/h3>/,
  );
});

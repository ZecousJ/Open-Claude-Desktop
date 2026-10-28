import test from "node:test";
import assert from "node:assert/strict";
import { createElement as h } from "react";
import { SidebarLoadBoundary } from "../../src/sidebar/SidebarLoadBoundary";
import { routineDom } from "../support/routine-dom";

test("real sidebar render failure is contained, retry renders repaired data, repeated failure stays honest", async () => {
  const env = await routineDom({}, { jsdom: true });
  let failing = true;
  const errors: unknown[] = [],
    scope = {};
  function Rows() {
    if (failing) throw new Error("Malformed row");
    return h("button", {}, "Actual conversation");
  }
  try {
    await env.render(
      h(
        "div",
        {},
        h("button", {}, "New"),
        h(
          SidebarLoadBoundary,
          { scope, onError: (e) => errors.push(e) },
          h(Rows),
        ),
        h("main", {}, "Chat remains available"),
      ),
    );
    assert.equal(
      env.document.querySelector('[role="alert"] p')?.textContent,
      "Sidebar failed to load.",
    );
    assert.ok(env.document.querySelector("main"));
    assert.equal(errors.length, 1);
    await env.click('[role="alert"] button');
    assert.ok(env.document.querySelector('[role="alert"]'));
    assert.equal(errors.length, 2);
    failing = false;
    await env.click('[role="alert"] button');
    assert.equal(env.document.querySelector('[role="alert"]'), null);
    assert.match(env.document.body.textContent!, /Actual conversation/);
  } finally {
    await env.clean();
  }
});

test("new account/controller/bridge scope retires the previous sidebar failure before rendering its rows", async () => {
  const env = await routineDom({}, { jsdom: true });
  function Broken() {
    throw new Error("Old owner render failure");
    return null;
  }
  try {
    await env.render(
      h(SidebarLoadBoundary, { scope: {}, onError: () => {} }, h(Broken)),
    );
    assert.ok(env.document.querySelector('[role="alert"]'));
    await env.render(
      h(
        SidebarLoadBoundary,
        { scope: {}, onError: () => {} },
        h("div", {}, "New owner rows"),
      ),
    );
    assert.equal(env.document.querySelector('[role="alert"]'), null);
    assert.equal(env.document.body.textContent, "New owner rows");
  } finally {
    await env.clean();
  }
});

test("the actual conversation-list render error recovers its real row without replacing navigation or the chat", async () => {
  const { ConversationList } =
    await import("../../src/sidebar/ConversationList");
  const env = await routineDom(
    { listConversationGroups: async () => ({ groups: [], members: {} }) },
    { jsdom: true },
  );
  const previousCancel = Object.getOwnPropertyDescriptor(
    globalThis,
    "cancelAnimationFrame",
  );
  Object.defineProperty(globalThis, "requestAnimationFrame", {
    configurable: true,
    writable: true,
    value: env.window.requestAnimationFrame.bind(env.window),
  });
  Object.defineProperty(globalThis, "cancelAnimationFrame", {
    configurable: true,
    writable: true,
    value: env.window.cancelAnimationFrame.bind(env.window),
  });
  let broken = true;
  const row: import("../../shared/types").Conversation = {
    id: "sidebar-live-row",
    mode: "chat",
    providerId: "p",
    model: "m",
    pinned: false,
    archived: false,
    createdAt: 1,
    updatedAt: 1,
    turns: [],
    get title() {
      if (broken) throw new Error("Actual row failed to render");
      return "Recovered conversation";
    },
  };
  const noop = () => {};
  try {
    await env.render(
      h(
        "div",
        {},
        h("nav", {}, "New"),
        h(
          SidebarLoadBoundary,
          { scope: {}, onError: noop },
          h(ConversationList, {
            conversations: [row],
            projects: [],
            page: "chat",
            mode: "chat",
            approvalIds: new Set<string>(),
            onPageChange: noop,
            onReorder: async () => {},
            onError: noop,
            onOpen: noop,
            onRename: noop,
            onMoveToProject: noop,
            onToggleArchive: noop,
            onDelete: noop,
            onToggleUnread: noop,
            onOpenIn: noop,
          }),
        ),
        h("main", { "data-b21-chat": "true" }, "Chat"),
      ),
    );
    assert.ok(env.document.querySelector('[role="alert"]'));
    assert.equal(env.document.querySelector("nav")?.textContent, "New");
    assert.equal(
      env.document.querySelector("[data-b21-chat]")?.textContent,
      "Chat",
    );
    broken = false;
    await env.click('[role="alert"] button');
    assert.equal(env.document.querySelector('[role="alert"]'), null);
    assert.match(env.document.body.textContent!, /Recovered conversation/);
  } finally {
    await env.clean();
    if (previousCancel)
      Object.defineProperty(globalThis, "cancelAnimationFrame", previousCancel);
    else Reflect.deleteProperty(globalThis, "cancelAnimationFrame");
  }
});

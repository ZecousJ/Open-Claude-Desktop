import test from "node:test";
import assert from "node:assert/strict";
import { act, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import {
  ProjectChatSearch,
  ProjectSearchResults,
  ProjectSearchText,
  projectSearchDelay,
} from "../../src/collections/projects/ProjectChatSearch";
import type { Conversation } from "../../shared/types";
import type { HistorySearchHit } from "../../shared/history-search";

const hit: HistorySearchHit = {
  conversationId: "chat",
  title: "Travel plans",
  mode: "chat",
  projectId: "project",
  updatedAt: 1000,
  archived: false,
  snippet: "Travel to Kyoto",
};

test("project search uses the official placeholder and retains chats before searching", () => {
  const html = renderToStaticMarkup(
    createElement(ProjectChatSearch, {
      projectId: "project",
      chats: [],
      onOpen() {},
      onError() {},
      children: "Recents",
    }),
  );
  assert.match(html, /role="search"/);
  assert.match(html, /aria-label="Search this project"/);
  assert.match(html, /placeholder="Search this project"/);
  assert.match(html, /Recents/);
  assert.doesNotMatch(html, /No matches|Load older/);
});

test("search results highlight text safely and distinguish loading from no matches", () => {
  assert.equal(
    renderToStaticMarkup(
      createElement(ProjectSearchText, {
        text: "Travel <travel>",
        query: "TRAVEL",
      }),
    ),
    "<strong>Travel</strong> &lt;<strong>travel</strong>&gt;",
  );
  const empty = renderToStaticMarkup(
    createElement(ProjectSearchResults, {
      query: "x",
      results: [],
      pending: false,
      onOpen() {},
    }),
  );
  assert.match(empty, /class="prj-search-empty"><h3>No matches\.<\/h3>/);
  const pending = renderToStaticMarkup(
    createElement(ProjectSearchResults, {
      query: "x",
      results: [],
      pending: true,
      onOpen() {},
    }),
  );
  assert.match(pending, /aria-busy="true"/);
  assert.doesNotMatch(pending, /No matches/);
  const results = renderToStaticMarkup(
    createElement(ProjectSearchResults, {
      query: "travel",
      results: [hit],
      pending: false,
      onOpen() {},
    }),
  );
  assert.match(results, /<strong>Travel<\/strong> plans/);
  assert.match(results, /<strong>Travel<\/strong> to Kyoto/);
  assert.doesNotMatch(results, /Pinned|Recents|Show more|Load older/);
});

test("project search debounces, ignores stale replies, opens chats and clears with Escape", async (t) => {
  const { window, document } = parseHTML(
    "<html><body><main></main></body></html>",
  );
  (document as unknown as { oninput: null }).oninput = null;
  const globals = { window, document, IS_REACT_ACT_ENVIRONMENT: true };
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
  const calls: {
    query: string;
    options: unknown;
    resolve: (value: { results: HistorySearchHit[] }) => void;
    reject: (error: unknown) => void;
  }[] = [];
  window.desktop = {
    searchConversations: (query, options) =>
      new Promise((resolve, reject) =>
        calls.push({ query, options, resolve, reject }),
      ),
  } as typeof window.desktop;
  const { createRoot } = await import("react-dom/client");
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const root = createRoot(document.querySelector("main")!);
  const conversation = { id: "chat" } as Conversation;
  const opened: Conversation[] = [];
  const errors: unknown[] = [];
  const input = () => document.querySelector<HTMLInputElement>("input")!;
  const change = async (value: string) =>
    act(() => {
      Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      )!.set!.call(input(), value);
      input().dispatchEvent(new window.Event("input", { bubbles: true }));
    });
  const wait = () =>
    act(async () => {
      // Advance the actual debounce boundary; CPU load cannot turn an
      // elapsed wall-clock sleep into evidence that its effect ran.
      t.mock.timers.tick(projectSearchDelay);
    });
  try {
    await act(() =>
      root.render(
        createElement(ProjectChatSearch, {
          projectId: "project",
          chats: [conversation],
          onOpen: (chat) => opened.push(chat),
          onError: (error) => errors.push(error),
          children: "Recents",
        }),
      ),
    );
    await change("tra");
    await change("travel");
    assert.equal(calls.length, 0);
    assert.equal(
      document
        .querySelector('[aria-label="Clear search"]')!
        .getAttribute("tabindex"),
      "-1",
    );
    assert.match(document.querySelector("main")!.textContent!, /Recents/);
    await wait();
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].options, {
      projectId: "project",
      limit: 50,
      includeArchived: true,
    });
    await change("Kyoto");
    await wait();
    await act(async () => calls[0].resolve({ results: [hit] }));
    assert.equal(document.querySelector(".prj-search-results"), null);
    await act(async () => calls[1].resolve({ results: [hit] }));
    await act(() =>
      document
        .querySelector<HTMLButtonElement>(".prj-search-results button")!
        .click(),
    );
    assert.deepEqual(opened, [conversation]);
    const escape = new window.Event("keydown", {
      bubbles: true,
      cancelable: true,
    });
    Object.assign(escape, { key: "Escape" });
    await act(() => input().dispatchEvent(escape));
    assert.equal(input().value, "");
    assert.match(document.querySelector("main")!.textContent!, /Recents/);
    await change("none");
    await wait();
    await act(async () => calls[2].resolve({ results: [] }));
    assert.match(document.querySelector("main")!.textContent!, /No matches\./);
    await act(() =>
      document
        .querySelector<HTMLButtonElement>('[aria-label="Clear search"]')!
        .click(),
    );
    await change("error");
    await wait();
    await act(async () => calls[3].reject(new Error("search failed")));
    assert.equal(errors.length, 1);
    assert.equal(document.querySelector('[aria-busy="true"]'), null);
    assert.doesNotMatch(
      document.querySelector("main")!.textContent!,
      /No matches/,
    );
  } finally {
    await act(() => root.unmount());
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

test("web project search lives in the header, focuses, clears, and collapses without losing its children", async () => {
  const { window, document } = parseHTML(
    "<html><body><header></header><main></main></body></html>",
  );
  (document as unknown as { oninput: null }).oninput = null;
  const globals = { window, document, IS_REACT_ACT_ENVIRONMENT: true };
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
  const focus = Object.getOwnPropertyDescriptor(
    window.HTMLElement.prototype,
    "focus",
  );
  let focused: HTMLElement | undefined;
  window.HTMLElement.prototype.focus = function () {
    focused = this;
  };
  window.desktop = {
    searchConversations: async () => ({ results: [] }),
  } as unknown as typeof window.desktop;
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.querySelector("main")!);
  const header = document.querySelector("header")!;
  const render = (headerContainer: HTMLElement | null) =>
    root.render(
      createElement(ProjectChatSearch, {
        projectId: "project",
        chats: [],
        onOpen() {},
        onError(error) {
          throw error;
        },
        headerContainer,
        children: "Recents",
      }),
    );
  const input = () => header.querySelector<HTMLInputElement>("input")!;
  const key = async () => {
    const event = new window.Event("keydown", {
      bubbles: true,
      cancelable: true,
    });
    Object.assign(event, { key: "Escape" });
    await act(() => input().dispatchEvent(event));
  };
  try {
    await act(() => render(null));
    assert.equal(document.querySelector("input"), null);
    assert.equal(header.querySelector("button"), null);
    assert.equal(document.querySelector("main")!.textContent, "Recents");
    await act(() => render(header));
    const trigger = () => header.querySelector<HTMLButtonElement>("button")!;
    assert.equal(trigger().getAttribute("aria-label"), "Search this project");
    assert.equal(document.querySelector("main input"), null);
    await act(() => trigger().click());
    assert.equal(focused, input());
    assert.equal(input().type, "search");
    assert.equal(input().placeholder, "Search");
    assert.ok(header.querySelector('[aria-label="Clear search"]'));
    await act(() => {
      Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      )!.set!.call(input(), "query");
      input().dispatchEvent(new window.Event("input", { bubbles: true }));
    });
    await key();
    assert.equal(input().value, "");
    await key();
    assert.equal(header.querySelector("input"), null);
    assert.equal(focused, trigger());
    await act(() => trigger().click());
    await act(() =>
      header
        .querySelector<HTMLButtonElement>('[aria-label="Clear search"]')!
        .click(),
    );
    assert.equal(header.querySelector("input"), null);
    assert.equal(focused, trigger());
    assert.equal(document.querySelector("main")!.textContent, "Recents");
  } finally {
    await act(() => root.unmount());
    if (focus)
      Object.defineProperty(window.HTMLElement.prototype, "focus", focus);
    else Reflect.deleteProperty(window.HTMLElement.prototype, "focus");
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

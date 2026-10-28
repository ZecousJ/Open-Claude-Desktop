import test from "node:test";
import assert from "node:assert/strict";
import { act, createElement, useState } from "react";
import { createRoot } from "react-dom/client";
import { parseHTML } from "linkedom";
import type { Conversation, Mode } from "../../shared/types";
import type { SearchSources } from "../../src/collections/search/search-model";
import type { Routine } from "../../shared/routines";
import {
  filterPicker,
  filterSearchSources,
  paletteFilterOptions,
  removeLastPaletteFilter,
  type PaletteFilters,
} from "../../src/collections/search/search-filters";
import type { SearchEntrypoint } from "../../src/collections/search/palette-events";

(globalThis as { __CLAUDEX_SURFACE__?: string }).__CLAUDEX_SURFACE__ = "web";
const { SearchPalette } =
  await import("../../src/collections/search/SearchPalette");
const now = Date.now();
const conversation = (
  id: string,
  patch: Partial<Conversation> = {},
): Conversation => ({
  id,
  title: id,
  mode: "chat",
  providerId: "fixture",
  model: "fixture",
  pinned: false,
  archived: false,
  createdAt: now,
  updatedAt: now,
  turns: [],
  ...patch,
});
const sources: SearchSources = {
  conversations: [
    conversation("Own chat", { projectId: "p1" }),
    conversation("Legacy task", { mode: "cowork", projectId: "p1" }),
    conversation("Code record", {
      mode: "code",
      projectId: "p1",
      repository: {
        fullName: "Owner/Search",
        url: "https://github.com/Owner/Search",
      },
    }),
    conversation("Shared chat", {
      projectId: "p2",
      sessionAuthors: {
        viewerAccountUuid: "viewer",
        ownerAccountUuid: "owner",
      },
    }),
    conversation("Archived chat", { archived: true }),
    conversation("Private chat", { incognito: true }),
  ],
  projects: [
    {
      id: "p1",
      name: "Search",
      description: "",
      instructions: "",
      createdAt: now,
    },
  ],
  artifacts: [
    {
      id: "own",
      name: "Own artifact",
      content: "",
      language: "html",
      projectId: "p1",
      updatedAt: now,
    },
    {
      id: "shared",
      name: "Shared artifact",
      content: "",
      language: "html",
      sharedWithYou: true,
      updatedAt: now,
    },
  ],
  routines: [],
};

test("the published date aliases retain their date semantics and owner choices use the current copy", () => {
  for (const prefix of ["date", "when", "active"])
    assert.deepEqual(filterPicker(`${prefix}:today`), {
      key: "date",
      query: "today",
    });
  assert.deepEqual(filterPicker("from:"), { key: "owner", query: "" });
  assert.deepEqual(filterPicker("repository:Owner"), {
    key: "repo",
    query: "Owner",
  });
  assert.deepEqual(filterPicker("is:archived"), {
    key: "archived",
    query: "archived",
  });
  assert.equal(filterPicker("is:"), undefined);
  assert.equal(filterPicker("unknown:today"), undefined);
  assert.deepEqual(paletteFilterOptions({ key: "owner", query: "" }, sources), [
    { key: "owner", value: "mine", label: "Yours" },
    { key: "owner", value: "shared", label: "Shared with you" },
  ]);
  assert.deepEqual(
    paletteFilterOptions({ key: "owner", query: "me" }, sources).map(
      (option) => option.value,
    ),
    ["mine"],
  );
  assert.deepEqual(
    paletteFilterOptions({ key: "type", query: "chat" }, sources).map(
      (option) => option.value,
    ),
    ["chats"],
  );
  assert.deepEqual(
    paletteFilterOptions({ query: "when" }, sources).map(
      (option) => option.key,
    ),
    ["date"],
  );
});

test("Today includes the live one-hour floor near midnight; Repo comparison ignores case", () => {
  const midnight = new Date(2026, 9, 17).getTime();
  const nearMidnight = midnight + 15 * 60_000;
  const rows = {
    ...sources,
    conversations: [
      conversation("within-hour", { updatedAt: midnight - 30 * 60_000 }),
      conversation("outside-hour", { updatedAt: midnight - 46 * 60_000 }),
    ],
  };
  assert.deepEqual(
    filterSearchSources(
      rows,
      { date: { value: "today", label: "Today" } },
      nearMidnight,
    ).conversations.map((row) => row.id),
    ["within-hour"],
  );
  assert.deepEqual(
    filterSearchSources(
      sources,
      { repo: { value: "owner/search", label: "owner/search" } },
      now,
    ).conversations.map((row) => row.id),
    ["Code record"],
  );
});

test("ownership uses actual sessionAuthors and preserves the archived/incognito exclusions", () => {
  const shared = filterSearchSources(
    sources,
    { owner: { value: "shared", label: "Shared with you" } },
    now,
  );
  assert.deepEqual(
    shared.conversations.map((row) => row.id),
    ["Shared chat"],
  );
  assert.deepEqual(
    shared.artifacts.map((row) => row.id),
    ["shared"],
  );
  const mine = filterSearchSources(
    sources,
    { owner: { value: "mine", label: "Yours" } },
    now,
  );
  assert.deepEqual(
    mine.conversations.map((row) => row.id),
    ["Own chat", "Legacy task", "Code record"],
  );
  assert.deepEqual(
    mine.artifacts.map((row) => row.id),
    ["own"],
  );
  const filter: PaletteFilters = {
    owner: { value: "mine", label: "Yours" },
    type: { value: "chats", label: "Sessions" },
    date: { value: "today", label: "Today" },
    repo: { value: "Owner/Search", label: "Owner/Search" },
    project: { value: "p1", label: "Search" },
    archived: { value: "true", label: "Archived" },
  };
  let current = filter;
  for (const key of [
    "archived",
    "project",
    "repo",
    "date",
    "owner",
    "type",
  ] as const) {
    const next = removeLastPaletteFilter(current);
    assert.equal(next[key], undefined);
    assert.ok(current[key]);
    current = next;
  }
  assert.equal(removeLastPaletteFilter(current), current);
});

test("scheduled date filters follow the actual last run or creation, rather than an edit time", () => {
  const schedule = (id: string, patch: Partial<Routine> = {}): Routine => ({
    id,
    name: id,
    prompt: "Fixture",
    mode: "cowork",
    cwd: "",
    providerId: "fixture",
    model: "fixture",
    frequency: "daily",
    nextRunAt: now + 86400000,
    enabled: true,
    createdAt: now - 10 * 86400000,
    updatedAt: now - 10 * 86400000,
    ...patch,
  });
  const data = {
    ...sources,
    routines: [
      schedule("recent-run", { lastRunAt: now }),
      schedule("created-today", { createdAt: now }),
      schedule("only-edited-today", { updatedAt: now }),
    ],
  };
  assert.deepEqual(
    filterSearchSources(
      data,
      { date: { value: "today", label: "Today" } },
      now,
    ).routines.map((row) => row.id),
    ["recent-run", "created-today"],
  );
});

async function withPalette(
  check: (fixture: {
    document: Document;
    query(value: string): Promise<void>;
    key(key: string, extra?: Record<string, unknown>): Promise<void>;
    choose(prefix: string, label: string): Promise<void>;
    clear(label: string): Promise<void>;
    started: Mode[];
  }) => Promise<void>,
) {
  const { window, document } = parseHTML(
    "<html><body><main></main></body></html>",
  );
  Object.assign(window, {
    desktop: { searchConversations: async () => ({ results: [] }) },
  });
  let disposed = false;
  const observers: MutationObserver[] = [];
  class FixtureObserver extends window.MutationObserver {
    constructor(callback: MutationCallback) {
      super((records, observer) => {
        if (!disposed) callback(records, observer);
      });
      observers.push(this);
    }
  }
  const globals = {
    window,
    document,
    MutationObserver: FixtureObserver,
    Node: window.Node,
    NodeFilter: { SHOW_TEXT: 4, SHOW_ELEMENT: 1 },
    addEventListener: window.addEventListener.bind(window),
    removeEventListener: window.removeEventListener.bind(window),
    localStorage: { getItem: () => "search", setItem() {} },
    IS_REACT_ACT_ENVIRONMENT: true,
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
  const element = window.HTMLElement.prototype;
  const focus = Object.getOwnPropertyDescriptor(element, "focus");
  const scroll = Object.getOwnPropertyDescriptor(element, "scrollIntoView");
  let focused: Element = document.body;
  Object.defineProperty(document, "activeElement", {
    configurable: true,
    get: () => focused,
  });
  Object.defineProperty(element, "focus", {
    configurable: true,
    value(this: Element) {
      focused = this;
    },
  });
  Object.defineProperty(element, "scrollIntoView", {
    configurable: true,
    value() {},
  });
  const root = createRoot(document.querySelector("main")!);
  const started: Mode[] = [];
  let changeQuery: (value: string) => void = () => {};
  function Harness() {
    const [query, setQuery] = useState("");
    const [entrypoint, setEntrypoint] = useState<SearchEntrypoint>("default");
    changeQuery = setQuery;
    return createElement(SearchPalette, {
      sources,
      entrypoint,
      onEntrypointChange: setEntrypoint,
      query,
      onQueryChange: setQuery,
      loadRoutines: async () => [],
      onNew: (mode) => started.push(mode),
      onOpen() {},
      onCompose() {},
      onChooseFiles: async () => [],
      onRename() {},
      onArchive() {},
      onDelete() {},
      onClose() {},
    });
  }
  const query = async (value: string) => {
    await act(async () => changeQuery(value));
  };
  try {
    await act(async () => root.render(createElement(Harness)));
    await check({
      document,
      query,
      started,
      key: async (key, extra = {}) => {
        const event = new window.Event("keydown", {
          bubbles: true,
          cancelable: true,
        });
        Object.assign(event, { key, code: key, keyCode: 0, ...extra });
        await act(async () => {
          document.querySelector('[role="combobox"]')!.dispatchEvent(event);
        });
      },
      choose: async (prefix, label) => {
        await query(`${prefix}:`);
        const option = [
          ...document.querySelectorAll<HTMLElement>('[role="option"]'),
        ].find((row) => row.textContent === label);
        assert.ok(option, `${prefix} exposes ${label}`);
        await act(async () => option.click());
      },
      clear: async (label) => {
        const chip = [...document.querySelectorAll(".search-filter-chip")].find(
          (chip) => chip.textContent?.includes(label),
        );
        assert.ok(chip);
        await act(async () =>
          chip.querySelector<HTMLButtonElement>("button")!.click(),
        );
      },
    });
  } finally {
    const { setLocale } = await import("../../src/i18n");
    await act(async () => {
      await setLocale("en-US");
    });
    await act(async () => root.unmount());
    disposed = true;
    for (const observer of observers) observer.disconnect();
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (focus) Object.defineProperty(element, "focus", focus);
    else Reflect.deleteProperty(element, "focus");
    if (scroll) Object.defineProperty(element, "scrollIntoView", scroll);
    else Reflect.deleteProperty(element, "scrollIntoView");
    for (const [key, descriptor] of saved)
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
  }
}

const resultNames = (document: Document) =>
  [...document.querySelectorAll('[role="option"] .search-row-title')].map(
    (row) => row.textContent,
  );

test("real filter chips combine Date/Project/Type, clear in the live Backspace order and retain valid selection", async () => {
  await withPalette(async ({ document, choose, key, clear }) => {
    await choose("active", "Today");
    await choose("project", "Search");
    await choose("type", "Sessions");
    assert.equal(document.querySelectorAll(".search-filter-chip").length, 3);
    assert.equal(
      document.querySelector<HTMLInputElement>('[role="combobox"]')
        ?.placeholder,
      "Search",
    );
    assert.deepEqual(resultNames(document), ["Own chat", "Legacy task"]);
    await key("Backspace", { isComposing: true, keyCode: 229 });
    await key("Backspace", { repeat: true });
    assert.equal(document.querySelectorAll(".search-filter-chip").length, 3);
    await key("Backspace");
    assert.equal(document.querySelectorAll(".search-filter-chip").length, 2);
    assert.ok(
      ![...document.querySelectorAll(".search-filter-chip")].some((chip) =>
        chip.textContent?.includes("Project"),
      ),
    );
    await clear("Today");
    assert.equal(
      document.activeElement,
      document.querySelector('[role="combobox"]'),
    );
    const active = document
      .querySelector('[role="combobox"]')!
      .getAttribute("aria-activedescendant");
    assert.ok(active && document.getElementById(active));
    await key("Backspace");
    assert.equal(document.querySelectorAll(".search-filter-chip").length, 0);
  });
});

test("real Owner/Repo/Archived filters use stored data, and Actions can be entered and left by keyboard", async () => {
  await withPalette(async ({ document, choose, key, clear, started }) => {
    await choose("from", "Shared with you");
    assert.deepEqual(resultNames(document), ["Shared chat", "Shared artifact"]);
    await clear("Shared with you");
    await choose("repository", "Owner/Search");
    assert.deepEqual(resultNames(document), ["Code record"]);
    await clear("Owner/Search");
    await choose("archived", "Archived");
    assert.deepEqual(resultNames(document), ["Archived chat"]);
    await key("Backspace");
    await choose("actions", "Actions");
    assert.equal(
      document.querySelector<HTMLInputElement>('[role="combobox"]')
        ?.placeholder,
      "Search actions",
    );
    await key("Enter");
    assert.deepEqual(started, ["chat"]);
    await key("Backspace");
    assert.notEqual(
      document.querySelector<HTMLInputElement>('[role="combobox"]')
        ?.placeholder,
      "Search actions",
    );
  });
});

test("project filter user data remains literal in chip text and its effective accessible name after translation", async () => {
  await withPalette(async ({ document, choose }) => {
    await choose("project", "Search");
    const { setLocale } = await import("../../src/i18n");
    const { startDomTranslation } = await import("../../src/i18n/dom");
    await act(async () => {
      await setLocale("zh-CN");
      startDomTranslation();
    });
    const chip = document.querySelector(".search-filter-chip")!;
    const labelId = chip.getAttribute("aria-labelledby");
    assert.ok(labelId && document.getElementById(labelId));
    const label = document.getElementById(labelId)!.textContent ?? "";
    assert.match(label, /Search/);
    assert.doesNotMatch(label, /搜索/);
    assert.equal(
      chip.querySelector("span:not([hidden]) > span[data-no-translate]")
        ?.textContent ?? chip.children[1].textContent,
      "Search",
    );
    assert.equal(
      chip.querySelector("button")?.getAttribute("aria-label"),
      "清除筛选条件",
    );
  });
});

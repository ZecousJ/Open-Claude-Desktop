import test from "node:test";
import assert from "node:assert/strict";
import { act, createElement, useLayoutEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { parseHTML } from "linkedom";
import type { Conversation, Mode } from "../../shared/types";
import type { SearchSources } from "../../src/collections/search/search-model";
import {
  searchViewEvent,
  type SearchEntrypoint,
} from "../../src/collections/search/palette-events";

(globalThis as { __CLAUDEX_SURFACE__?: string }).__CLAUDEX_SURFACE__ = "web";
const { SearchPalette } =
  await import("../../src/collections/search/SearchPalette");

const conversation = (id: string, updatedAt: number): Conversation => ({
  id,
  title: id,
  mode: "chat",
  providerId: "fixture",
  model: "fixture",
  createdAt: updatedAt,
  updatedAt,
  archived: false,
  pinned: false,
  turns: [],
});
const sources: SearchSources = {
  conversations: Array.from({ length: 12 }, (_, i) =>
    conversation(`Record ${i}`, 100 - i),
  ),
  projects: [],
  artifacts: [],
  routines: [],
};

async function withPalette(
  options: {
    remembered: "search" | "compose";
    entrypoint: SearchEntrypoint;
    lostSearchEvent?: boolean;
  },
  check: (fixture: {
    document: Document;
    key: (key: string) => Promise<void>;
    click: (selector: string) => Promise<void>;
    changeEntrypoint: (entrypoint: SearchEntrypoint) => Promise<void>;
    changeSources: (sources: SearchSources) => Promise<void>;
    commits: {
      entrypoint: SearchEntrypoint;
      activeId: string | null;
      exists: boolean;
    }[];
    started: Mode[];
  }) => Promise<void>,
) {
  const { window, document } = parseHTML(
    '<html data-motion="reduced"><body><main></main></body></html>',
  );
  const storage = new Map<string, string>([["cmdk-mode", options.remembered]]);
  const globals = {
    window,
    document,
    addEventListener: window.addEventListener.bind(window),
    removeEventListener: window.removeEventListener.bind(window),
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    },
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
  const originalFocus = Object.getOwnPropertyDescriptor(element, "focus");
  const originalScroll = Object.getOwnPropertyDescriptor(
    element,
    "scrollIntoView",
  );
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
  const commits: {
    entrypoint: SearchEntrypoint;
    activeId: string | null;
    exists: boolean;
  }[] = [];
  let setEntrypoint: (entrypoint: SearchEntrypoint) => void = () => {};
  let setSources: (sources: SearchSources) => void = () => {};
  function Harness() {
    const [entrypoint, changeEntrypoint] = useState(options.entrypoint);
    const [data, changeSources] = useState(sources);
    const [query, changeQuery] = useState("");
    setEntrypoint = changeEntrypoint;
    setSources = changeSources;
    // Inspect each parent commit before passive effects can repair a stale
    // selection. ARIA must reference a real option on the first render too.
    useLayoutEffect(() => {
      const input = document.querySelector('[role="combobox"]');
      if (!input) return;
      const activeId = input.getAttribute("aria-activedescendant");
      commits.push({
        entrypoint,
        activeId,
        exists: activeId === null || !!document.getElementById(activeId),
      });
    });
    return createElement(SearchPalette, {
      sources: data,
      entrypoint,
      query,
      onQueryChange: changeQuery,
      onEntrypointChange: changeEntrypoint,
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
  const key = async (key: string) => {
    const input = document.querySelector('[role="combobox"]')!;
    const event = new window.Event("keydown", {
      bubbles: true,
      cancelable: true,
    });
    Object.assign(event, {
      key,
      code: key,
      keyCode: key === "Enter" ? 13 : key === "ArrowDown" ? 40 : 0,
    });
    await act(async () => {
      input.dispatchEvent(event);
    });
  };
  try {
    // App dispatches this before a first lazy mount; no listener exists yet.
    if (options.lostSearchEvent)
      window.dispatchEvent(new window.Event(searchViewEvent));
    await act(async () => root.render(createElement(Harness)));
    await check({
      document,
      key,
      started,
      commits,
      click: async (selector) => {
        await act(async () => {
          document.querySelector<HTMLElement>(selector)!.click();
        });
      },
      changeEntrypoint: async (entrypoint) => {
        await act(async () => setEntrypoint(entrypoint));
      },
      changeSources: async (value) => {
        await act(async () => setSources(value));
      },
    });
  } finally {
    await act(async () => root.unmount());
    if (originalFocus) Object.defineProperty(element, "focus", originalFocus);
    else Reflect.deleteProperty(element, "focus");
    if (originalScroll)
      Object.defineProperty(element, "scrollIntoView", originalScroll);
    else Reflect.deleteProperty(element, "scrollIntoView");
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}

test("first dedicated Search mount ignores remembered Compose even when its event was lost", async () => {
  await withPalette(
    { remembered: "compose", entrypoint: "search", lostSearchEvent: true },
    async ({ document }) => {
      assert.ok(document.querySelector('input[role="combobox"]'));
      assert.equal(document.querySelector(".search-palette.compose"), null);
      assert.equal(document.querySelector("textarea"), null);
    },
  );
});

test("default palette still restores the remembered Compose view", async () => {
  await withPalette(
    { remembered: "compose", entrypoint: "default" },
    async ({ document }) => {
      assert.ok(document.querySelector(".search-palette.compose textarea"));
      assert.equal(document.querySelector('input[role="combobox"]'), null);
    },
  );
});

test("clicking Actions resets selection, returns input focus and lets Enter start its real action", async () => {
  await withPalette(
    { remembered: "search", entrypoint: "default" },
    async ({ document, key, click, started, commits }) => {
      for (let i = 0; i < 7; i++) await key("ArrowDown");
      assert.equal(
        document
          .querySelector('[role="combobox"]')
          ?.getAttribute("aria-activedescendant"),
        "search-row-7",
      );
      await click('[role="group"][aria-label="Actions"] h3 > button');
      const input = document.querySelector('[role="combobox"]')!;
      assert.equal(document.activeElement, input);
      assert.equal(input.getAttribute("aria-activedescendant"), "search-row-0");
      assert.equal(document.querySelectorAll('[role="option"]').length, 2);
      assert.match(
        document.getElementById("search-row-1")?.textContent ?? "",
        /New Code session/,
      );
      assert.equal(
        document.getElementById("search-row-0")?.getAttribute("aria-selected"),
        "true",
      );
      assert.ok(
        commits
          .filter((commit) => commit.entrypoint === "actions")
          .every((commit) => commit.exists),
      );
      await key("Enter");
      assert.deepEqual(started, ["chat"]);
    },
  );
});

test("an externally changed Actions entrypoint has a valid active descendant before effects", async () => {
  await withPalette(
    { remembered: "search", entrypoint: "default" },
    async ({ document, key, changeEntrypoint, commits, started }) => {
      for (let i = 0; i < 7; i++) await key("ArrowDown");
      await changeEntrypoint("actions");
      assert.ok(
        commits
          .filter((commit) => commit.entrypoint === "actions")
          .every((commit) => commit.exists),
      );
      const id = document
        .querySelector('[role="combobox"]')
        ?.getAttribute("aria-activedescendant");
      assert.equal(id, "search-row-0");
      assert.ok(document.getElementById(id!));
      await key("Enter");
      assert.deepEqual(started, ["chat"]);
    },
  );
});

test("shrinking asynchronous sources clamps selection and does not resurrect its old index", async () => {
  await withPalette(
    { remembered: "search", entrypoint: "default" },
    async ({ document, key, changeSources, commits }) => {
      for (let i = 0; i < 7; i++) await key("ArrowDown");
      await changeSources({
        ...sources,
        conversations: sources.conversations.slice(0, 1),
      });
      assert.equal(
        document
          .querySelector('[role="combobox"]')
          ?.getAttribute("aria-activedescendant"),
        "search-row-1",
      );
      assert.ok(commits.every((commit) => commit.exists));
      await changeSources(sources);
      assert.equal(
        document
          .querySelector('[role="combobox"]')
          ?.getAttribute("aria-activedescendant"),
        "search-row-1",
      );
    },
  );
});

test("actual active search rows keep status in read-screen text and name their menu Actions", async () => {
  await withPalette(
    { remembered: "search", entrypoint: "default" },
    async ({ document, changeSources }) => {
      const busy = conversation("Working", 1000);
      busy.turns = [
        {
          id: "running",
          prompt: "Synthetic fixture",
          attachments: [],
          items: [],
          status: "inProgress",
          createdAt: 1,
        },
      ];
      await changeSources({ ...sources, conversations: [busy] });
      const row = document.querySelector(".search-row")!;
      assert.equal(
        row.querySelector(".sr-only")?.textContent?.trim(),
        "Running",
      );
      assert.ok(row.querySelector(".search-source-state.running"));
      assert.equal(
        row.querySelector(".search-row-more")?.getAttribute("aria-label"),
        "Actions",
      );
    },
  );
});

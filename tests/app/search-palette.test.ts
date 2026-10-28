import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { SearchPalette } from "../../src/collections/search/SearchPalette";
import {
  palettePlaceholder,
  paletteResultMessage,
} from "../../src/collections/search/search-model";
import assert from "node:assert/strict";
import type { Conversation, Project } from "../../shared/types";
import type { Routine } from "../../shared/routines";
import {
  paletteKey,
  searchSections,
  markTerms,
  relativeBucket,
  type SearchRow,
} from "../../src/collections/search/search-model";

const conversation = (
  id: string,
  mode: Conversation["mode"],
  updatedAt: number,
  title: string,
  reply = "",
): Conversation => ({
  id,
  title,
  mode,
  providerId: "p",
  model: "m",
  pinned: false,
  archived: false,
  createdAt: updatedAt,
  updatedAt,
  turns: [
    {
      id: `${id}-t`,
      prompt: `prompt for ${title}`,
      attachments: [],
      items: [{ id: `${id}-i`, type: "agentMessage", text: reply }],
      status: "completed",
      createdAt: updatedAt,
    },
  ],
});
const sources = {
  conversations: [
    conversation("a", "chat", 1, "Trip ideas"),
    conversation("b", "code", 4, "Fix login", "The session token expires"),
    conversation("c", "cowork", 3, "Quarterly report"),
    conversation("d", "chat", 2, "Recipe"),
  ],
  projects: [
    {
      id: "p1",
      name: "Website",
      description: "Marketing site",
      instructions: "",
      createdAt: 0,
    } satisfies Project,
  ],
  routines: [
    {
      id: "r1",
      name: "daily-code-review",
      description: "Review commits",
      prompt: "Look at the commits",
    } as Routine,
  ],
  artifacts: [{ id: "x", name: "Token chart", language: "html", content: "" }],
};
const titles = (rows: SearchRow[]) => rows.map((row) => row.title);

test("palette renders contextual accessible copy and announces results without a visible count", () => {
  const render = (entrypoint: "search" | "actions", query: string) =>
    renderToStaticMarkup(
      createElement(SearchPalette, {
        sources,
        entrypoint,
        query,
        loadRoutines: async () => [],
        onQueryChange() {},
        onOpen() {},
        onNew() {},
        onCompose() {},
        onChooseFiles: async () => [],
        onRename() {},
        onArchive() {},
        onDelete() {},
        onClose() {},
      }),
    );
  const search = render("search", "");
  assert.match(search, /placeholder="Search chats and projects"/);
  assert.match(search, /role="group" aria-label="Filters"/);
  assert.match(search, /role="tablist" aria-label="Type"/);
  assert.match(
    search,
    /class="sr-only" aria-live="polite" aria-atomic="true">6 results available/,
  );
  const actions = render("actions", "no match");
  assert.match(actions, /placeholder="Search actions"/);
  assert.match(actions, /aria-label="Clear filter"/);
  assert.match(actions, /No results found/);
  assert.doesNotMatch(actions, /Nothing here yet|No results for/);
});

test("input copy follows the entrypoint, Code context and selected filter", () => {
  assert.equal(
    palettePlaceholder("search", "code", false),
    "Search sessions and projects",
  );
  assert.equal(
    palettePlaceholder("search", "chat", true),
    "Search chats and projects",
  );
  assert.equal(palettePlaceholder("actions", "code", true), "Search actions");
  assert.equal(palettePlaceholder("default", "chat", true), "Search");
  // The unfiltered palette says Search in Chat and Code.
  assert.equal(palettePlaceholder("default", "code", false), "Search");
  assert.equal(palettePlaceholder("default", "cowork", false), "Search");
});

test("search footer matches the available keyboard actions and keeps Compose last", () => {
  const render = (query: string) =>
    parseHTML(
      renderToStaticMarkup(
        createElement(SearchPalette, {
          sources,
          query,
          loadRoutines: async () => [],
          onQueryChange() {},
          onOpen() {},
          onNew() {},
          onCompose() {},
          onChooseFiles: async () => [],
          onRename() {},
          onArchive() {},
          onDelete() {},
          onClose() {},
        }),
      ),
    ).document.querySelector("footer")!;
  const empty = render("");
  assert.match(empty.firstElementChild?.textContent ?? "", /^Close/);
  assert.ok(empty.querySelector(".search-type-hint"));
  assert.equal(
    empty.querySelector(".search-type-hint")?.querySelectorAll("kbd").length,
    2,
  );
  assert.equal(empty.lastElementChild?.className, "search-compose-hint");
  assert.match(empty.textContent ?? "", /Actions\s*⌥/);

  const query = render("Trip");
  assert.equal(query.querySelector(".search-type-hint"), null);
  assert.match(query.textContent ?? "", /Actions\s*⌥/);
  const noResult = render("no matching records");
  assert.doesNotMatch(noResult.textContent ?? "", /Actions/);
});

test("the Actions group heading reads plain Actions, without a caret", () => {
  const document = parseHTML(
    renderToStaticMarkup(
      createElement(SearchPalette, {
        sources,
        query: "",
        loadRoutines: async () => [],
        onQueryChange() {},
        onOpen() {},
        onNew() {},
        onCompose() {},
        onChooseFiles: async () => [],
        onRename() {},
        onArchive() {},
        onDelete() {},
        onClose() {},
      }),
    ),
  ).document;
  const button = document.querySelector(
    '[role="group"][aria-label="Actions"] h3 > button',
  )!;
  assert.equal(button.textContent?.replace(/\p{Co}/gu, ""), "Actions");
  assert.equal(button.querySelector('[data-icon="CaretRight"]'), null);
});

test("result announcements use plain placeholders, never ICU plurals", () => {
  assert.equal(paletteResultMessage(0), "No results found");
  assert.equal(paletteResultMessage(1), "1 result available");
  assert.equal(paletteResultMessage(3), "{count} results available");
});

test("deeper search finds stored turns without requiring loaded messages; Code searches titles", () => {
  const unloaded = {
    ...sources,
    conversations: [conversation("stored", "chat", 1, "Notes")],
  };
  const hits = [
    {
      conversationId: "stored",
      title: "Notes",
      mode: "chat" as const,
      archived: false,
      updatedAt: 1,
      snippet: "buried text",
    },
  ];
  assert.equal(searchSections(unloaded, "buried", "all").length, 0);
  const rows = searchSections(unloaded, "buried", "all", hits)[0].rows;
  assert.equal(
    rows[0].kind === "conversation" && rows[0].snippet,
    "buried text",
  );
  assert.deepEqual(searchSections(unloaded, "buried", "all", hits, true), []);
  assert.equal(
    searchSections(unloaded, "notes", "all", undefined, true)[0].rows.length,
    1,
  );
});

test("an empty palette mixes known recent sources and the unified new-session action", () => {
  const sections = searchSections(sources, "", "all");
  assert.deepEqual(
    sections.map((s) => [s.title, titles(s.rows)]),
    [
      [
        "Recents",
        [
          "Fix login",
          "Quarterly report",
          "Recipe",
          "Trip ideas",
          "Website",
          "daily-code-review",
          "Token chart",
        ],
      ],
      ["Actions", ["New session"]],
    ],
  );
});

test("a query searches replies, projects, routines and artifacts, each in its section", () => {
  assert.deepEqual(
    searchSections(sources, "token", "all").map((s) => [
      s.title,
      titles(s.rows),
    ]),
    [
      ["Code", ["Fix login"]],
      ["Artifacts", ["Token chart"]],
    ],
  );
  assert.deepEqual(
    searchSections(sources, "marketing", "all").map((s) => s.title),
    ["Projects"],
  );
  assert.deepEqual(
    titles(searchSections(sources, "commits", "routines")[0].rows),
    ["daily-code-review"],
  );
  const commandRows = searchSections(sources, "new ses", "all").flatMap(
    (section) => section.rows,
  );
  assert.equal(commandRows[0].kind, "action");
  assert.equal(commandRows[0].key, "new-session");
  assert.deepEqual(titles(commandRows.filter((row) => row.kind === "action")), [
    "New session",
  ]);
  // A filter lists its own kind, newest first, even without a query.
  assert.deepEqual(titles(searchSections(sources, "", "chats")[0].rows), [
    "Quarterly report",
    "Recipe",
    "Trip ideas",
  ]);
  assert.deepEqual(searchSections(sources, "zzz", "all"), []);
});

test("keys move through the rows, open one, switch modes, step filters and open actions", () => {
  const rows = searchSections(sources, "", "all").flatMap((s) => s.rows);
  const state = { active: 0, rows, filter: "all" as const };
  const key = (
    k: string,
    extra: Partial<{ shift: boolean; query: string; caretAtEnd: boolean }> = {},
  ) => paletteKey({ key: k, query: "", caretAtEnd: true, ...extra }, state);
  assert.deepEqual(key("ArrowDown"), { type: "move", to: 1 });
  assert.deepEqual(key("ArrowUp"), { type: "move", to: rows.length - 1 });
  assert.deepEqual(
    paletteKey(
      { key: "ArrowDown", query: "", caretAtEnd: true },
      { ...state, active: rows.length - 1 },
    ),
    { type: "move", to: 0 },
  );
  assert.deepEqual(key("Enter"), { type: "activate" });
  assert.deepEqual(key("Tab"), { type: "compose" });
  assert.equal(key("Tab", { shift: true }), undefined);
  assert.deepEqual(key("/"), { type: "filter-menu" });
  assert.equal(
    key("/", { query: "a/b" }),
    undefined,
    "a slash in a query is typed",
  );
  assert.deepEqual(
    paletteKey(
      { key: "/", query: "", caretAtEnd: true },
      { ...state, filter: "routines" },
    ),
    { type: "filter-menu" },
  );
  assert.deepEqual(key("ArrowRight"), { type: "filter", to: "artifacts" });
  assert.equal(key("ArrowRight", { query: "x", caretAtEnd: false }), undefined);
  assert.deepEqual(
    paletteKey(
      { key: "ArrowRight", query: "", caretAtEnd: true },
      { ...state, active: rows.length - 1 },
    ),
    { type: "filter", to: "artifacts" },
    "type navigation does not depend on the active result kind",
  );
  assert.equal(key("a"), undefined);
  assert.equal(
    paletteKey(
      { key: "Enter", query: "zzz", caretAtEnd: true },
      { active: 0, rows: [], filter: "all" },
    ),
    undefined,
  );
});

test("conversations match any word, rank by words found and quote the reply (R-1161)", () => {
  const [sessions, chats] = searchSections(
    {
      ...sources,
      conversations: [
        conversation("e", "chat", 5, "Sidebar reference test"),
        conversation(
          "f",
          "chat",
          6,
          "Parallel workflow",
          "a reference test in a note",
        ),
      ],
    },
    "sidebar reference test",
    "all",
  );
  void chats;
  const rows = sessions.rows as Extract<SearchRow, { kind: "conversation" }>[];
  assert.deepEqual(titles(rows), [
    "Sidebar reference test",
    "Parallel workflow",
  ]);
  assert.deepEqual(rows[0].terms, ["sidebar", "reference", "test"]);
  assert.equal(rows[0].snippet, undefined);
  assert.equal(rows[1].snippet, "a reference test in a note");
  assert.deepEqual(markTerms("Sidebar test", ["test", "sidebar"]), [
    { text: "Sidebar", match: true },
    { text: " ", match: false },
    { text: "test", match: true },
  ]);
  const now = new Date(2026, 8, 28, 12).getTime();
  assert.equal(relativeBucket(now - 3_600_000, now), "Today");
  assert.equal(relativeBucket(now - 86_400_000, now), "Yesterday");
  assert.equal(relativeBucket(now - 5 * 86_400_000, now), "Past week");
  assert.equal(relativeBucket(now - 200 * 86_400_000, now), "Past year");
});

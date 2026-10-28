import test from "node:test";
import assert from "node:assert/strict";
import type { Conversation } from "../../shared/types";
import type { Routine } from "../../shared/routines";
import {
  fitPaletteSections,
  paletteSectionsHeight,
  searchRowTime,
  searchSections,
  type SearchRow,
  type SearchSources,
} from "../../src/collections/search/search-model";

const conversation = (
  id: string,
  updatedAt: number,
  mode: Conversation["mode"] = "chat",
  running = false,
): Conversation => ({
  id,
  title: id,
  updatedAt,
  createdAt: updatedAt,
  mode,
  providerId: "p",
  model: "m",
  pinned: false,
  archived: false,
  turns: running
    ? [
        {
          id: `turn:${id}`,
          prompt: "",
          items: [],
          attachments: [],
          status: "inProgress",
          createdAt: updatedAt,
        },
      ]
    : [],
});
const empty: SearchSources = {
  conversations: [],
  projects: [],
  artifacts: [],
  routines: [],
};
const recent = (sources: SearchSources) => searchSections(sources, "", "all");

test("default Recents combines real Chat, Code, scheduled, artifact and project timestamps", () => {
  const sections = recent({
    conversations: [
      conversation("chat", 30),
      conversation("code", 50, "code"),
      conversation("legacy", 20, "cowork"),
    ],
    projects: [
      {
        id: "project",
        name: "project",
        description: "",
        instructions: "",
        createdAt: 5,
      },
    ],
    artifacts: [
      {
        id: "artifact",
        name: "artifact",
        content: "",
        language: "html",
        updatedAt: 40,
      },
    ],
    routines: [
      {
        id: "scheduled",
        name: "scheduled",
        createdAt: 1,
        lastRunAt: 25,
        updatedAt: 100,
      } as Routine,
    ],
  });
  assert.deepEqual(
    sections[0].rows.map((row) => [row.kind, row.title]),
    [
      ["conversation", "code"],
      ["artifact", "artifact"],
      ["conversation", "chat"],
      ["routine", "scheduled"],
      ["conversation", "legacy"],
      ["project", "project"],
    ],
  );
  assert.equal(sections[1].title, "Actions");
});

test("440px empty-view budget fits eight recent rows plus one action without an Active heading", () => {
  const sections = recent({
    ...empty,
    conversations: Array.from({ length: 20 }, (_, i) =>
      conversation(`chat${i}`, 20 - i),
    ),
  });
  assert.deepEqual(
    sections.map((section) => [section.title, section.rows.length]),
    [
      ["Recents", 8],
      ["Actions", 1],
    ],
  );
  assert.equal(paletteSectionsHeight(sections), 422);
  assert.equal(
    paletteSectionsHeight([
      { title: "Recents", rows: sections[0].rows.concat(sections[0].rows[0]) },
      sections[1],
    ]),
    458,
  );
});

test("Active adds a real group and reduces Recents, with no duplicate records", () => {
  const sections = recent({
    ...empty,
    conversations: [
      conversation("running", 100, "code", true),
      ...Array.from({ length: 20 }, (_, i) => conversation(`chat${i}`, 20 - i)),
    ],
  });
  assert.deepEqual(
    sections.map((section) => [section.title, section.rows.length]),
    [
      ["Active", 1],
      ["Recents", 6],
      ["Actions", 1],
    ],
  );
  const keys = sections.flatMap((section) =>
    section.rows.map((row) => row.key),
  );
  assert.equal(keys.length, new Set(keys).size);
  assert.equal(paletteSectionsHeight(sections), 427);
});

test("at most five active leads share the budget with the remaining recent records", () => {
  const sections = recent({
    ...empty,
    conversations: Array.from({ length: 20 }, (_, i) =>
      conversation(`running${i}`, 20 - i, "code", true),
    ),
  });
  assert.deepEqual(
    sections.map((section) => [section.title, section.rows.length]),
    [
      ["Active", 5],
      ["Recents", 2],
      ["Actions", 1],
    ],
  );
  assert.ok(paletteSectionsHeight(sections) <= 440);
});

test("empty-view fitting trims Actions first and preserves its final row", () => {
  const row: SearchRow = {
    kind: "action",
    key: "a",
    title: "New session",
    mode: "chat",
    group: "chat",
    command: { type: "new-session", mode: "chat" },
  };
  const fitted = fitPaletteSections([
    { title: "Recents", rows: Array.from({ length: 8 }, () => row) },
    { title: "Actions", rows: [row, row, row] },
  ]);
  assert.deepEqual(
    fitted.map((section) => section.rows.length),
    [8, 1],
  );
});

test("dedicated Search entrypoint shows up to 25 rows without default Active or Actions", () => {
  const sections = searchSections(
    {
      ...empty,
      conversations: Array.from({ length: 30 }, (_, i) =>
        conversation(`chat${i}`, 30 - i),
      ),
    },
    "",
    "all",
    undefined,
    false,
    "chat",
    false,
    "search",
  );
  assert.deepEqual(
    sections.map((section) => [section.title, section.rows.length]),
    [["", 25]],
  );
});

test("missing timestamps never become invented recency, and scheduled editing is not a run", () => {
  const artifact: SearchRow = {
    kind: "artifact",
    key: "a",
    title: "old",
    artifact: { id: "a", name: "old", content: "", language: "html" },
  };
  assert.equal(searchRowTime(artifact), undefined);
  const routine = {
    id: "r",
    name: "r",
    createdAt: 10,
    updatedAt: 200,
  } as Routine;
  assert.equal(
    searchRowTime({ kind: "routine", key: "r", title: "r", routine }),
    10,
  );
  assert.equal(
    searchRowTime({
      kind: "artifact",
      key: "a",
      title: "a",
      artifact: { ...artifact.artifact, updatedAt: Number.NaN },
    }),
    undefined,
  );
  const sections = recent({
    ...empty,
    artifacts: [artifact.artifact],
    conversations: [conversation("dated", 1)],
  });
  assert.deepEqual(
    sections[0].rows.map((row) => row.title),
    ["dated", "old"],
  );
});

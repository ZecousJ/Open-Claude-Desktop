import test from "node:test";
import assert from "node:assert/strict";
import type { Conversation } from "../../shared/types";
import type { SearchSources } from "../../src/collections/search/search-model";
import {
  filterPicker,
  filterSearchSources,
  paletteFilterOptions,
  paletteType,
} from "../../src/collections/search/search-filters";

const now = new Date(2026, 9, 16, 12).getTime();
const conversation = (
  id: string,
  extra: Partial<Conversation> = {},
): Conversation => ({
  id,
  title: id,
  mode: "chat",
  providerId: "p",
  model: "m",
  pinned: false,
  archived: false,
  createdAt: now,
  updatedAt: now,
  turns: [],
  ...extra,
});
const sources: SearchSources = {
  conversations: [
    conversation("chat", { projectId: "p1" }),
    conversation("legacy", { mode: "cowork", projectId: "p1" }),
    conversation("code", {
      mode: "code",
      repository: { fullName: "owner/repo" } as Conversation["repository"],
    }),
    conversation("old", { updatedAt: now - 9 * 86400000 }),
    conversation("archived", { archived: true }),
    conversation("private", { incognito: true }),
  ],
  projects: [
    {
      id: "p1",
      name: "Notes",
      description: "",
      instructions: "",
      createdAt: now,
    },
  ],
  artifacts: [
    {
      id: "own",
      name: "Own",
      content: "",
      language: "html",
      projectId: "p1",
      updatedAt: now,
    },
    {
      id: "shared",
      name: "Shared",
      content: "",
      language: "html",
      sharedWithYou: true,
      updatedAt: now,
    },
  ],
  routines: [],
};

test("slash filters offer the live keys, with real project/repository choices", () => {
  assert.deepEqual(
    paletteFilterOptions(filterPicker("/")!, sources).map((row) => row.key),
    ["owner", "date", "repo", "project", "type", "archived", "actions"],
  );
  assert.equal(filterPicker("ordinary / text"), undefined);
  assert.deepEqual(
    paletteFilterOptions(filterPicker("repo:owner")!, sources).map(
      (row) => row.value,
    ),
    ["owner/repo"],
  );
  assert.deepEqual(
    paletteFilterOptions(filterPicker("project:notes")!, sources).map(
      (row) => row.value,
    ),
    ["p1"],
  );
  assert.equal(
    paletteType({ type: { value: "chats", label: "Sessions" } }, "all"),
    "chats",
  );
});

test("filters compose across legacy and current records and keep incognito out", () => {
  const filters = {
    project: { value: "p1", label: "Notes" },
    date: { value: "today", label: "Today" },
  };
  const result = filterSearchSources(sources, filters, now);
  assert.deepEqual(
    result.conversations.map((row) => row.id),
    ["chat", "legacy"],
  );
  assert.deepEqual(
    result.artifacts.map((row) => row.id),
    ["own"],
  );
  assert.deepEqual(
    result.projects.map((row) => row.id),
    ["p1"],
  );
  const repo = filterSearchSources(
    sources,
    { repo: { value: "owner/repo", label: "owner/repo" } },
    now,
  );
  assert.deepEqual(
    repo.conversations.map((row) => row.id),
    ["code"],
  );
  assert.equal(repo.projects.length + repo.artifacts.length, 0);
});

test("ownership and archive filters reflect stored metadata", () => {
  const shared = filterSearchSources(
    sources,
    { owner: { value: "shared", label: "Shared with me" } },
    now,
  );
  assert.deepEqual(
    shared.artifacts.map((row) => row.id),
    ["shared"],
  );
  assert.equal(shared.conversations.length, 0);
  const archived = filterSearchSources(
    sources,
    { archived: { value: "true", label: "Archived" } },
    now,
  );
  assert.deepEqual(
    archived.conversations.map((row) => row.id),
    ["archived"],
  );
  assert.ok(
    !filterSearchSources(sources, {}, now).conversations.some(
      (row) => row.id === "private" || row.id === "archived",
    ),
  );
});

import test from "node:test";
import assert from "node:assert/strict";
import type { Conversation, Project } from "../../shared/types";
import {
  nativePlaceRows,
  nativeLocalHistory,
  knownLocalFolder,
} from "../../src/composer/native-place-model";
import { recentWorkFolders } from "../../src/composer/recentFolders";
import { coworkPlaceUsage } from "../../src/composer/cowork-options-model";
import {
  nativeDefaultFolder,
  setNativeDefaultFolder,
} from "../../src/composer/native-place-preferences";
import {
  defaultProjectId,
  setDefaultProjectId,
} from "../../src/composer/project-picker-preferences";

const c = (id: string, extra: Partial<Conversation> = {}) =>
  ({
    id,
    mode: "chat",
    cwd: `/tmp/${id}`,
    updatedAt: 10,
    archived: false,
    incognito: false,
    ...extra,
  }) as Conversation;
const p = (id: string, extra: Partial<Project> = {}) =>
  ({
    id,
    name: id,
    instructions: "",
    description: "",
    createdAt: 1,
    ...extra,
  }) as Project;

test("native folder history includes Chat, excludes cloud/SSH/remote/incognito/archived and uses no this-machine shortcut", () => {
  const rows = [
    c("chat"),
    c("code", { mode: "code" }),
    c("cowork", { mode: "cowork" }),
    c("ssh", { environment: { kind: "ssh", hostId: "x" } }),
    c("cloud", { environment: { kind: "space", spaceId: "x" } }),
    c("incognito", { incognito: true }),
    c("archived", { archived: true }),
    c("linked", { linkedToComputer: true }),
  ];
  assert.deepEqual(
    nativeLocalHistory(rows).map((row) => row.id),
    ["chat", "code", "cowork"],
  );
  assert.deepEqual(recentWorkFolders(rows, Infinity, true), [
    "/tmp/chat",
    "/tmp/code",
    "/tmp/cowork",
  ]);
  for (const id of ["ssh", "cloud", "incognito", "archived", "linked"])
    assert.equal(knownLocalFolder(`/tmp/${id}`, rows), false);
  assert.equal(knownLocalFolder("/tmp/chat", rows), true);
  assert.equal(
    knownLocalFolder("relative", [c("relative", { cwd: "relative" })]),
    false,
  );
  assert.equal(coworkPlaceUsage(rows, true).get("/tmp/chat"), 10);
  assert.equal(
    coworkPlaceUsage(rows).get("/tmp/chat"),
    undefined,
    "legacy non-native callers keep their prior scope",
  );
});
test("native default preference is account isolated, rejects unknown/remote history, and is exclusive with project default", () => {
  const history = [c("default-native")];
  assert.equal(
    setNativeDefaultFolder("native-pref-a", "/tmp/missing", history),
    false,
  );
  assert.equal(
    setNativeDefaultFolder("native-pref-a", "/tmp/default-native", history),
    true,
  );
  assert.equal(nativeDefaultFolder("native-pref-a"), "/tmp/default-native");
  assert.equal(nativeDefaultFolder("native-pref-b"), undefined);
  setDefaultProjectId("native-pref-a", "project");
  assert.equal(nativeDefaultFolder("native-pref-a"), undefined);
  setNativeDefaultFolder("native-pref-a", "/tmp/default-native", history);
  assert.equal(defaultProjectId("native-pref-a"), undefined);
  setNativeDefaultFolder("native-pref-a", undefined, history);
});
test("native rows use real Default/Pinned/recency, exclude archived/remote projects, deduplicate project folders and preserve independent selections", () => {
  const project = p("pinned", { pinned: true, cwd: "/tmp/project" });
  const rows = nativePlaceRows({
    projects: [
      p("alpha"),
      project,
      p("archived", { archivedAt: 1 }),
      p("remote", {
        cwd: "/tmp/remote",
        environment: { kind: "ssh", hostId: "x" },
      }),
    ],
    conversations: [
      c("ordinary", { updatedAt: 5 }),
      c("project", { cwd: "/tmp/project", projectId: project.id }),
    ],
    project,
    cwd: "/tmp/ordinary",
    query: "",
    sort: "recent",
    defaultFolder: "/tmp/ordinary",
    showFolders: true,
  });
  assert.deepEqual(
    rows.map((row) => row.key),
    ["folder:/tmp/ordinary", "project:pinned", "project:alpha"],
  );
  assert.deepEqual(
    rows.map((row) => row.section),
    ["Default", "Pinned", undefined],
  );
  assert.deepEqual(
    rows.filter((row) => row.selected).map((row) => row.key),
    ["folder:/tmp/ordinary", "project:pinned"],
  );
  assert.equal(
    rows.some((row) => row.key === "folder:/tmp/project"),
    false,
  );
});
test("native sorting and folder filters act on actual rows and never hide an explicitly selected folder", () => {
  const base = {
    projects: [p("Zulu", { createdAt: 2 }), p("Alpha", { createdAt: 1 })],
    conversations: [c("folder")],
    cwd: undefined,
    query: "",
    showFolders: true,
  };
  assert.deepEqual(
    nativePlaceRows({ ...base, sort: "name" }).map((row) => row.name),
    ["Alpha", "folder", "Zulu"],
  );
  assert.deepEqual(
    nativePlaceRows({ ...base, sort: "created" }).map((row) => row.name),
    ["folder", "Zulu", "Alpha"],
  );
  assert.deepEqual(
    nativePlaceRows({ ...base, sort: "name", showFolders: false }).map(
      (row) => row.name,
    ),
    ["Alpha", "Zulu"],
  );
  assert.equal(
    nativePlaceRows({
      ...base,
      sort: "name",
      showFolders: false,
      cwd: "/tmp/folder",
    }).some((row) => row.kind === "folder"),
    true,
  );
  assert.deepEqual(
    nativePlaceRows({ ...base, sort: "name", query: "/tmp/fold" }).map(
      (row) => row.name,
    ),
    ["folder"],
  );
});

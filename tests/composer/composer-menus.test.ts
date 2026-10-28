import test from "node:test";
import assert from "node:assert/strict";
import type { Conversation, Project, Provider } from "../../shared/types";
import type { ModelCatalog } from "../../shared/model-catalog-api";
import { lockedPolicy, openPolicy } from "../../shared/client-policy";
import {
  catalogChoices,
  catalogDefaultEffort,
  chatEffortsFor,
  codeModelChoices,
  modelLabel,
} from "../../src/composer/model/code-model-choices";
import { offeredPermissionChoices } from "../../src/composer/code/CodePermissionPicker";
import {
  coworkPermission,
  coworkPlaceRows,
  coworkPlaces,
  coworkPlaceUsage,
} from "../../src/composer/cowork-options-model";
import { recentWorkFolders } from "../../src/composer/recentFolders";
import { dashboardFrom, dashboardQuery } from "../../electron/ipc/code-usage";
import {
  codeUsage,
  unsplit,
  withDashboard,
} from "../../src/code-home/usageStats";

const provider: Provider = {
  id: "remote",
  name: "Claudex",
  baseUrl: "http://127.0.0.1:1/v1",
  protocol: "responses",
  model: "opus-5-5",
  models: ["opus-5-5", "sonnet-5", "haiku-4-5", "opus-5", "gpt-x"],
};
const item = (
  id: string,
  sort: number,
  extra: Partial<ModelCatalog["items"][number]> = {},
) => ({
  id,
  displayName: id.replace(/-/g, " "),
  description: `${id} description`,
  badges: [],
  sort,
  hidden: false,
  isDefault: false,
  fast: false,
  usageHint: "",
  ...extra,
});
const catalog: ModelCatalog = {
  defaultModel: "opus-5-5",
  items: [
    item("sonnet-5", 2),
    item("opus-5-5", 1, {
      displayName: "Opus 5.5",
      efforts: ["low", "medium", "high"],
      defaultEffort: "medium",
    }),
    item("haiku-4-5", 3),
    item("opus-5", 9, { hidden: true }),
  ],
};

test("The catalog orders the menus and moves hidden models under More models", () => {
  const { listed, more, catalogued } = catalogChoices([provider], catalog);
  assert.ok(catalogued);
  assert.deepEqual(
    listed.map((c) => c.label),
    ["Opus 5.5", "sonnet 5", "haiku 4 5"],
  );
  assert.equal(listed[0].description, "opus-5-5 description");
  // Hidden first, then gateway models the catalog does not describe.
  assert.deepEqual(
    more.map((c) => c.name),
    ["opus-5", "gpt-x"],
  );
  assert.equal(modelLabel(catalog, "opus-5-5"), "Opus 5.5");
  assert.equal(modelLabel(catalog, "gpt-x"), "gpt-x");
  // Without a catalog (it failed to load) a name seen before is kept; a model
  // never seen keeps its id.
  assert.equal(modelLabel(null, "opus-5-5"), "Opus 5.5");
  assert.equal(modelLabel(null, "never-listed-model"), "never-listed-model");
});

test("A chosen More models entry is listed first so the check stays visible", () => {
  const { quick, more } = codeModelChoices(
    [provider],
    "remote",
    "opus-5",
    catalog,
  );
  assert.deepEqual(
    quick.map((c) => c.name),
    ["opus-5", "opus-5-5", "sonnet-5", "haiku-4-5"],
  );
  assert.deepEqual(
    more.map((c) => c.name),
    ["gpt-x"],
  );
});

test("Without a catalog the menus list the service's model ids as before", () => {
  const { listed, more, catalogued } = catalogChoices([provider], null);
  assert.ok(!catalogued);
  assert.equal(more.length, 0);
  assert.equal(listed.length, 5);
  assert.equal(listed[0].label, undefined);
});

test("Chat efforts follow the model's catalog entry", () => {
  assert.deepEqual(chatEffortsFor(catalog, "opus-5-5"), [
    "low",
    "medium",
    "high",
  ]);
  assert.equal(chatEffortsFor(catalog, "sonnet-5").length, 5);
  assert.equal(chatEffortsFor(null, "x").length, 5);
  assert.equal(catalogDefaultEffort(catalog, "opus-5-5"), "medium");
  assert.equal(catalogDefaultEffort(catalog, "sonnet-5"), undefined);
});

test("Bypass is offered by the user's setting alone; the policy limits the other modes", () => {
  const ids = (...args: Parameters<typeof offeredPermissionChoices>) =>
    offeredPermissionChoices(...args).map((c) => c.id);
  assert.deepEqual(ids(openPolicy, "darwin", undefined), [
    "manual",
    "acceptEdits",
    "plan",
    "auto",
  ]);
  // The locked policy allows only Manual and Plan, yet Bypass stays.
  assert.deepEqual(ids(lockedPolicy, "darwin", true), [
    "manual",
    "plan",
    "bypass",
  ]);
  assert.deepEqual(ids(openPolicy, "darwin", false), [
    "manual",
    "acceptEdits",
    "plan",
    "auto",
  ]);
});

test("Windows offers the same permission modes as macOS", () => {
  assert.deepEqual(
    offeredPermissionChoices(openPolicy, "win32", true).map((c) => c.id),
    offeredPermissionChoices(openPolicy, "darwin", true).map((c) => c.id),
  );
  assert.deepEqual(
    offeredPermissionChoices(
      { permissionModes: ["manual"] },
      "win32",
      false,
    ).map((c) => c.id),
    ["manual"],
  );
});

test("Cowork's permission chip reflects the Cowork sandbox setting", () => {
  assert.equal(coworkPermission("read-only", "darwin"), "manual");
  assert.equal(coworkPermission("workspace-write", "darwin"), "auto");
  assert.equal(coworkPermission("workspace-write", "win32"), "auto");
});

test("Cowork's folder menu searches projects and folders by name and path", () => {
  const projects = [
    { id: "p1", name: "Ops", description: "", instructions: "", createdAt: 0 },
    {
      id: "p2",
      name: "Robots",
      description: "",
      instructions: "",
      cwd: "/work/ros",
      createdAt: 0,
    },
  ];
  const folders = ["/Users/me/.codex", "/Users/me/Projects/ops"];
  assert.deepEqual(coworkPlaces(projects, folders, ""), {
    projects,
    folders,
  });
  const found = coworkPlaces(projects, folders, "OPS");
  assert.deepEqual(
    found.projects.map((p) => p.id),
    ["p1"],
  );
  assert.deepEqual(found.folders, ["/Users/me/Projects/ops"]);
  assert.deepEqual(
    coworkPlaces(projects, folders, "ros").projects.map((p) => p.id),
    ["p2"],
  );
});

test("The project or folder menu mixes projects and folders by last use, projects first on a tie", () => {
  const p = (id: string, createdAt: number) =>
    ({
      id,
      name: `Project ${id}`,
      description: "",
      instructions: "",
      createdAt,
    }) as Project;
  const usage = coworkPlaceUsage([
    { projectId: "p1", mode: "chat", updatedAt: 5 },
    { cwd: "/a", mode: "cowork", updatedAt: 9 },
    { cwd: "/a", mode: "code", updatedAt: 2 },
    { cwd: "/secret", mode: "cowork", updatedAt: 99, incognito: true },
  ] as Conversation[]);
  assert.equal(usage.get("/a"), 9);
  assert.equal(usage.has("/secret"), false);
  const rows = coworkPlaceRows(
    [p("p1", 1), p("p2", 9)],
    ["/a", "/b"],
    "",
    usage,
  );
  assert.deepEqual(
    rows.map((row) => (row.kind === "project" ? row.project.id : row.path)),
    ["p2", "/a", "p1", "/b"],
  );
  assert.deepEqual(coworkPlaceRows([p("p1", 1)], ["/a"], "nothing", usage), []);
});

test("Recent work folders include Cowork and Code tasks, newest first, not incognito", () => {
  const c = (id: string, mode: Conversation["mode"], cwd: string, at: number) =>
    ({ id, mode, cwd, updatedAt: at, turns: [] }) as unknown as Conversation;
  assert.deepEqual(
    recentWorkFolders([
      c("a", "code", "/a", 1),
      c("b", "cowork", "/b", 3),
      c("c", "chat", "/c", 4),
      c("d", "cowork", "/a", 2),
      { ...c("e", "cowork", "/secret", 5), incognito: true },
    ]),
    ["/b", "/a"],
  );
});

test("The usage dashboard is read for whole local days and parsed defensively", () => {
  const now = new Date(2026, 8, 26, 15, 0);
  const week = new URLSearchParams(dashboardQuery("7d", now));
  assert.equal(week.get("start_date"), "2026-09-20");
  assert.equal(week.get("end_date"), "2026-09-26");
  assert.equal(week.get("granularity"), "day");
  assert.equal(
    new URLSearchParams(dashboardQuery("30d", now)).get("start_date"),
    "2026-08-28",
  );
  assert.equal(
    new URLSearchParams(dashboardQuery("all", now)).get("start_date"),
    "2000-01-01",
  );
  const parsed = dashboardFrom({
    trend: [
      { date: "2026-09-25", total_tokens: 30 },
      { date: "2026-09-24", total_tokens: 10 },
      { date: "bad", total_tokens: 5 },
    ],
    models: [
      { model: "small", input_tokens: 1, output_tokens: 2, total_tokens: 3 },
      { model: "big", input_tokens: 10, output_tokens: 20, total_tokens: 37 },
      { model: "idle", input_tokens: 0, output_tokens: 0, total_tokens: 0 },
      { model: "odd", input_tokens: "x", output_tokens: -1 },
    ],
  });
  assert.deepEqual(parsed, {
    tokens: 40,
    models: [
      { model: "big", input: 10, output: 20, total: 37 },
      { model: "small", input: 1, output: 2, total: 3 },
    ],
    daily: [
      { date: "2026-09-24", tokens: 10 },
      { date: "2026-09-25", tokens: 30 },
    ],
  });
  assert.deepEqual(dashboardFrom(undefined), {
    tokens: 0,
    models: [],
    daily: [],
  });
});

test("A Sub2API account's card takes tokens and models from the service", () => {
  const now = new Date(2026, 8, 26, 12).getTime();
  const local = codeUsage([], "7d", now);
  const merged = withDashboard(local, {
    tokens: 40,
    models: [
      { model: "big", input: 10, output: 20, total: 30 },
      { model: "small", input: 4, output: 6, total: 10 },
    ],
    daily: [{ date: "2026-09-25", tokens: 40 }],
  });
  assert.equal(merged.tokens, 40);
  assert.equal(merged.favoriteModel, "big");
  assert.deepEqual(
    merged.models.map((m) => m.share),
    [0.75, 0.25],
  );
  assert.equal(merged.sessions, local.sessions);
  assert.equal(merged.daily.length, 7);
  assert.deepEqual(merged.daily[5].byModel, { [unsplit]: 40 });
  assert.deepEqual(merged.daily[6].byModel, {});
});

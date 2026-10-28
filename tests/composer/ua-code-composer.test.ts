import test from "node:test";
import assert from "node:assert/strict";
import type {
  ModelCatalog,
  ModelCatalogItem,
} from "../../shared/model-catalog-api";
import type { FastAwareCatalogItem } from "../../shared/fast-mode";
import {
  fastModeState,
  fastUnavailableReason,
  isFastTier,
} from "../../src/composer/code/code-fast-mode";
import {
  codeEnvironmentMenu,
  environmentReasons,
} from "../../src/composer/code/code-environment-menu";
import type { MenuEntry } from "../../src/ui/Menu";
import { localEnvironment } from "../../src/ssh/model";
import { readFileSync } from "node:fs";
import { readSource } from "../support/read-source";

test("the merged workspace keeps cloud controls alongside one branch dialog and enabled draft-folder controls", () => {
  const source = readSource("src/composer/WorkspaceBar.tsx");
  for (const component of [
    "EnvironmentStartCard",
    "CloudEnvironmentDialog",
    "DirtyTreeDialog",
  ])
    assert.equal(
      (source.match(new RegExp(`<${component}\\b`, "g")) ?? []).length,
      1,
      component,
    );
  assert.equal(
    (source.match(/className="workspace-chip branch-chip"/g) ?? []).length,
    1,
  );
  assert.equal((source.match(/className="workspace-bar"/g) ?? []).length, 1);
  assert.match(source, /additionalFolders\.map\(/);
  assert.match(source, /formatText\("Remove \{name\}"/);
  assert.match(source, /onClick=\{\(\) => void addFolder\(\)\}/);
  assert.match(source, /searchable=\{open\.expanded \? "Search environments…"/);
  assert.doesNotMatch(
    source,
    /addFolderReason|aria-disabled|^(<<<<<<<|=======|>>>>>>>)/m,
  );
});

const item = (
  id: string,
  extra: Partial<FastAwareCatalogItem> = {},
): FastAwareCatalogItem => ({
  id,
  displayName: id,
  description: "",
  badges: [],
  sort: 0,
  hidden: false,
  isDefault: false,
  usageHint: "",
  ...extra,
});

test("Fast mode is disabled with its reason when the catalog has no fast tier", () => {
  for (const catalog of [null, { defaultModel: null, items: [item("a")] }]) {
    const state = fastModeState(catalog, "a");
    assert.deepEqual(state, {
      available: false,
      on: false,
      reason: fastUnavailableReason,
    });
    assert.equal(isFastTier(catalog, "a"), false);
  }
});

test("Fast mode ignores the deprecated `fast` flag", () => {
  const legacy: ModelCatalogItem = { ...item("a"), fast: true };
  const catalog: ModelCatalog = { defaultModel: null, items: [legacy] };
  assert.equal(fastModeState(catalog, "a").available, false);
  assert.equal(isFastTier(catalog, "a"), false);
});

test("Fast mode switches between a model and its catalog fast tier", () => {
  const catalog: ModelCatalog = {
    defaultModel: "a",
    items: [item("a"), item("a-fast", { fastOf: "a" }), item("b")],
  };
  assert.deepEqual(fastModeState(catalog, "a"), {
    available: true,
    on: false,
    target: "a-fast",
  });
  assert.deepEqual(fastModeState(catalog, "a-fast"), {
    available: true,
    on: true,
    target: "a",
  });
  assert.equal(fastModeState(catalog, "b").available, false);
  assert.equal(isFastTier(catalog, "a-fast"), true);
  assert.equal(isFastTier(catalog, "a"), false);
});

const labels = (entries: MenuEntry[]) =>
  entries.map((entry) =>
    "label" in entry ? [entry.label, Boolean(entry.disabled)] : null,
  );

const options = {
  hosts: [],
  statuses: {},
  selected: localEnvironment,
  onLocal: () => {},
  onHost: () => {},
  onAdd: () => {},
  onManage: () => {},
  onEditLocal: () => {},
  onCloud: () => {},
  onCreateCloud: () => {},
  onEditCloud: () => {},
};

test("The environment menu lists Local, Cloud, Remote Control and SSH like the capture", () => {
  const entries = codeEnvironmentMenu({ ...options, ssh: false });
  assert.deepEqual(labels(entries), [
    ["Local", false],
    ["Cloud", false],
    ["Remote Control", false],
    ["SSH", true],
  ]);
  const titles = entries.map((entry) => "label" in entry && entry.title);
  assert.deepEqual(titles.slice(2), [undefined, environmentReasons.ssh]);
  assert.equal("label" in entries[0] && entries[0].checked, true);
  // Cloud rows and creation are enabled.
  assert.equal(
    "label" in entries[0] && entries[0].settings?.label,
    "Edit local environment",
  );
  const cloud = entries[1];
  assert.ok("label" in cloud && cloud.submenu);
  assert.deepEqual(labels(cloud.submenu), [
    ["Default", false],
    ["Add cloud environment…", false],
  ]);
  for (const row of entries.slice(2))
    assert.equal("label" in row && row.chevron, true);
});

test("SSH keeps its host submenu once remote sessions work", () => {
  const entries = codeEnvironmentMenu({ ...options, ssh: true });
  assert.deepEqual(labels(entries), [
    ["Local", false],
    ["Cloud", false],
    ["Remote Control", false],
    ["SSH", false],
  ]);
  const ssh = entries[3];
  assert.ok("label" in ssh && ssh.submenu?.length);
});

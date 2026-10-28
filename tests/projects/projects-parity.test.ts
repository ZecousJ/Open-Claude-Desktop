import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Project } from "../../shared/types";
import {
  ProjectsPage,
  projectCardMenuEntries,
} from "../../src/collections/projects/ProjectsPage";
import { readSource } from "../support/read-source";

const project: Project = {
  id: "garden",
  name: "Garden",
  description: "Plans for the garden",
  instructions: "Keep it seasonal.",
  createdAt: 1,
};

test("desktop project menus open a real project pop-out", () => {
  let opened: string | undefined;
  const entries = projectCardMenuEntries(project, {
    onOpenWindow: (value) => {
      opened = value.id;
    },
    onSaveProject: async () => {},
    onEditProject: () => {},
    onArchiveProject: () => {},
    onDeleteProject: () => {},
  });
  const entry = entries.find(
    (entry) => "label" in entry && entry.label === "Open in new window",
  );
  assert.ok(entry && "onSelect" in entry);
  entry.onSelect();
  assert.equal(opened, project.id);
});

test("a project's menu pins, edits, archives and deletes; the project page's own menu leaves Pin to its pin button", () => {
  const saved: Project[] = [];
  const edited: Project[] = [];
  const archived: Project[] = [];
  const deleted: Project[] = [];
  const actions = {
    onSaveProject: async (value: Project) => {
      saved.push(value);
    },
    onEditProject: (value: Project) => {
      edited.push(value);
    },
    onArchiveProject: (value: Project) => {
      archived.push(value);
    },
    onDeleteProject: (value: Project) => {
      deleted.push(value);
    },
  };
  const labels = (entries: ReturnType<typeof projectCardMenuEntries>) =>
    entries.map((entry) => ("label" in entry ? entry.label : "separator"));
  const entries = projectCardMenuEntries(project, actions);
  assert.deepEqual(labels(entries), [
    "Pin",
    "Edit details",
    "separator",
    "Archive",
    "Delete",
  ]);
  for (const entry of entries) {
    if (!("label" in entry)) continue;
    assert.ok(!entry.disabled);
    assert.equal(Boolean(entry.danger), entry.label === "Delete", entry.label);
    entry.onSelect();
  }
  assert.deepEqual(saved, [{ ...project, pinned: true }]);
  assert.deepEqual(edited, [project]);
  assert.deepEqual(archived, [project]);
  assert.deepEqual(deleted, [project]);
  assert.deepEqual(
    labels(projectCardMenuEntries(project, actions, { pin: false })),
    ["Edit details", "separator", "Archive", "Delete"],
  );
  const unpin = projectCardMenuEntries(
    { ...project, pinned: true },
    actions,
  )[0];
  assert.ok("label" in unpin);
  assert.equal(unpin.label, "Unpin");
  unpin.onSelect();
  assert.deepEqual(saved.at(-1), { ...project, pinned: false });
  const entriesArchived = projectCardMenuEntries(
    { ...project, archivedAt: 2 },
    actions,
  );
  assert.deepEqual(labels(entriesArchived), [
    "Edit details",
    "separator",
    "Unarchive",
    "Delete",
  ]);
  const unarchive = entriesArchived[2];
  assert.ok("label" in unarchive);
  assert.ok(!unarchive.danger);
  unarchive.onSelect();
  assert.deepEqual(saved.at(-1), { ...project, archivedAt: undefined });
});

const css = readFileSync(
  new URL("../../src/collections/projects/projects.css", import.meta.url),
  "utf8",
);
const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => ({
  selectors: match[1]
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .trim()
    .split(/,\s*/),
  declarations: Object.fromEntries(
    match[2]
      .trim()
      .split(";")
      .filter(Boolean)
      .map((declaration) => {
        const colon = declaration.indexOf(":");
        return [
          declaration.slice(0, colon).trim(),
          declaration.slice(colon + 1).trim(),
        ];
      }),
  ),
}));
// Values compare in one spelling: a formatter may write 0.25rem for .25rem.
const sameSpelling = (declarations: Record<string, string>) =>
  Object.fromEntries(
    Object.entries(declarations).map(([k, v]) => [
      k,
      v.replace(/(^|[^0-9])0\.(\d)/g, "$1.$2"),
    ]),
  );
const style = (selector: string) =>
  Object.assign(
    {},
    ...rules
      .filter((rule) => rule.selectors.includes(selector))
      .map((rule) => sameSpelling(rule.declarations)),
  );

test("project cards use the captured comfortable density without per-host card overrides", () => {
  const card = style(".prj-grid .prj-card");
  assert.equal(card.background, "var(--cds-surface-1)");
  assert.equal(card["box-shadow"], "inset 0 0 0 1px var(--cds-ring-color)");
  assert.equal(card.border, "0");
  assert.equal(card["border-radius"], "12px");
  assert.equal(card.padding, "var(--cds-pad-lg)");
  assert.equal(card.gap, "var(--cds-gap-xs)");
  assert.equal(card["min-height"], "112px");
  // No fixed height for a described card: it grows with its text, and a row's
  // cards stretch to its tallest.
  assert.equal(style(".prj-card.has-description")["min-height"], undefined);
  assert.equal(style(".prj-grid > li")["align-items"], "stretch");
  assert.equal(style(".prj-view")["--cds-gap-xs"], "8px");
  assert.equal(style(".prj-view")["--cds-gap-md"], "16px");
  assert.equal(style(".prj-view")["--cds-font-size-footnote"], "13px");
  assert.equal(style(".prj-view")["--cds-leading-footnote"], "17px");
  assert.equal(
    style(".prj-grid .prj-card:hover").background,
    "var(--cds-surface-2)",
  );
  for (const selector of rules.flatMap((rule) => rule.selectors))
    assert.ok(!/:root.*\.prj-card(?:\s|:|$)/.test(selector), selector);
  const description = style(".prj-card > span");
  assert.equal(description["-webkit-line-clamp"], "3");
  assert.equal(description["margin-bottom"], "var(--cds-gap-md)");
  assert.equal(description["font-size"], "var(--cds-font-size-body)");
  assert.equal(description.color, "var(--cds-text-secondary)");
  const footer = style(".prj-card > small");
  assert.equal(footer["font-size"], "var(--cds-font-size-footnote)");
  assert.equal(footer["line-height"], "var(--cds-leading-footnote)");
  assert.equal(footer.color, "var(--cds-text-muted)");
  assert.equal(footer["padding-top"], undefined);
  assert.equal(style(".prj-view")["--cds-pad-lg"], "16px");
  assert.equal(style(".prj-view")["--cds-font-size-body"], "14px");
  assert.equal(style(".prj-view")["--cds-leading-body"], "20px");
  assert.equal(style(".prj-view")["--cds-text-secondary"], "#c3c2b7");
  assert.equal(
    style(':root[data-theme="light"] .prj-view')["--cds-text-secondary"],
    "#52514e",
  );
});

test("project grid uses one column with 12px gaps below md and two with 24px at md", () => {
  const grid = rules.filter((rule) => rule.selectors.includes(".prj-grid"));
  assert.deepEqual(
    grid.map((rule) => [
      rule.declarations["grid-template-columns"],
      rule.declarations.gap,
    ]),
    [
      ["minmax(0, 1fr)", "12px"],
      ["repeat(2, minmax(0, 1fr))", "24px"],
    ],
  );
  assert.match(css, /@media \(min-width: 768px\)\s*\{\s*\.prj-grid/);
});

test("initialized project lists have an enabled New project button, not a Chat-import split", () => {
  const html = renderToStaticMarkup(
    createElement(ProjectsPage, {
      projects: [project],
      conversations: [],
      onNewProject() {},
      onEditProject() {},
      onArchiveProject() {},
      onDeleteProject() {},
      onOpenConversation() {},
      renderComposer: () => null,
      onSaveProject: async () => {},
      onChooseFolder: async () => null,
      onScheduled() {},
    }),
  );
  assert.match(html, /<button[^>]*class="prj-new"[^>]*>New project<\/button>/);
  assert.doesNotMatch(html, /class="prj-new"[^>]*disabled|Projects from Chat/);
  assert.match(html, /Plans for the garden/);
  const app = readSource("src/app/App.tsx");
  assert.ok(
    app.indexOf("if (!snapshot)") < app.indexOf("const startProject ="),
  );
});

test("project parity includes live composer states and Cowork folder flow", () => {
  const composer = readFileSync(
    new URL("../../src/composer/ComposerAddMenu.tsx", import.meta.url),
    "utf8",
  );
  assert.match(composer, /No matches/);
  assert.match(composer, /No projects available/);
  assert.match(composer, /Failed to load projects/);
  assert.match(composer, /composer-add-project-tag/);
  const folders = readFileSync(
    new URL(
      "../../src/collections/projects/ProjectFolders.tsx",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(folders, /<h2>Folders<\/h2>/);
  const create = readFileSync(
    new URL("../../src/dialogs/ProjectCreateDialog.tsx", import.meta.url),
    "utf8",
  );
  assert.match(create, /"Use an existing folder"/);
  assert.match(create, /memoryReason/);
});

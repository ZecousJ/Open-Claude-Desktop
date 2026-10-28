import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CustomizeSkill } from "../../shared/collections-api";
import { customizeSkills } from "../../electron/ipc/collections";
import {
  editedLabel,
  originOf,
  sections,
  skillSlug,
  visibleSkills,
} from "../../src/collections/customize/customize-list";

const skill = (overrides: Partial<CustomizeSkill>): CustomizeSkill => ({
  name: "s",
  description: "",
  path: `/skills/${overrides.name ?? "s"}/SKILL.md`,
  scope: "user",
  enabled: true,
  own: true,
  ...overrides,
});

test("Yours sorts, filters by who made a skill and groups it", () => {
  const list = [
    skill({ name: "zeta", editedAt: 3, description: "Weekly report" }),
    skill({ name: "alpha", editedAt: 1 }),
    skill({ name: "org-style", scope: "admin", own: false, editedAt: 5 }),
    skill({ name: "creator", scope: "system", own: false, editedAt: 2 }),
    skill({ name: "repo-lint", scope: "repo", own: false }),
  ];
  const names = (rows: CustomizeSkill[]) => rows.map((s) => s.name);
  assert.deepEqual(names(visibleSkills(list, "", "all", "edited")), [
    "org-style",
    "zeta",
    "creator",
    "alpha",
    "repo-lint",
  ]);
  assert.deepEqual(names(visibleSkills(list, "", "you", "name")), [
    "alpha",
    "zeta",
  ]);
  assert.deepEqual(names(visibleSkills(list, "", "organization", "name")), [
    "org-style",
  ]);
  assert.deepEqual(names(visibleSkills(list, "", "builtin", "name")), [
    "creator",
    "repo-lint",
  ]);
  assert.deepEqual(names(visibleSkills(list, "weekly rep", "all", "name")), []);
  assert.deepEqual(names(visibleSkills(list, "zeta", "all", "name")), ["zeta"]);
  assert.equal(originOf({ scope: "system", own: true }), "you");
  const grouped = sections.map((section) => names(list.filter(section.test)));
  assert.deepEqual(grouped, [
    ["repo-lint"],
    ["zeta", "alpha"],
    ["org-style"],
    [],
    ["creator"],
    [],
  ]);
});

test("edit dates read like the original's rows", () => {
  const now = new Date(2026, 8, 26).getTime();
  assert.equal(editedLabel(new Date(2026, 8, 16).getTime(), now), "Sep 16");
  assert.equal(editedLabel(new Date(2025, 2, 8).getTime(), now), "Mar 8, 2025");
});

test("Customize lists each runtime skill once, with its SKILL.md date and whether it is the person's", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-customize-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const own = path.join(root, "codex-home", "skills", "notes", "SKILL.md");
  fs.mkdirSync(path.dirname(own), { recursive: true });
  fs.writeFileSync(own, "---\nname: notes\n---\n");
  const when = new Date(2026, 8, 20, 10).getTime();
  fs.utimesSync(own, when / 1000, when / 1000);
  const bundled = "/nowhere/skills/creator/SKILL.md";
  const calls: unknown[] = [];
  const rpc = {
    call: async (method: string, params: unknown) => {
      calls.push([method, params]);
      return {
        data: [
          {
            cwd: root,
            skills: [
              {
                name: "notes",
                description: "Meeting notes",
                path: own,
                scope: "user",
                enabled: true,
              },
              {
                name: "creator",
                description: "Make skills",
                path: bundled,
                scope: "system",
                enabled: false,
              },
            ],
          },
          // The same skill reported for a second folder is listed once.
          {
            cwd: "/other",
            skills: [
              { name: "notes", path: own, scope: "user", enabled: true },
            ],
          },
        ],
      };
    },
  };
  const ctx = { engine: { rpc }, store: { root } } as any;
  const skills = await customizeSkills(ctx);
  assert.deepEqual(calls, [["skills/list", { forceReload: true }]]);
  assert.equal(skills.length, 2);
  assert.deepEqual(skills[0], {
    name: "notes",
    description: "Meeting notes",
    path: own,
    scope: "user",
    enabled: true,
    editedAt: when,
    own: true,
    provenance: { source: "you" },
  });
  assert.equal(skills[1].own, false);
  assert.equal(skills[1].enabled, false);
  assert.equal(skills[1].editedAt, undefined, "an unreadable file has no date");
  assert.deepEqual(
    await customizeSkills({ engine: {}, store: { root } } as any),
    [],
  );
});

test("a skill's name is saved as a folder-safe slug (R-1613, R-1625)", () => {
  assert.equal(skillSlug("test!"), "test");
  assert.equal(skillSlug("Weekly status report"), "weekly-status-report");
  assert.equal(skillSlug("  !!  "), "");
  // The runtime's folder names start with a letter.
  assert.equal(skillSlug("2025 recap"), "skill-2025-recap");
  assert.ok(skillSlug("a".repeat(200)).length <= 64);
  assert.match(skillSlug("x ".repeat(60)), /^[a-z][a-z0-9-]{0,63}$/);
});

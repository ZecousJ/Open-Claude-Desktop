import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  TaskPermissionPicker,
  taskPermissionEntries,
  windowPermissionText,
  coworkPermissionText,
} from "../../src/composer/TaskPermissionPicker";
import { SkipAllApprovalsDialog } from "../../src/composer/SkipAllApprovalsDialogImpl";
import { PermissionModeNotice } from "../../src/composer/PermissionModeNotice";

test("the task picker's trigger is the mode's name only, Manual by default", () => {
  const html = (settings: object) =>
    renderToStaticMarkup(
      createElement(TaskPermissionPicker, { settings, onChange: () => {} }),
    );
  assert.match(
    html({}),
    /class="task-permission-trigger mode-default"[^>]*aria-label="Manual"[^>]*><span class="task-permission-label">Manual<\/span>/,
  );
  assert.match(
    html({ taskPermission: "auto" }),
    /<span class="task-permission-label">Auto<\/span>/,
  );
  // Skip all approvals is named in full (the official "Skip" says nothing).
  assert.match(
    html({ taskPermission: "bypass" }),
    /aria-label="Skip all approvals"[^>]*><span class="task-permission-label">Skip all approvals<\/span>/,
  );
  // Only the phone layout's glyph, which CSS shows below 640px.
  assert.deepEqual(
    html({})
      .match(/<svg[^>]*class="[^"]*"/g)
      ?.map((tag) => tag.includes("task-permission-mobile-icon")),
    [true],
  );
});

test("the menu lists Manual, Auto and Skip all approvals under Permission mode", () => {
  const chosen: string[] = [];
  const entries = taskPermissionEntries("auto", (mode) => chosen.push(mode));
  assert.deepEqual(entries[0], { heading: "Permission mode" });
  const rows = entries.slice(1) as {
    label: string;
    description: string;
    checked: boolean;
    onSelect: () => void;
  }[];
  assert.deepEqual(
    rows.map((row) => [row.label, row.checked]),
    [
      ["Manual", false],
      ["Auto", true],
      ["Skip all approvals", false],
    ],
  );
  assert.match(rows[1].description, /pauses to ask if anything looks unsafe/);
  rows[2].onSelect();
  assert.deepEqual(chosen, ["bypass"]);
});

test("Skip confirmation uses the Cowork warning rather than Code bypass copy", () => {
  const html = renderToStaticMarkup(
    createElement(SkipAllApprovalsDialog, {
      onCancel() {},
      onConfirm() {},
      connectors: ["Calendar"],
    }),
  );
  assert.match(html, /Skip all approvals\?/);
  assert.match(html, /Beta/);
  assert.match(html, /This can put your data at risk/);
  assert.match(html, /Calendar/);
  assert.match(html, /Yes, continue/);
  assert.doesNotMatch(html, /Bypass all permissions/);
});

test("permission notices use the official mode-specific copy and safe-use link", () => {
  const auto = renderToStaticMarkup(
    createElement(PermissionModeNotice, { mode: "auto" }),
  );
  const bypass = renderToStaticMarkup(
    createElement(PermissionModeNotice, { mode: "bypass" }),
  );
  assert.match(auto, /Permission mode is set to Auto\./);
  assert.match(bypass, /Skip all approvals is on\./);
  assert.match(bypass, /See safe use tips/);
  assert.match(bypass, /help\/skip-approvals-safety/);
  assert.match(bypass, /aria-label="Dismiss"/);
});

test("a task window's picker is the mode's glyph, named for screen readers", () => {
  const html = (settings: object) =>
    renderToStaticMarkup(
      createElement(TaskPermissionPicker, {
        settings,
        onChange: () => {},
        iconOnly: true,
      }),
    );
  assert.match(
    html({}),
    /class="task-permission-trigger mode-default icon-only"[^>]*aria-label="Manually approve"[^>]*><svg/,
  );
  assert.match(
    html({ taskPermission: "auto" }),
    /aria-label="Automatically approve"/,
  );
  assert.doesNotMatch(html({}), /<span>/);
  const rows = taskPermissionEntries(
    "default",
    () => {},
    windowPermissionText,
  ).slice(1) as { label: string }[];
  assert.deepEqual(
    rows.map((row) => row.label),
    ["Manually approve", "Automatically approve", "Skip all approvals"],
  );
});

test("a task window's menu has no label or inline descriptions: glyph rows with tooltips", () => {
  const rows = taskPermissionEntries(
    "default",
    () => {},
    windowPermissionText,
    false,
    undefined,
    "legacy",
    true,
  ) as {
    label: string;
    icon?: unknown;
    tooltip?: string;
    description?: string;
  }[];
  assert.deepEqual(
    rows.map((row) => row.label),
    ["Manually approve", "Automatically approve", "Skip all approvals"],
  );
  assert.ok(rows.every((row) => row.icon && !row.description));
  assert.equal(
    rows[0]?.tooltip,
    "Claudex pauses so you can approve each action.",
  );
});

test("an unbound Cowork conversation has Cowork menu copy and compact text triggers", () => {
  const rows = taskPermissionEntries(
    "default",
    () => {},
    coworkPermissionText,
  ).slice(1);
  assert.deepEqual(
    rows.map((row) => ("label" in row ? row.label : undefined)),
    ["Manually approve", "Automatically approve", "Skip all approvals"],
  );
  assert.equal(
    coworkPermissionText.default.description,
    "Claudex pauses so you can approve each action.",
  );
  for (const [mode, trigger, label] of [
    ["default", "Manual", "Manually approve"],
    ["auto", "Auto", "Automatically approve"],
    ["bypass", "Skip all approvals", "Skip all approvals"],
  ] as const) {
    const html = renderToStaticMarkup(
      createElement(TaskPermissionPicker, {
        settings: { taskPermission: mode },
        sessionType: "cowork",
        onChange() {},
      }),
    );
    assert.ok(html.includes(`aria-label="${label}"`));
    assert.ok(
      html.includes(`<span class="task-permission-label">${trigger}</span>`),
    );
  }
});

test("cloud restrictions explain local-only modes, without disabling current or supported modes", () => {
  const rows = taskPermissionEntries(
    "default",
    () => {},
    coworkPermissionText,
    true,
  );
  assert.ok(
    "title" in rows[2] &&
      rows[2].disabled &&
      rows[2].title === "Auto only runs locally",
  );
  assert.ok(
    "title" in rows[3] &&
      rows[3].disabled &&
      rows[3].title === "Skip all approvals only runs locally",
  );
  const current = taskPermissionEntries(
    "auto",
    () => {},
    coworkPermissionText,
    true,
  );
  assert.ok(!("disabled" in current[2]));
  const supported = taskPermissionEntries(
    "default",
    () => {},
    coworkPermissionText,
    true,
    ["auto", "bypass"],
  );
  assert.ok(supported.every((row) => !("disabled" in row)));
  const local = taskPermissionEntries(
    "default",
    () => {},
    coworkPermissionText,
  );
  assert.ok(local.every((row) => !("disabled" in row)));
});

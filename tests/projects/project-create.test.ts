import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { act, createElement, useState } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { ProjectEditorDialog } from "../../src/dialogs/ProjectEditorDialog";
import { projectTemplates } from "../../src/dialogs/project-templates";
import type { Project } from "../../shared/types";
import {
  ProjectCreateDialog,
  type ProjectCreation,
} from "../../src/dialogs/ProjectCreateDialog";
import {
  copyProjectCreationFiles,
  createProjectFolder,
} from "../../electron/projects/project-create";

const project: Project = {
  id: "new",
  name: "",
  description: "",
  instructions: "",
  createdAt: 1,
};

test("Cowork starts with the live three-card chooser, not Chat's description form", () => {
  const { document } = parseHTML(
    renderToStaticMarkup(
      createElement(ProjectCreateDialog, {
        project,
        onChange() {},
        onClose() {},
        async onSave() {},
        async onChooseFolder() {
          return null;
        },
        onError() {},
      }),
    ),
  );
  assert.equal(
    document.querySelector("h2")!.textContent,
    "Create a new project",
  );
  assert.deepEqual(
    Array.from(
      document.querySelectorAll(".prj-create-option strong"),
      (node) => node.textContent,
    ),
    ["Start from scratch", "Import a project", "Use an existing folder"],
  );
  assert.equal(document.querySelectorAll(".prj-create-icon").length, 3);
  assert.ok(
    !document
      .querySelectorAll(".prj-create-option")[1]
      .hasAttribute("disabled"),
  );
  assert.equal(document.querySelector("form"), null);
  assert.equal(document.querySelector("textarea"), null);
  const css = fs.readFileSync("src/dialogs/project-create.css", "utf8");
  assert.match(css, /width: 520px/);
  assert.match(css, /grid-auto-rows: 1fr/);
  assert.match(css, /padding: 14px 16px/);
  assert.match(css, /height: 40px/);
  assert.match(css, /border: 1px dashed var\(--create-strong\)/);
});

test("Chat's create-project entry keeps its own form rather than Cowork onboarding", () => {
  const html = renderToStaticMarkup(
    createElement(ProjectEditorDialog, {
      onArchive() {},
      onDelete() {},
      project,
      isExisting: false,
      coworkCreation: false,
      onChange() {},
      onClose() {},
      async onSave() {},
      async onChooseFolder() {
        return null;
      },
      onError() {},
    }),
  );
  assert.match(html, /What are you working on\?/);
  assert.equal(
    parseHTML(html).document.querySelector(
      '[aria-label="Customize project icon and color"]',
    ),
    null,
  );
  assert.match(html, /What are you trying to achieve\?/);
  assert.doesNotMatch(html, /Start from scratch/);
});

test("student templates use the official questions and prefilled descriptions", () => {
  assert.equal(projectTemplates.length, 3);
  for (const template of projectTemplates) {
    const { document } = parseHTML(
      renderToStaticMarkup(
        createElement(ProjectEditorDialog, {
          project: { ...project, description: template.description },
          isExisting: false,
          coworkCreation: false,
          onChange() {},
          onClose() {},
          async onSave() {},
          async onChooseFolder() {
            return null;
          },
          onError() {},
          onArchive() {},
          onDelete() {},
        }),
      ),
    );
    assert.equal(document.querySelector("h2")?.textContent, template.heading);
    assert.ok(
      document.querySelector("label")?.textContent?.includes(template.question),
    );
    assert.equal(
      document.querySelector("textarea")?.textContent,
      template.description,
    );
    assert.equal(
      document.querySelector('[aria-label="Customize project icon and color"]'),
      null,
    );
    assert.doesNotMatch(template.description, /Claude\b/);
  }
});

test("new-project form validates name AND location, stages files, trims instructions, and supports Back and an existing folder", async () => {
  const { window, document } = parseHTML(
    "<html><body><main></main></body></html>",
  );
  (document as unknown as { oninput: null }).oninput = null;
  Object.assign(window, {
    desktop: {
      async memoryStatus() {
        return {
          available: true,
          allowed: { generate: true },
          prefs: { generate: true },
        };
      },
      onEvent() {
        return () => {};
      },
      async listProjectKnowledge() {
        return { files: [{ name: "notes.txt" }] };
      },
    },
  });
  const globals = {
    window,
    document,
    IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    },
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
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.querySelector("main")!);
  const saves: { project: Project; creation: ProjectCreation }[] = [];
  const errors: unknown[] = [];
  let folder: string | null = null;
  let failed = true;
  const titles: (string | undefined)[] = [];
  function Harness() {
    const [draft, setDraft] = useState(project);
    return createElement(ProjectCreateDialog, {
      project: draft,
      projects: [
        {
          ...project,
          id: "chat-a",
          name: "Research",
          instructions: "Be concise.",
        },
        { ...project, id: "chat-b", name: "Garden" },
        { ...project, id: "cowork", name: "Cowork", cwd: "/work/Cowork" },
        { ...project, id: "archived", name: "Archived", archivedAt: 1 },
      ],
      onChange: setDraft,
      onClose() {},
      onError: (error) => errors.push(error),
      async onChooseFolder(title) {
        titles.push(title);
        return folder;
      },
      async onSave(value, creation) {
        saves.push({ project: value, creation });
        if (failed) throw new Error("save failed");
      },
    });
  }
  const click = (selector: string) =>
    act(async () =>
      document.querySelector<HTMLButtonElement>(selector)!.click(),
    );
  const change = (selector: string, value: string) =>
    act(() => {
      const field = document.querySelector<
        HTMLInputElement | HTMLTextAreaElement
      >(selector)!;
      const prototype =
        field.tagName === "INPUT"
          ? window.HTMLInputElement.prototype
          : window.HTMLTextAreaElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(
        field,
        value,
      );
      field.dispatchEvent(new window.Event("input", { bubbles: true }));
    });
  const submit = () =>
    act(async () => {
      document
        .querySelector("form")!
        .dispatchEvent(
          new window.Event("submit", { bubbles: true, cancelable: true }),
        );
    });
  try {
    await act(() => root.render(createElement(Harness)));
    await click(".prj-create-option");
    assert.equal(
      document.querySelector("h2")!.textContent,
      "Start a new project",
    );
    assert.equal(document.querySelectorAll("textarea").length, 1);
    assert.ok(
      document.querySelector('[aria-label="Customize project icon and color"]'),
    );
    assert.equal(
      document.querySelector("textarea")!.getAttribute("placeholder"),
      "Tell Claudex how to work in this project (optional)",
    );
    assert.equal(document.querySelector("textarea")!.getAttribute("rows"), "3");
    assert.equal(
      document
        .querySelector('input:not([type="file"])')!
        .getAttribute("placeholder"),
      "Project name",
    );
    assert.equal(
      document.querySelector('[role="status"]')!.textContent,
      "Memory is on",
    );
    assert.equal(
      document.querySelector(".prj-create-drop")!.textContent,
      "Drop files here or click to browse",
    );
    assert.equal(
      document.querySelector(".prj-create-back")!.textContent,
      "Back",
    );
    assert.equal(
      document.querySelector(".prj-create-submit")!.textContent,
      "Create",
    );
    await submit();
    assert.equal(saves.length, 0);
    await change('input:not([type="file"])', "  Research  ");
    assert.ok(
      document.querySelector(".prj-create-submit")!.hasAttribute("disabled"),
    );
    await click(".prj-create-location");
    assert.equal(
      document.querySelector(".prj-create-location")!.textContent,
      "Select a folder...",
    );
    folder = "/work";
    await click(".prj-create-location");
    assert.equal(titles.at(-1), "Choose where to create the project folder");
    assert.equal(
      document.querySelector(".prj-create-location")!.textContent,
      "/work/Research",
    );
    assert.ok(
      !document.querySelector(".prj-create-submit")!.hasAttribute("disabled"),
    );
    await change('input:not([type="file"])', "   ");
    await submit();
    assert.equal(saves.length, 0);
    await change('input:not([type="file"])', "  Research  ");
    await change("textarea", "  Be concise.  ");
    const file = { name: "notes.txt", size: 5, lastModified: 1 } as File;
    const drop = () =>
      act(() => {
        const event = new window.Event("drop", {
          bubbles: true,
          cancelable: true,
        });
        Object.assign(event, { dataTransfer: { files: [file] } });
        document.querySelector(".prj-create-drop")!.dispatchEvent(event);
      });
    await drop();
    await drop();
    assert.equal(document.querySelectorAll(".prj-create-file").length, 1);
    await click(".prj-create-file button");
    assert.equal(document.querySelectorAll(".prj-create-file").length, 0);
    await drop();
    await submit();
    assert.equal(errors.length, 1);
    assert.equal(saves[0].project.name, "Research");
    assert.equal(saves[0].project.instructions, "Be concise.");
    assert.equal(saves[0].creation.location, "/work");
    assert.deepEqual(saves[0].creation.files, [file]);
    assert.ok(
      !document.querySelector(".prj-create-submit")!.hasAttribute("disabled"),
    );
    failed = false;
    await submit();
    assert.equal(saves.length, 2);
    await click(".prj-create-back");
    await click(".prj-create-option:last-child");
    assert.equal(
      document.querySelector("h2")!.textContent,
      "Use an existing folder",
    );
    assert.equal(document.querySelector("textarea"), null);
    folder = "/work/Garden";
    await click(".prj-create-location");
    assert.equal(titles.at(-1), "Choose a folder for the project");
    assert.equal(
      document.querySelector<HTMLInputElement>('input:not([type="file"])')!
        .value,
      "Garden",
    );
    await change('input:not([type="file"])', "My garden");
    folder = "/work/Other";
    await click(".prj-create-location");
    assert.equal(
      document.querySelector<HTMLInputElement>('input:not([type="file"])')!
        .value,
      "My garden",
    );
    await submit();
    assert.equal(saves.at(-1)!.project.cwd, "/work/Other");
    assert.equal(saves.at(-1)!.creation.location, undefined);
    assert.deepEqual(saves.at(-1)!.creation.files, []);
    await click(".prj-create-back");
    await click(".prj-create-option:nth-child(2)");
    assert.equal(document.querySelector("h2")!.textContent, "Import a project");
    assert.match(
      document.querySelector(".prj-create-description")!.textContent!,
      /Changes in Cowork won’t affect/,
    );
    assert.equal(document.querySelector(".prj-create-location"), null);
    await submit();
    const beforeImport = saves.length;
    await change('[role="combobox"]', "   ");
    assert.deepEqual(
      Array.from(
        document.querySelectorAll('[role="option"]'),
        (node) => node.textContent,
      ),
      ["Research", "Garden"],
    );
    await change('[role="combobox"]', "missing");
    assert.match(
      document.querySelector(".prj-import-results")!.textContent!,
      /No matching projects/,
    );
    await change('[role="combobox"]', "rese");
    await click('[role="option"]');
    assert.equal(
      document.querySelector<HTMLInputElement>(".prj-create-field > input")!
        .value,
      "Research",
    );
    assert.match(
      document.querySelector(".prj-import-preview")!.textContent!,
      /Be concise\.1 document/,
    );
    await change(".prj-create-field > input", "Combined");
    await change('[role="combobox"]', "garden");
    await click('[role="option"]');
    assert.equal(document.querySelectorAll(".prj-import-selected").length, 2);
    assert.equal(
      document.querySelectorAll(".prj-import-preview-name").length,
      2,
    );
    assert.equal(
      document.querySelector<HTMLInputElement>(".prj-create-field > input")!
        .value,
      "Combined",
    );
    await change('[role="combobox"]', " ");
    assert.match(
      document.querySelector(".prj-import-results")!.textContent!,
      /No Chat projects to import/,
    );
    await click(".prj-import-selected button");
    assert.equal(document.querySelectorAll(".prj-import-selected").length, 1);
    folder = null;
    await click(".prj-create-location");
    await submit();
    assert.equal(saves.length, beforeImport);
    folder = "/work";
    await click(".prj-create-location");
    assert.equal(titles.at(-1), "Choose where to create the project folder");
    assert.equal(
      document.querySelector(".prj-create-location")!.textContent,
      "/work/Combined",
    );
    failed = true;
    await submit();
    assert.deepEqual(saves.at(-1)!.creation, {
      location: "/work",
      files: [],
      projectIds: ["chat-b"],
    });
    assert.ok(
      !document.querySelector(".prj-create-submit")!.hasAttribute("disabled"),
    );
    failed = false;
    await submit();
    assert.equal(saves.length, beforeImport + 2);
    await click(".prj-create-back");
    await click(".prj-create-option:nth-child(2)");
    assert.equal(document.querySelectorAll(".prj-import-selected").length, 0);
  } finally {
    await act(() => root.unmount());
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

test("creation creates a child folder and copies files without traversal, overwrites, or partial batches", () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "claudex-project-create-"),
  );
  try {
    for (const name of [
      "",
      ".",
      "..",
      "../escape",
      "nested/name",
      "nested\\name",
    ])
      assert.throws(() => createProjectFolder(root, name));
    const folder = createProjectFolder(root, "Research");
    assert.equal(folder, path.join(root, "Research"));
    assert.ok(fs.statSync(folder).isDirectory());
    assert.throws(() => createProjectFolder(root, "Research"));
    const file = { name: "notes.txt", data: new TextEncoder().encode("hello") };
    copyProjectCreationFiles(folder, [file]);
    assert.equal(
      fs.readFileSync(path.join(folder, file.name), "utf8"),
      "hello",
    );
    assert.throws(() =>
      copyProjectCreationFiles(folder, [{ ...file, name: "../escape" }]),
    );
    assert.throws(() =>
      copyProjectCreationFiles(folder, [{ ...file, name: "new.txt" }, file]),
    );
    assert.deepEqual(fs.readdirSync(folder), ["notes.txt"]);
    assert.equal(
      fs.readFileSync(path.join(folder, file.name), "utf8"),
      "hello",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

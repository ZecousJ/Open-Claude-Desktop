import test from "node:test";
import assert from "node:assert/strict";
import { act, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import type { Project } from "../../shared/types";
import { projectKind } from "../../shared/project-kind";
import { removeProjectFolder } from "../../shared/project-folders";
import { importableChatProjects } from "../../shared/project-import";
import {
  ProjectsPage,
  projectSortMenuEntries,
} from "../../src/collections/projects/ProjectsPage";
import {
  projectGroups,
  storedProjectGrouping,
  storeProjectGrouping,
} from "../../src/collections/projects/project-list";
import { ProjectOverview } from "../../src/collections/projects/ProjectOverview";
import { HostContext } from "../../src/host/HostContext";
import { desktopHost } from "../../shared/host";

const chat: Project = {
  id: "chat",
  name: "Chat",
  description: "",
  instructions: "",
  createdAt: 1,
};
const local: Project = {
  ...chat,
  id: "local",
  name: "Local",
  cwd: "/work/project",
};
const code: Project = {
  ...chat,
  id: "code",
  name: "Code",
  environment: { kind: "ssh", hostId: "host" },
};

test("legacy project types migrate by folder/environment, explicit kinds survive folder removal", () => {
  assert.equal(projectKind(chat), "chat");
  assert.equal(projectKind(local), "local");
  assert.equal(projectKind(code), "code");
  assert.equal(
    projectKind({ ...local, environment: { kind: "local" } }),
    "local",
  );
  const removed = removeProjectFolder(local, local.cwd!);
  assert.equal(removed.kind, "local");
  assert.equal(removed.cwd, undefined);
  assert.deepEqual(importableChatProjects([chat, code, removed]), [chat]);
});

test("grouping preserves sort order inside nonempty Chat, Code, Local lists; disabling preserves the flat order", () => {
  const projects = [local, code, chat, { ...local, id: "local2" }];
  assert.deepEqual(projectGroups(projects, false), [
    { label: "Projects", projects },
  ]);
  assert.deepEqual(
    projectGroups(projects, true).map((group) => [
      group.label,
      group.projects.map((project) => project.id),
    ]),
    [
      ["Projects", ["chat"]],
      ["Code projects", ["code"]],
      ["Local projects", ["local", "local2"]],
    ],
  );
  assert.deepEqual(
    projectGroups([local], true).map((group) => group.label),
    ["Local projects"],
  );
});

test("sort menu hides grouping when unavailable and otherwise exposes an enabled checkbox after a separator", () => {
  let toggled = false;
  let sorted = "";
  const plain = projectSortMenuEntries("updated", (value) => {
    sorted = value;
  });
  assert.equal(plain.length, 3);
  assert.ok(
    plain.every((entry) => "label" in entry && entry.label !== "Group by type"),
  );
  const name = plain[2];
  if ("onSelect" in name) name.onSelect();
  assert.equal(sorted, "name");
  const grouped = projectSortMenuEntries("name", () => {}, {
    checked: true,
    onSelect: () => {
      toggled = true;
    },
  });
  assert.deepEqual(grouped[3], { separator: true });
  const checkbox = grouped[4];
  assert.ok("label" in checkbox);
  assert.equal(checkbox.label, "Group by type");
  assert.equal(checkbox.checkedRole, "checkbox");
  assert.equal(checkbox.checked, true);
  assert.notEqual(checkbox.disabled, true);
  checkbox.onSelect();
  assert.equal(toggled, true);
});

test("grouping is persisted and renders separate accessible lists without empty type sections", () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    },
  });
  try {
    assert.equal(storedProjectGrouping(), false);
    storeProjectGrouping(true);
    assert.equal(storedProjectGrouping(), true);
    const html = renderToStaticMarkup(
      createElement(ProjectsPage, {
        projects: [local, code, chat],
        conversations: [],
        onNewProject() {},
        onEditProject() {},
        onDeleteProject() {},
        onArchiveProject() {},
        onOpenConversation() {},
        renderComposer: () => null,
        onSaveProject: async () => {},
        onChooseFolder: async () => null,
        onScheduled() {},
      }),
    );
    const { document } = parseHTML(html);
    assert.deepEqual(
      [...document.querySelectorAll(".prj-grid")].map((list) =>
        list.getAttribute("aria-label"),
      ),
      ["Projects", "Code projects", "Local projects"],
    );
    assert.deepEqual(
      [...document.querySelectorAll(".prj-group-heading")].map(
        (heading) => heading.textContent,
      ),
      ["Code", "Local"],
    );
    assert.equal(document.querySelectorAll("[data-primary]").length, 3);
    storeProjectGrouping(false);
    assert.equal(storedProjectGrouping(), false);
  } finally {
    if (previous) Object.defineProperty(globalThis, "localStorage", previous);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
});

test("the live rail puts Memory after Instructions for Cowork, before Instructions for Chat, and folders only in Cowork", async () => {
  const { window, document } = parseHTML(
    "<html><body><main></main></body></html>",
  );
  Object.assign(window, {
    desktop: {
      memoryStatus: async () => ({
        available: true,
        prefs: { generate: true },
      }),
      memoryDoc: async () => null,
      listProjectKnowledge: async () => ({
        files: [],
        bytes: 0,
        limit: 100000000,
        fileLimit: 10000000,
      }),
      systemState: async () => ({}),
      onEvent: () => () => {},
    },
  });
  const globals = {
    window,
    document,
    Node: window.Node,
    HTMLElement: window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(
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
  const render = async (project: Project) => {
    await act(async () =>
      root.render(
        createElement(
          HostContext.Provider,
          { value: desktopHost },
          createElement(ProjectOverview, {
            project,
            chats: [],
            composer: null,
            menuOpen: false,
            onBack() {},
            onMenu() {},
            onSave: async () => {},
            onScheduled() {},
            onOpenConversation() {},
          }),
        ),
      ),
    );
    return [...document.querySelectorAll(".prj-overview-side h2")].map(
      (heading) => heading.textContent,
    );
  };
  try {
    assert.deepEqual(await render(local), [
      "Instructions",
      "Memory",
      "Context",
      "Folders",
      "Scheduled",
    ]);
    assert.deepEqual(await render(chat), [
      "Memory",
      "Instructions",
      "Context",
      "Scheduled",
    ]);
  } finally {
    await act(() => root.unmount());
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

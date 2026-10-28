import test from "node:test";
import assert from "node:assert/strict";
import type { MemoryStatus } from "../../shared/memory-api";
import {
  capacityReason,
  knowledgeFull,
} from "../../src/collections/projects/ProjectKnowledge";
import { textSaveError } from "../../src/collections/projects/KnowledgeDialogs";
import type { Conversation, Project } from "../../shared/types";
import {
  folderName,
  projectCardTime,
  projectChanged,
  projectChats,
  projectDate,
  projectUpdatedAt,
  storedProjectSort,
  storeProjectSort,
  visibleProjects,
} from "../../src/collections/projects/project-list";
import {
  clearProjectRequest,
  onProjectRequest,
  projectRequest,
  requestProject,
} from "../../src/collections/open-requests";
import {
  projectMemoryEmpty,
  projectMemoryPreview,
  projectMemoryState,
  flattenMemory,
  showsProjectMemory,
} from "../../src/memory/project-memory";

const project = (
  id: string,
  name: string,
  createdAt: number,
  description = "",
): Project => ({
  id,
  name,
  description,
  instructions: "",
  createdAt,
});
const chat = (
  id: string,
  projectId: string | undefined,
  updatedAt: number,
  extra: Partial<Conversation> = {},
) =>
  ({
    id,
    title: id,
    mode: "chat",
    providerId: "p",
    model: "m",
    pinned: false,
    archived: false,
    createdAt: updatedAt,
    updatedAt,
    turns: [],
    projectId,
    ...extra,
  }) as Conversation;

const projects = [
  project("a", "Website", 10, "Marketing pages"),
  project("b", "Books", 30),
  project("c", "arm research", 20),
];
const chats = [
  chat("x", "a", 50),
  chat("y", "c", 40),
  chat("z", "a", 45, { archived: true }),
  chat("w", undefined, 99),
];

test("projects sort by last activity, creation or name, and search name and description", () => {
  const names = (rows: Project[]) => rows.map((p) => p.name);
  assert.equal(projectUpdatedAt(projects[0], chats), 50);
  assert.equal(
    projectUpdatedAt(projects[1], chats),
    30,
    "no chats: when it was made",
  );
  assert.deepEqual(names(visibleProjects(projects, chats, "", "updated")), [
    "Website",
    "arm research",
    "Books",
  ]);
  assert.deepEqual(names(visibleProjects(projects, chats, "", "created")), [
    "Books",
    "arm research",
    "Website",
  ]);
  assert.deepEqual(names(visibleProjects(projects, chats, "", "name")), [
    "arm research",
    "Books",
    "Website",
  ]);
  assert.deepEqual(
    names(visibleProjects(projects, chats, "marketing", "name")),
    ["Website"],
  );
});

test("a project's chats list newest first with archived ones last", () => {
  assert.deepEqual(
    projectChats(projects[0], chats).map((c) => c.id),
    ["x", "z"],
  );
  assert.equal(projectDate(new Date(2025, 2, 8).getTime()), "Mar 8, 2025");
});

test("a project asked for by search opens on a mounted page or waits for the next one", () => {
  requestProject("a");
  assert.equal(projectRequest(), "a");
  assert.equal(projectRequest(), "a", "reading does not use it up");
  clearProjectRequest();
  assert.equal(projectRequest(), undefined);
  const opened: (string | undefined)[] = [];
  const stop = onProjectRequest((id) => opened.push(id));
  requestProject("b");
  assert.deepEqual(opened, ["b"]);
  assert.equal(projectRequest(), undefined, "a showing page takes it at once");
  stop();
  requestProject("c");
  assert.equal(projectRequest(), "c");
  clearProjectRequest();
});

test("the project Memory section shows only while memory is usable and Generate is on", () => {
  const status = (extra: Partial<MemoryStatus> = {}): MemoryStatus => ({
    available: true,
    allowed: { searchChats: true, generate: true },
    prefs: { searchChats: true, generate: true },
    synthesizing: false,
    ...extra,
  });
  assert.equal(showsProjectMemory(undefined), false);
  assert.equal(showsProjectMemory(status()), true);
  assert.equal(
    showsProjectMemory(
      status({ prefs: { searchChats: true, generate: false } }),
    ),
    false,
  );
  for (const reason of ["offline", "policy", "server", "unsupported"] as const)
    assert.equal(
      showsProjectMemory(status({ available: false, reason })),
      false,
      reason,
    );
  const doc = {
    content: "Uses Astro.",
    updatedAt: 0,
    source: "generated" as const,
    revision: 1,
    edits: [],
  };
  assert.equal(projectMemoryPreview(doc), "Uses Astro.");
  assert.equal(projectMemoryPreview(null), projectMemoryEmpty);
  assert.equal(
    projectMemoryPreview({ ...doc, content: " \n" }),
    projectMemoryEmpty,
  );
  // The reference design (`memoryAfterAFew`).
  assert.equal(
    projectMemoryEmpty,
    "Project memory will show here after a few chats.",
  );
  // Loading, failed (Try again), empty, or the memory with Edit; memory
  // already read stays when a later read fails.
  assert.equal(projectMemoryState(undefined, false), "loading");
  assert.equal(projectMemoryState(undefined, true), "failed");
  assert.equal(projectMemoryState(null, false), "empty");
  assert.equal(projectMemoryState({ ...doc, content: " " }, false), "empty");
  assert.equal(projectMemoryState(doc, false), "memory");
  assert.equal(projectMemoryState(doc, true), "memory");
});

test("a project's card shows its creation date when sorted by it, and search reaches the folder", () => {
  const withFolder: Project = { ...projects[0], cwd: "/Users/me/Sites/site" };
  assert.equal(projectCardTime(withFolder, chats, "updated"), 50);
  assert.equal(projectCardTime(withFolder, chats, "created"), 10);
  assert.equal(folderName("/Users/me/Sites/site/"), "site");
  assert.equal(folderName("C:\\Work\\notes"), "notes");
  assert.deepEqual(
    visibleProjects([withFolder, projects[1]], chats, "sites", "name").map(
      (p) => p.id,
    ),
    ["a"],
  );
});

test("the chosen sort is remembered, and an unreadable store means the default", () => {
  const values = new Map<string, string>();
  (globalThis as any).localStorage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
  };
  try {
    assert.equal(storedProjectSort(), "updated");
    storeProjectSort("name");
    assert.equal(storedProjectSort(), "name");
    values.set("claudex.projects.sort", "bogus");
    assert.equal(storedProjectSort(), "updated");
  } finally {
    delete (globalThis as any).localStorage;
  }
  assert.equal(storedProjectSort(), "updated");
  storeProjectSort("created");
});

test("project details detect changes to the saved fields", () => {
  const initial = { ...projects[0], instructions: "be brief" };
  assert.equal(projectChanged(initial, { ...initial }), false);
  assert.equal(projectChanged(initial, { ...initial, name: "Site" }), true);
  assert.equal(
    projectChanged(initial, { ...initial, description: "More" }),
    true,
  );
  assert.equal(projectChanged(initial, { ...initial, cwd: "" }), false);
  assert.equal(projectChanged(initial, { ...initial, cwd: "/w" }), true);
});

test("a full project turns + off with the live reason; a failed Add text says why", () => {
  const files = { files: [], fileLimit: 10 };
  assert.equal(knowledgeFull(undefined), false);
  assert.equal(knowledgeFull({ ...files, bytes: 99, limit: 100 }), false);
  assert.equal(knowledgeFull({ ...files, bytes: 100, limit: 100 }), true);
  assert.match(capacityReason, /^Project knowledge at capacity\./);
  assert.equal(
    textSaveError(new Error("Project files can be up to 10 MB.")).message,
    "Project files can be up to 10 MB.",
  );
  assert.equal(textSaveError("x").message, "Error saving text content");
});

// `npm test` runs *.test.ts only: the Settings → Memory page's tests
// (JSX, so .tsx) run from here.
await import("../settings/settings-memory.test.tsx");

test("pinned projects lead every sort; archived ones only show on their tab", () => {
  const names = (rows: Project[]) => rows.map((p) => p.name);
  const marked = projects.map((p) =>
    p.name === "Books"
      ? { ...p, pinned: true }
      : p.name === "Website"
        ? { ...p, archivedAt: 1 }
        : p,
  );
  assert.deepEqual(names(visibleProjects(marked, chats, "", "name")), [
    "Books",
    "arm research",
  ]);
  assert.deepEqual(
    names(visibleProjects(marked, chats, "", "name", "archived")),
    ["Website"],
  );
});

// live/official-projects.txt:9-13: title anchors and separate pin/overflow actions.
test("web project cards retain native links with separate unpin and sample controls", async () => {
  const { createElement } = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { parseHTML } = await import("linkedom");
  const { ProjectsPage } =
    await import("../../src/collections/projects/ProjectsPage");
  const { HostContext } = await import("../../src/host/HostContext");
  const { webHost } = await import("../../shared/host");
  const html = renderToStaticMarkup(
    createElement(
      HostContext.Provider,
      { value: webHost },
      createElement(ProjectsPage, {
        projects: [
          {
            ...project("a / b", "Pinned example", 1, "Two line description"),
            pinned: true,
            isStarterProject: true,
          },
        ],
        conversations: [],
        onNewProject() {},
        onEditProject() {},
        onDeleteProject() {},
        onArchiveProject() {},
        onOpenConversation() {},
        renderComposer() {
          return null;
        },
        async onSaveProject() {},
        async onChooseFolder() {
          return null;
        },
        onScheduled() {},
      }),
    ),
  );
  const { document } = parseHTML(html);
  const link = document.querySelector("a.prj-card-link");
  assert.equal(link?.getAttribute("href"), "/project/a%20%2F%20b");
  assert.equal(link?.textContent, "Pinned example");
  assert.ok(link?.hasAttribute("data-no-translate"));
  assert.ok(document.querySelector(".prj-card > span[data-no-translate]"));
  assert.equal(link?.querySelector("button"), null);
  const unpin = document.querySelector('button[aria-label="Unpin project"]');
  assert.ok(unpin);
  assert.equal(unpin.closest("a"), null);
  assert.ok(
    document.querySelector(
      'button[aria-label="More options for Pinned example"]',
    ),
  );
  assert.equal(
    document.querySelector(".prj-card-example")?.textContent,
    "Example project",
  );
  assert.ok(document.querySelector(".prj-card.has-description"));
});

test("the project page's memory reads as one plain line, without the markup", () => {
  assert.equal(
    flattenMemory(
      "# Notes\n- **Prefers** short _answers_\n1. Uses `npm`\n\nSee [the docs](https://x.test) and ![logo](a.png)",
    ),
    "Prefers short answers Uses npm See the docs and logo",
  );
  assert.equal(flattenMemory(undefined), "");
  assert.equal(flattenMemory("  "), "");
});

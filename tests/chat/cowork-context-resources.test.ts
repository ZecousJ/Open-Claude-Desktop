import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Conversation, Item } from "../../shared/types";
import {
  contextResources,
  resourceLocation,
} from "../../src/cowork/context-resources";
import { ProgressPanel } from "../../src/cowork/ProgressPanel";
import { ArtifactPresentation } from "../../src/artifacts/artifact-presentation";
import { AppContext, type AppController } from "../../src/app/AppContext";

const conversation = (items: Item[], prompt = "Task"): Conversation => ({
  id: "task",
  title: "Task",
  mode: "cowork",
  providerId: "p",
  model: "m",
  cwd: "/work",
  pinned: false,
  archived: false,
  createdAt: 0,
  updatedAt: 0,
  turns: [
    {
      id: "turn",
      prompt,
      items,
      attachments: [],
      status: "completed",
      createdAt: 0,
    },
  ],
});
const read = (...paths: string[]): Item => ({
  id: "read",
  type: "commandExecution",
  cwd: "/work",
  lifecycleStatus: "completed",
  commandActions: paths.map((path) => ({ type: "read", path })),
});
const call = (
  namespace: string,
  tool: string,
  args: object = {},
  result = "",
): Item => ({
  id: tool,
  type: "dynamicToolCall",
  namespace,
  tool,
  arguments: JSON.stringify(args),
  contentItems: [{ type: "inputText", text: result }],
  success: true,
});

test("resource paths normalize and choose the deepest selected folder without prefix collisions", () => {
  assert.deepEqual(
    resourceLocation(
      ["/", "/work", "/work/sub"],
      "/work/sub/./nested/../file.txt",
    ),
    { index: 2, relative: "file.txt" },
  );
  assert.equal(resourceLocation(["/work"], "/worker/a"), undefined);
  assert.deepEqual(
    resourceLocation(["C:\\Work"], "C:\\Work\\nested\\file.txt"),
    { index: 0, relative: "nested/file.txt" },
  );
});

test("context counts successful reads, custom commands, skills and instructions, not arbitrary shell executions", () => {
  const task = conversation(
    [
      read(
        "a.txt",
        "./a.txt",
        "sub/b.txt",
        "/home/.codex/skills/pdf/SKILL.md",
        "/home/.codex/prompts/review.md",
        "/work/AGENTS.md",
      ),
      { ...read("secret.txt"), lifecycleStatus: "failed" },
      {
        ...read("pending.txt"),
        status: "inProgress",
        lifecycleStatus: undefined,
      },
      { id: "shell", type: "commandExecution", command: "echo done" },
    ],
    "$pdf Summarize",
  );
  task.turns[0].coworkInstructions = {
    global: "Be concise",
    folder: "Use this project",
  };
  const { resources, scratchpad } = contextResources(task, [
    "/work",
    "/work/sub",
  ]);
  assert.deepEqual(resources.find((entry) => entry.id === "folder:0")?.paths, [
    "/work/a.txt",
  ]);
  assert.equal(resources.find((entry) => entry.id === "folder:1")?.count, 1);
  assert.equal(resources.filter((entry) => entry.kind === "skill").length, 1);
  assert.equal(resources.find((entry) => entry.kind === "skill")?.count, 1);
  assert.equal(resources.filter((entry) => entry.kind === "command").length, 1);
  assert.deepEqual(
    resources.find((entry) => entry.id === "instructions:global")?.details,
    ["Be concise"],
  );
  assert.deepEqual(
    resources.find((entry) => entry.id === "instructions:folder")?.details,
    ["Use this project"],
  );
  assert.ok(resources.some((entry) => entry.path === "/work/AGENTS.md"));
  assert.deepEqual(scratchpad, []);
});

test("search, connector, memory and browser summaries preserve counts and inspectable details", () => {
  const task = conversation([
    { id: "search1", type: "webSearch", query: "first" },
    {
      id: "search2",
      type: "webSearch",
      action: { type: "search", query: "second" },
    },
    {
      id: "fetch",
      type: "webSearch",
      action: { type: "openPage", url: "https://example.com/article" },
    },
    call("notion", "find"),
    call("notion", "update"),
    call(
      "claudex_memory",
      "memory_edits",
      { command: "view" },
      "Remembered preference",
    ),
    call(
      "claudex_memory",
      "memory_edits",
      { command: "replace" },
      "Updated preference",
    ),
    call(
      "claudex_browser",
      "navigate",
      { url: "https://example.com/", tabId: "tab-1" },
      "Opened https://example.com/ (tab-1).",
    ),
    call(
      "claudex_browser",
      "read_page",
      { tabId: "tab-1" },
      "https://example.com/ (tab-1)\nLink: https://not-visited.test/",
    ),
    call("claudex_browser", "navigate", {
      url: "https://other.test/",
      tabId: "tab-2",
    }),
    { ...call("notion", "failed"), success: false },
  ]);
  const { resources } = contextResources(task, ["/work"]);
  const resource = (id: string) => resources.find((entry) => entry.id === id)!;
  assert.equal(resource("search").count, 2);
  assert.deepEqual(resource("search").details, ["first", "second"]);
  assert.equal(resource("connector:notion").count, 2);
  assert.deepEqual(resource("connector:notion").details, ["find", "update"]);
  assert.deepEqual(resource("memory:read").details, ["Remembered preference"]);
  assert.equal(resource("memory:updated").updated, true);
  assert.equal(resource("browser:tabs").count, 2);
  assert.equal(resource("browser:sites").count, 2);
  assert.equal(resource("browser:pages").count, 3);
  assert.ok(!resource("browser:sites").details?.includes("not-visited.test"));
});

test("scratchpad contains working resources outside selected folders, excluding output history and internal configuration", () => {
  const task = conversation([
    read(
      "/tmp/note.txt",
      "/tmp/note.txt",
      "/tmp/output.txt",
      "/tmp/old.txt",
      "/home/.codex/config.toml",
      "/work/input.txt",
    ),
    {
      id: "generated",
      type: "commandExecution",
      generatedFiles: [
        {
          id: "output",
          path: "/tmp/output.txt",
          name: "output.txt",
          state: "deleted",
        },
        {
          id: "moved",
          path: "/tmp/new.txt",
          previousPath: "/tmp/old.txt",
          name: "new.txt",
          state: "ready",
        },
      ] as never,
    },
  ]);
  assert.deepEqual(
    contextResources(task, ["/work"]).scratchpad.map((entry) => entry.path),
    ["/tmp/note.txt"],
  );
});

test("the activity panel exposes browse, scratchpad and counts without message labels on normal files", () => {
  const task = conversation([
    read("/tmp/note.txt", "input.txt"),
    { id: "search", type: "webSearch", query: "query" },
    call("notion", "find"),
  ]);
  const html = renderToStaticMarkup(
    createElement(ProgressPanel, { conversation: task, onArtifact() {} }),
  );
  assert.match(html, /aria-label="Browse files"/);
  assert.match(html, /Scratchpad/);
  assert.match(html, /1 search/);
  assert.match(html, /1 tool call/);
  assert.match(html, /1 file read/);
  assert.doesNotMatch(html, /from a message/);
});

test("outputs retain unavailable files with preview copy and Show in Folder", () => {
  const presentation = new ArtifactPresentation();
  presentation.observe(conversation([]), false);
  const task = conversation([
    {
      id: "output",
      type: "fileChange",
      generatedFiles: [
        {
          id: "ready",
          path: "/work/ready.txt",
          name: "ready.txt",
          language: "text",
          operation: "create",
          state: "ready",
          content: "ready",
        },
        {
          id: "pending",
          path: "/work/pending.pdf",
          name: "pending.pdf",
          language: "pdf",
          operation: "create",
          state: "unavailable",
        },
      ],
    },
  ]);
  task.turns[0].status = "inProgress";
  presentation.observe(task, false);
  const html = renderToStaticMarkup(
    createElement(
      AppContext.Provider,
      {
        value: {
          artifactPresentation: { current: presentation },
        } as unknown as AppController,
      },
      createElement(ProgressPanel, { conversation: task, onArtifact() {} }),
    ),
  );
  assert.match(html, /Not available to preview yet/);
  assert.match(html, /aria-disabled="true"/);
  assert.match(html, /aria-label="Show in Folder"/);
  assert.match(html, /pending/);
});

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PreviewPages } from "../../electron/browser/preview-pages";
import { sessionDataConfirmation } from "../../src/browser/session-data";
import { RestoredPreview } from "../../src/browser/PreviewStatus";
import { splitProjectOutputs } from "../../src/collections/projects/ProjectOutputs";
import {
  reconcileDock,
  moveDockPane,
  paneAtEdge,
  type DockLayout,
} from "../../src/app/dock-layout";
import { tabShowsPage } from "../../src/browser/browser-model";
import type { BrowserTabState } from "../../shared/browser";
import type { Conversation } from "../../shared/types";
import { groupRuns, sessionRuns } from "../../src/runs/runs-model";
import type { Routine } from "../../shared/routines";
import type { RoutineRun } from "../../shared/routine-labels";

test("Runs loads the current session's scheduled task, not unrelated task histories", async () => {
  const runs: RoutineRun[] = [
    {
      id: "a",
      conversationId: "current",
      startedAt: 1,
      status: "completed",
      trigger: "schedule",
    },
    {
      id: "b",
      conversationId: "other",
      startedAt: 3,
      status: "running",
      trigger: "manual",
    },
    {
      id: "c",
      conversationId: "previous",
      startedAt: 2,
      status: "failed",
      trigger: "schedule",
    },
  ];
  const api = {
    listSchedules: async () => [{ id: "one" }, { id: "two" }] as Routine[],
    routineRuns: async (id: string) => (id === "one" ? [] : runs),
  };
  assert.equal((await sessionRuns("current", api))?.routine.id, "two");
  assert.equal(await sessionRuns("unrelated", api), undefined);
  const groups = groupRuns(runs);
  assert.deepEqual(
    groups.running.map((run) => run.id),
    ["b"],
  );
  assert.deepEqual(
    groups.completed.map((run) => run.id),
    ["c", "a"],
  );
  assert.deepEqual(
    runs.map((run) => run.id),
    ["a", "b", "c"],
  );
});

test("the preview session-data confirmations use the live bundle's exact copy and actions", () => {
  assert.deepEqual(sessionDataConfirmation(true), {
    title: "Clear session data?",
    body: "This will delete all saved cookies, local storage, and other session data for Launch servers in all workspaces.",
    confirm: "Clear data",
    danger: true,
  });
  assert.deepEqual(sessionDataConfirmation(false), {
    title: "Keep cookies?",
    body: "Session data such as cookies and local storage will be saved across server restarts. This can be useful for staying logged in during development.",
    confirm: "Enable",
    danger: false,
  });
});

test("last frames survive a host restart, stay account-scoped and can be dismissed", () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "claudex-preview-pages-"),
  );
  try {
    const pages = new PreviewPages(directory, "account-a");
    const page = {
      url: "http://localhost:5173/",
      title: "App",
      jpegBase64: "anBlZw==",
      serverName: "web",
    };
    pages.set("conversation", page);
    assert.deepEqual(
      new PreviewPages(directory, "account-a").get("conversation"),
      page,
    );
    assert.equal(
      new PreviewPages(directory, "account-b").get("conversation"),
      undefined,
    );
    pages.set("conversation", undefined);
    assert.equal(
      new PreviewPages(directory, "account-a").get("conversation"),
      undefined,
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("last frames for deleted conversations are pruned from disk", () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "claudex-preview-pages-"),
  );
  try {
    const pages = new PreviewPages(directory, "account");
    const page = {
      url: "http://localhost:5173/",
      title: "App",
      jpegBase64: "anBlZw==",
    };
    pages.set("kept", page);
    pages.set("removed", page);
    pages.prune(new Set(["kept"]));
    const reloaded = new PreviewPages(directory, "account");
    assert.deepEqual(reloaded.get("kept"), page);
    assert.equal(reloaded.get("removed"), undefined);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("restored-page presentation uses the old frame and offers Restart and Show start page", () => {
  const tab: BrowserTabState = {
    id: "t",
    url: "http://localhost:5173/",
    title: "App",
    loading: false,
    stalled: false,
    canGoBack: false,
    canGoForward: false,
    restored: { jpegBase64: "anBlZw==", serverName: "web" },
  };
  const html = renderToStaticMarkup(
    createElement(RestoredPreview, {
      tab,
      busy: false,
      onRestart() {},
      onDismiss() {},
    }),
  );
  assert.match(html, /Showing the page from before the app closed\./);
  assert.match(html, /The last page this preview showed before the app closed/);
  assert.match(html, /Show start page/);
  assert.match(html, /Restart web/);
  assert.match(html, /data:image\/jpeg;base64,anBlZw==/);
  assert.equal(tabShowsPage(tab), false);
});

test("project outputs are project-scoped, pinned separately, and newest first", () => {
  const chats = [
    { id: "old", updatedAt: 1 },
    { id: "new", updatedAt: 2 },
  ] as Conversation[];
  const artifact = { name: "File", language: "text", content: "" };
  const sections = splitProjectOutputs(
    [
      { ...artifact, id: "old-file", conversationId: "old" },
      { ...artifact, id: "outside", conversationId: "other" },
      { ...artifact, id: "pin", conversationId: "old", pinned: true },
      { ...artifact, id: "new-file", conversationId: "new" },
    ],
    chats,
  );
  assert.deepEqual(
    sections.pinned.map((row) => row.id),
    ["pin"],
  );
  assert.deepEqual(
    sections.others.map((row) => row.id),
    ["new-file", "old-file"],
  );
});

test("pane moves preserve siblings and disable directions at the edge", () => {
  const layout: DockLayout = [["changes", "browser", "files"], ["terminal"]];
  assert.equal(paneAtEdge(layout, "changes", "top"), true);
  assert.equal(paneAtEdge(layout, "files", "bottom"), true);
  assert.equal(paneAtEdge(layout, "terminal", "right"), true);
  assert.equal(moveDockPane(layout, "terminal", "right"), layout);
  assert.deepEqual(moveDockPane(layout, "browser", "top"), [
    ["browser", "changes", "files"],
    ["terminal"],
  ]);
  assert.deepEqual(moveDockPane(layout, "changes", "bottom"), [
    ["browser", "files", "changes"],
    ["terminal"],
  ]);
  assert.deepEqual(moveDockPane(layout, "browser", "left"), [
    ["browser"],
    ["changes", "files"],
    ["terminal"],
  ]);
  assert.deepEqual(moveDockPane(layout, "browser", "right"), [
    ["changes", "files"],
    ["terminal"],
    ["browser"],
  ]);
  assert.deepEqual(
    reconcileDock(
      [["browser"], ["changes", "files"]],
      ["browser", "changes", "terminal"],
    ),
    [["browser"], ["changes"], ["terminal"]],
  );
  assert.deepEqual(layout, [["changes", "browser", "files"], ["terminal"]]);
});

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { registerHooks } from "node:module";
import type { Conversation, Project } from "../../shared/types";
import {
  formatSize,
  rangeStart,
  tallyHistory,
  type HistorySourceScan,
} from "../../shared/history-import";
import { exportArchive } from "../../electron/conversations/data-export";
import { HistoryImporter } from "../../electron/conversations/history-import";
import {
  importedConversation,
  importedProject,
  profileFolders,
  type HistoryStore,
} from "../../electron/conversations/history-archive";
import { defaultSettings } from "../../electron/store/store";
import { registerSettingsAccountHandlers } from "../../electron/ipc/settings-account";
import type { AppContext } from "../../electron/app/app-context";
import { availableNavGroups, tabAvailable } from "../../src/settings/nav";
import { desktopHost, webHost } from "../../shared/host";

registerHooks({
  load: (url, context, next) =>
    url.endsWith(".css")
      ? { format: "module", source: "", shortCircuit: true }
      : next(url, context),
});
const { countText, problemText, totalTally } =
  await import("../../src/settings/ImportDialog");
const { runCounts, runSourceName } =
  await import("../../src/settings/tabs/Import");

const day = 24 * 60 * 60 * 1000;
const conversation = (
  id: string,
  part: Partial<Conversation> = {},
): Conversation =>
  ({
    id,
    title: id,
    mode: "chat",
    providerId: "p",
    model: "m",
    pinned: false,
    archived: false,
    createdAt: 1,
    updatedAt: 1000,
    turns: [{ id: `${id}-t`, prompt: "hi", status: "completed", items: [] }],
    ...part,
  }) as unknown as Conversation;
const project = (id: string, part: Partial<Project> = {}): Project => ({
  id,
  name: id,
  description: "",
  instructions: "",
  createdAt: 1,
  ...part,
});

function folder(prefix = "claudex-import-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
function store(
  conversations: Conversation[] = [],
  projects: Project[] = [],
): HistoryStore & { flushed: number } {
  const root = folder("claudex-profile-");
  return {
    root,
    conversations,
    projects,
    flushed: 0,
    flush() {
      this.flushed += 1;
    },
  };
}
/** A copied profile folder: conversations.json and projects.json. */
function profile(
  conversations: Conversation[],
  projects: Project[] = [],
  parent = folder(),
) {
  fs.mkdirSync(parent, { recursive: true });
  fs.writeFileSync(
    path.join(parent, "conversations.json"),
    JSON.stringify(conversations),
  );
  fs.writeFileSync(
    path.join(parent, "projects.json"),
    JSON.stringify(projects),
  );
  return parent;
}

test("a conversation of another computer keeps its history and drops what was that computer's", () => {
  const folderHere = folder();
  const kept = importedConversation(
    conversation("a", {
      threadId: "thread",
      sidebarRank: 3,
      unread: true,
      cwd: "/definitely/not/here",
      environment: { kind: "ssh", hostId: "h" } as never,
      turns: [
        { id: "t", prompt: "x", status: "inProgress", items: [] },
      ] as never,
      savedBranches: [
        { id: "b", threadId: "bt", turns: [], createdAt: 1 },
      ] as never,
    }),
  )!;
  assert.equal(kept.id, "a");
  for (const key of ["threadId", "sidebarRank", "unread", "cwd", "environment"])
    assert.equal(key in kept, false, key);
  assert.equal(kept.turns[0].status, "interrupted");
  assert.equal("threadId" in kept.savedBranches![0], false);
  // A working folder that exists here stays.
  assert.equal(
    importedConversation(conversation("b", { cwd: folderHere }))?.cwd,
    folderHere,
  );
  // Not conversations: no id that is safe in a path, no turns, incognito.
  for (const bad of [
    null,
    "text",
    conversation("../x"),
    { ...conversation("c"), turns: undefined },
    { ...conversation("d"), mode: "voice" },
    conversation("e", { incognito: true }),
  ])
    assert.equal(importedConversation(bad), undefined);
  assert.equal(importedProject({ id: "p", name: " " }), undefined);
  assert.deepEqual(importedProject({ id: "p", name: "N", cwd: "/nope" }), {
    id: "p",
    name: "N",
    description: "",
    instructions: "",
    createdAt: 0,
  });
});

test("a data folder is found at its root, under profiles, or inside a backup of it", () => {
  const root = folder();
  assert.deepEqual(profileFolders(root), []);
  const direct = profile([conversation("a")], [], path.join(root, "direct"));
  assert.deepEqual(profileFolders(direct), [direct]);
  const userData = folder();
  const one = profile(
    [conversation("a")],
    [],
    path.join(userData, "profiles", "u1"),
  );
  const two = profile(
    [conversation("b")],
    [],
    path.join(userData, "profiles", "u2"),
  );
  assert.deepEqual(profileFolders(userData).sort(), [one, two].sort());
  const backup = folder();
  fs.cpSync(userData, path.join(backup, "Claudex"), { recursive: true });
  assert.equal(profileFolders(backup).length, 2);
});

test("importing a folder copies what is new once, by id, and says what it did", async () => {
  const here = store(
    [conversation("have", { updatedAt: 5000 })],
    [project("p-have")],
  );
  const there = profile(
    [
      conversation("have", { updatedAt: 5000 }),
      conversation("new1", { updatedAt: 9000, projectId: "p-new" }),
      conversation("new2", { updatedAt: 8000, projectId: "p-gone" }),
      conversation("old", { updatedAt: 10 }),
    ],
    [
      project("p-have"),
      project("p-new", { createdAt: 10 }),
      project("p-recent", { createdAt: 7000 }),
      project("p-old", { createdAt: 5 }),
    ],
  );
  const importer = new HistoryImporter(here);
  const added = await importer.add("folder", there);
  assert.ok("source" in added);
  const source = (added as { source: { id: string } }).source as never as {
    id: string;
    kind: string;
    scan: HistorySourceScan;
  };
  assert.equal(source.kind, "folder");
  assert.deepEqual(
    source.scan.conversations.map((c) => [c.id, c.alreadyImported]),
    [
      ["have", true],
      ["new1", false],
      ["new2", false],
      ["old", false],
    ],
  );
  // Adding it again is the same location.
  const again = (await importer.add("folder", there)) as typeof added;
  assert.equal(
    (again as typeof added & { source: { id: string } }).source.id,
    source.id,
  );
  assert.equal((await importer.sources()).length, 1);

  // Everything: the three new conversations; the projects they use and ones
  // created in range; "p-gone" does not exist anywhere, so it is dropped.
  const result = await importer.run([source.id], 0, 20000);
  assert.deepEqual(result, {
    ok: true,
    imported: { conversations: 3, projects: 3 },
    skipped: 1,
    failed: 0,
  });
  assert.deepEqual(here.conversations.map((c) => c.id).sort(), [
    "have",
    "new1",
    "new2",
    "old",
  ]);
  assert.equal(
    here.conversations.find((c) => c.id === "new2")?.projectId,
    undefined,
  );
  assert.equal(
    here.conversations.find((c) => c.id === "new1")?.projectId,
    "p-new",
  );
  assert.deepEqual(here.projects.map((p) => p.id).sort(), [
    "p-have",
    "p-new",
    "p-old",
    "p-recent",
  ]);
  assert.ok(here.flushed > 0);

  // Running it again adds nothing and creates no second history entry.
  const second = await importer.run([source.id], 0, 30000);
  assert.deepEqual(second.imported, { conversations: 0, projects: 0 });
  assert.equal(second.skipped, 4);
  const history = importer.history();
  assert.equal(history.length, 1);
  assert.deepEqual(history[0].counts, { conversations: 3, projects: 3 });
  assert.deepEqual(history[0].source, {
    label: path.basename(there),
    kind: "folder",
  });
});

test("the range keeps older conversations out, and the tally says so", async () => {
  const now = 300 * day;
  const there = profile(
    [
      conversation("recent", { updatedAt: now - day }),
      conversation("older", { updatedAt: now - 50 * day }),
      conversation("oldest", { updatedAt: now - 200 * day }),
    ],
    [],
  );
  const here = store([conversation("recent-here", { updatedAt: now })]);
  const importer = new HistoryImporter(here);
  const { source } = (await importer.add("folder", there)) as {
    source: { id: string; scan: HistorySourceScan };
  };
  const tally = (since: number) => tallyHistory(source.scan, since);
  assert.deepEqual(
    [
      tally(rangeStart("30d", now)).conversations,
      tally(rangeStart("30d", now)).outOfWindow,
    ],
    [1, 2],
  );
  assert.equal(tally(rangeStart("90d", now)).conversations, 2);
  assert.equal(tally(rangeStart("all", now)).conversations, 3);
  assert.ok(tally(0).sizeBytes > 0);
  const result = await importer.run([source.id], rangeStart("30d", now), now);
  assert.equal(result.imported.conversations, 1);
  assert.deepEqual(here.conversations.map((c) => c.id).sort(), [
    "recent",
    "recent-here",
  ]);
  // Once copied, the same range counts it as already here.
  const after = (await importer.sources())[0].scan!;
  assert.equal(tallyHistory(after, rangeStart("30d", now)).alreadyImported, 1);
  assert.equal(tallyHistory(after, rangeStart("30d", now)).conversations, 0);
});

test("an export saved by Export data is a location too", async () => {
  const exporting = [
    conversation("from-zip", { updatedAt: 7000 }),
    conversation("hidden", { incognito: true }),
  ];
  const archive = exportArchive({
    root: folder(),
    conversations: exporting,
    projects: [project("zp")],
    settings: structuredClone(defaultSettings),
  });
  const file = path.join(folder(), "claudex-export-2026-10-12.zip");
  fs.writeFileSync(file, archive);
  const here = store();
  const importer = new HistoryImporter(here);
  const added = (await importer.add("file", file)) as {
    source: { id: string; kind: string; label: string };
  };
  assert.equal(added.source.kind, "file");
  assert.equal(added.source.label, "claudex-export-2026-10-12.zip");
  const result = await importer.run([added.source.id], 0);
  assert.deepEqual(result.imported, { conversations: 1, projects: 1 });
  assert.equal(here.conversations[0].id, "from-zip");
  assert.equal(importer.history()[0].source.kind, "file");
  assert.equal(runSourceName(importer.history()[0]), "Claudex export");
});

test("a location that cannot be used says why and is not kept", async () => {
  const here = store();
  const importer = new HistoryImporter(here);
  // This app's own data folder, directly or inside a backup of it.
  assert.deepEqual(await importer.add("folder", here.root), {
    problem: "self",
  });
  profile([conversation("mine")], [], here.root);
  assert.deepEqual(await importer.add("folder", here.root), {
    problem: "self",
  });
  assert.deepEqual(await importer.add("folder", folder()), {
    problem: "unknown-shape",
  });
  const text = path.join(folder(), "notes.zip");
  fs.writeFileSync(text, "not a zip");
  assert.deepEqual(await importer.add("file", text), { problem: "unreadable" });
  assert.deepEqual(await importer.add("folder", "/no/such/folder"), {
    problem: "unreadable",
  });
  // A folder holding something else than a list.
  const odd = folder();
  fs.writeFileSync(path.join(odd, "conversations.json"), "{}");
  assert.deepEqual(await importer.add("folder", odd), {
    problem: "unknown-shape",
  });
  assert.deepEqual(await importer.sources(), []);
});

test("a location is forgotten when removed, and one that vanished reads as unreadable", async () => {
  const importer = new HistoryImporter(store());
  const there = profile([conversation("a")]);
  const { source } = (await importer.add("folder", there)) as {
    source: { id: string };
  };
  fs.rmSync(there, { recursive: true });
  const [listed] = await importer.sources();
  assert.equal(listed.problem, "unreadable");
  assert.equal(listed.scan, null);
  importer.removeSource(source.id);
  assert.deepEqual(await importer.sources(), []);
});

test("removing an import deletes what it added, warns about used conversations, and keeps running ones", async () => {
  const here = store([conversation("mine", { updatedAt: 5 })]);
  const there = profile(
    [
      conversation("a", { updatedAt: 100, projectId: "p" }),
      conversation("b", { updatedAt: 100, projectId: "p" }),
      conversation("c", { updatedAt: 100 }),
    ],
    [project("p")],
  );
  const importer = new HistoryImporter(here);
  const { source } = (await importer.add("folder", there)) as {
    source: { id: string };
  };
  await importer.run([source.id], 0, 1000);
  const [run] = importer.history();
  // "a" was used after the import; "c" is answering.
  here.conversations.find((c) => c.id === "a")!.updatedAt = 2000;
  here.conversations.find((c) => c.id === "c")!.turns[0].status = "inProgress";
  here.conversations.find((c) => c.id === "mine")!.projectId = "p";
  assert.deepEqual(importer.removePreview(run.runId), {
    conversations: 3,
    projects: 1,
    modifiedSinceImport: 1,
  });
  const forgotten: string[] = [];
  const outcome = await importer.remove(run.runId, (id) => {
    forgotten.push(id);
  });
  // Two conversations and the project went; the running one stayed.
  assert.deepEqual(outcome, { removed: 3, failed: 1 });
  assert.deepEqual(forgotten.sort(), ["a", "b"]);
  assert.deepEqual(here.conversations.map((c) => c.id).sort(), ["c", "mine"]);
  assert.deepEqual(here.projects, []);
  assert.equal(
    here.conversations.find((c) => c.id === "mine")?.projectId,
    undefined,
  );
  // What is left of the run stays in the history until it can go.
  assert.deepEqual(
    importer.history().map((r) => r.counts),
    [{ conversations: 1, projects: 0 }],
  );
  here.conversations.find((c) => c.id === "c")!.turns[0].status = "completed";
  assert.deepEqual(await importer.remove("*"), { removed: 1, failed: 0 });
  assert.deepEqual(importer.history(), []);
  assert.deepEqual(
    here.conversations.map((c) => c.id),
    ["mine"],
  );
});

test("the import calls only take ids from the window, and say so to the web", async () => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const here = store();
  const pushed: unknown[] = [];
  registerSettingsAccountHandlers((name, fn) => handlers.set(name, fn), {
    store: here,
    onAccountDeactivating: () => () => {},
    push: (event: unknown) => pushed.push(event),
  } as unknown as AppContext);
  for (const name of [
    "importSources",
    "importAddSource",
    "importRemoveSource",
    "importRun",
    "importHistory",
    "importRemovePreview",
    "importRemove",
  ])
    assert.ok(handlers.has(name), name);
  const there = profile([conversation("a", { updatedAt: 9 })]);
  const { source } = (await new HistoryImporter(here).add("folder", there)) as {
    source: { id: string };
  };
  // A path is not an id.
  const run = handlers.get("importRun")!;
  await assert.rejects(async () => run([there], 0));
  assert.deepEqual(await run(["no-such-id"], 0), {
    ok: true,
    imported: { conversations: 0, projects: 0 },
    skipped: 0,
    failed: 0,
  });
  assert.equal(pushed.length, 0);
  await assert.rejects(async () => run("x", 0));
  await assert.rejects(async () => run([source.id], -1));
  const result = (await run([source.id], 0)) as {
    imported: { conversations: number };
  };
  assert.equal(result.imported.conversations, 1);
  assert.deepEqual(pushed, [{ type: "resync" }]);
  assert.equal(
    ((await handlers.get("importHistory")!()) as unknown[]).length,
    1,
  );
});

test("Import offers skills on the web and history on the desktop", () => {
  assert.equal(tabAvailable("import", desktopHost, false), true);
  assert.equal(tabAvailable("import", webHost, false), true);
  const desktopIds = availableNavGroups(desktopHost, false).flatMap((group) =>
    group.tabs.map((tab) => tab.id),
  );
  assert.ok(desktopIds.includes("import"));
});

test("counts read in the singular and sums add up", () => {
  assert.equal(
    countText(1, "{n} conversation", "{n} conversations"),
    "1 conversation",
  );
  assert.equal(
    countText(2, "{n} conversation", "{n} conversations"),
    "2 conversations",
  );
  assert.equal(
    runCounts({ conversations: 1, projects: 2 }),
    "1 conversation, 2 projects",
  );
  assert.equal(formatSize(512), "512 B");
  assert.equal(formatSize(2048), "2 KB");
  assert.equal(formatSize(3 * 1024 * 1024), "3.0 MB");
  const sum = totalTally([
    {
      conversations: 1,
      projects: 1,
      sizeBytes: 10,
      outOfWindow: 2,
      alreadyImported: 3,
    },
    null,
    {
      conversations: 4,
      projects: 0,
      sizeBytes: 5,
      outOfWindow: 0,
      alreadyImported: 0,
    },
  ]);
  assert.deepEqual(sum, {
    conversations: 5,
    projects: 1,
    sizeBytes: 15,
    outOfWindow: 2,
    alreadyImported: 3,
  });
  assert.match(problemText("self", "folder"), /own data folder/);
  assert.match(problemText("unknown-shape", "file"), /export/);
  assert.match(problemText("unreadable", "folder"), /folder/);
});

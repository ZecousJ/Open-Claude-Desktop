import test from "node:test";
import assert from "node:assert/strict";
import {
  codeOpenInEntries,
  titleMenuEntries,
} from "../../src/conversation/ConversationTitle";
import type { Conversation, Project } from "../../shared/types";
import { type MenuEntry } from "../../src/ui/Menu";
import { withCreateRow } from "../../src/ui/Submenu";

const project = (id: string, name: string): Project => ({
  id,
  name,
  description: "",
  instructions: "",
  createdAt: 1,
});
const conversation = (extra: Partial<Conversation>): Conversation => ({
  id: "c",
  title: "Title",
  mode: "chat",
  providerId: "p",
  model: "m",
  pinned: false,
  archived: false,
  createdAt: 1,
  updatedAt: 1,
  turns: [],
  ...extra,
});
const labels = (entries: MenuEntry[]) =>
  entries.map((e) => ("label" in e ? e.label : "—"));

function actions(log: string[]) {
  return {
    onPin: () => log.push("pin"),
    onRename: () => log.push("rename"),
    onMoveToProject: (id: string | null) => log.push(`move:${id}`),
    onCreateProject: (name?: string) => log.push(`create:${name ?? ""}`),
    onOpenProjects: () => log.push("projects"),
    onArchive: () => log.push("archive"),
    onDelete: () => log.push("delete"),
  };
}

test("chat title menu adds to a project, then offers Change project", () => {
  const log: string[] = [];
  const projects = [project("a", "Alpha"), project("b", "Beta")];
  const fresh = titleMenuEntries(
    conversation({}),
    projects,
    false,
    actions(log),
  );
  assert.deepEqual(labels(fresh), [
    "Pin",
    "Rename",
    "Add to project",
    "—",
    "Delete",
  ]);
  const inProject = titleMenuEntries(
    conversation({ projectId: "a", pinned: true }),
    projects,
    false,
    actions(log),
  );
  // Remove from project is its own row.
  assert.deepEqual(labels(inProject).slice(0, 4), [
    "Unpin",
    "Rename",
    "Change project",
    "Remove from project",
  ]);
  const change = inProject[2] as Extract<MenuEntry, { label: string }>;
  assert.equal(change.searchable, "Search or create a project");
  assert.deepEqual(labels(change.submenu!), ["Alpha", "Beta"]);
  assert.equal((change.submenu![0] as { checked?: boolean }).checked, true);
  for (const entry of change.submenu!)
    if ("onSelect" in entry) entry.onSelect?.();
  change.searchCreate!.onSelect("");
  change.searchCreate!.onSelect("Gamma");
  (inProject[3] as { onSelect: () => void }).onSelect();
  // The current project is not moved to again.
  assert.deepEqual(log, ["move:b", "create:", "create:Gamma", "move:null"]);
  // The rows the submenu draws around its list.
  const rows = (name: string) =>
    labels(withCreateRow(change.submenu!, change.searchCreate, name));
  assert.deepEqual(rows(""), ["New project", "—", "Alpha", "Beta"]);
  assert.deepEqual(rows("Gam"), ["Alpha", "Beta", "Create project Gam"]);
  assert.equal(change.searchCreate!.empty, "No projects yet");
});

test("native title offers the supplied Share and Copy link actions without adding Export", () => {
  const log: string[] = [];
  const entries = titleMenuEntries(conversation({}), [], false, {
    ...actions(log),
    onShare: () => log.push("share"),
    onCopyLink: () => log.push("copy"),
    onExport: () => log.push("export"),
  });
  assert.deepEqual(labels(entries), [
    "Pin",
    "Rename",
    "Add to project",
    "Share session",
    "Copy link",
    "—",
    "Delete",
  ]);
  for (const name of ["Share session", "Copy link"]) {
    const item = entries.find(
      (entry) => "label" in entry && entry.label === name,
    ) as Extract<MenuEntry, { label: string }>;
    item.onSelect?.();
  }
  assert.deepEqual(log, ["share", "copy"]);
  assert.ok(
    !labels(
      titleMenuEntries(conversation({}), [], false, actions([])),
    ).includes("Share session"),
  );
});

test("desktop title export stays in Code without adding it to Chat or Cowork", () => {
  const exported: string[] = [];
  for (const [mode, expected] of [
    ["chat", []],
    ["cowork", []],
    ["code", ["Export"]],
  ] as const) {
    const entries = titleMenuEntries(conversation({ mode }), [], false, {
      ...actions([]),
      onExport: () => {
        exported.push(mode);
      },
    });
    const exports = entries.filter(
      (entry) => "label" in entry && entry.label.startsWith("Export"),
    );
    assert.deepEqual(labels(exports), [...expected], mode);
    for (const entry of exports) if ("onSelect" in entry) entry.onSelect?.();
  }
  assert.deepEqual(exported, ["code"]);
});

test("Code has the original's menu groups; a running one cannot be deleted", () => {
  const bare = titleMenuEntries(
    conversation({ mode: "code" }),
    [],
    true,
    actions([]),
  );
  // Nothing to open it in: no Open in (the original renders none).
  assert.deepEqual(labels(bare), [
    "Rename",
    "Fork",
    "—",
    "Transcript view",
    "Output style",
    "—",
    "Archive",
    "Delete",
  ]);
  assert.equal((bare.at(-1) as { disabled?: boolean }).disabled, true);
  // Rows without a Claudex counterpart are greyed with the reason.
  const fork = bare[1] as { disabled?: boolean; title?: string };
  assert.equal(fork.disabled, true);
  assert.ok(fork.title);
  // A given reason replaces the generic one (an empty session, an incognito one).
  const empty = titleMenuEntries(conversation({ mode: "code" }), [], true, {
    ...actions([]),
    forkDisabledReason: "A session with no messages yet has nothing to fork",
  })[1] as { disabled?: boolean; title?: string };
  assert.equal(empty.disabled, true);
  assert.equal(
    empty.title,
    "A session with no messages yet has nothing to fork",
  );

  const log: string[] = [];
  const full = titleMenuEntries(conversation({ mode: "code" }), [], false, {
    ...actions(log),
    onOpenPr: () => log.push("pr"),
    onOpenInWindow: () => {},
    onFork: () => {},
    onCopyLink: () => {},
    onExport: () => {},
    keepAwake: { on: true, onToggle: () => log.push("awake") },
  });
  assert.deepEqual(labels(full), [
    "Open PR",
    "Open in",
    "—",
    "Rename",
    "Fork",
    "—",
    "Copy link",
    "Export",
    "—",
    "Transcript view",
    "Output style",
    "Keep computer awake",
    "—",
    "Archive",
    "Delete",
  ]);
  const awake = full[11] as {
    switched?: boolean;
    keepOpen?: boolean;
    description?: string;
    onSelect: () => void;
  };
  assert.equal(awake.switched, true);
  assert.equal(awake.keepOpen, true);
  assert.equal(awake.description, "Only for this session");
  awake.onSelect();
  assert.deepEqual(log, ["awake"]);
});

test("Open in lists layout, editors, Terminal, the file manager, then Cloud under headings", () => {
  const openIn = codeOpenInEntries({
    onOpenInSplit: () => {},
    onOpenInWindow: () => {},
    editors: [
      { name: "Cursor", onSelect: () => {} },
      { name: "VS Code", onSelect: () => {} },
    ],
    onOpenTerminal: () => {},
    onRevealFolder: () => {},
    fileManager: "Finder",
    onContinueInCloud: () => {},
  });
  assert.deepEqual(
    openIn.map((e) =>
      "label" in e
        ? `${e.label} ${e.hint ?? ""}`.trim()
        : "heading" in e
          ? `# ${e.heading}`
          : "—",
    ),
    [
      "Split view 1",
      "New window 2",
      "—",
      "# Open in",
      "Cursor 3",
      "VS Code 4",
      "Terminal 5",
      "Finder 6",
      "—",
      "# Continue in",
      "Cloud 7",
    ],
  );
  // Without Continue in, no headings.
  const plain = codeOpenInEntries({
    onOpenInWindow: () => {},
    onRevealFolder: () => {},
  });
  assert.deepEqual(labels(plain), ["New window", "—", "Finder"]);
});

test("Continue in ▸ Cloud opens Continue in cloud where the session can move", () => {
  const log: string[] = [];
  const entries = titleMenuEntries(conversation({ mode: "code" }), [], false, {
    ...actions(log),
    onContinueInCloud: () => log.push("cloud"),
  });
  const openIn = (entries[0] as { submenu: MenuEntry[] }).submenu;
  const live = openIn.at(-1) as {
    label: string;
    description?: string;
    onSelect?: () => void;
  };
  assert.equal(live.label, "Cloud");
  assert.equal(live.description, "Runs without your computer");
  live.onSelect!();
  assert.deepEqual(log, ["cloud"]);
});

test("the narrow header folds closed panes first and the rail toggle before them", async () => {
  const { foldPanes, foldCount } = await import("../../src/header/code-panes");
  const panes = [
    { id: "terminal", active: false },
    { id: "changes", active: true },
    { id: "browser", active: false },
  ];
  assert.deepEqual(
    foldPanes(panes, 0).inline.map((p) => p.id),
    ["terminal", "changes", "browser"],
  );
  const two = foldPanes(panes, 2);
  assert.deepEqual(
    two.folded.map((p) => p.id),
    ["terminal", "browser"],
  );
  assert.deepEqual(
    two.inline.map((p) => p.id),
    ["changes"],
  );
  assert.equal(foldCount({ available: 500, needed: 480, slot: 30, max: 7 }), 0);
  assert.equal(foldCount({ available: 500, needed: 545, slot: 30, max: 7 }), 2);
  assert.equal(foldCount({ available: 100, needed: 900, slot: 30, max: 7 }), 7);
});

test("chat title menu: Pin, Mark as unread, Rename, Add to project, Move to group, a rule, Delete", () => {
  const log: string[] = [];
  const full = (extra: Partial<Conversation>) =>
    titleMenuEntries(conversation(extra), [project("a", "Alpha")], false, {
      ...actions(log),
      onToggleUnread: () => log.push("unread"),
      moveToGroup: { label: "Move to group", submenu: [] },
    });
  const entries = full({});
  assert.deepEqual(labels(entries), [
    "Pin",
    "Mark as unread",
    "Rename",
    "Add to project",
    "Move to group",
    "—",
    "Delete",
  ]);
  const unread = entries[1] as Extract<MenuEntry, { label: string }>;
  assert.equal(unread.hint, "U");
  unread.onSelect?.();
  assert.deepEqual(log, ["unread"]);
  assert.equal(labels(full({ unread: true }))[1], "Mark as read");
});

test("an incognito chat's title menu has no project, group or unread rows", () => {
  const entries = titleMenuEntries(
    conversation({ incognito: true }),
    [project("a", "Alpha")],
    false,
    {
      ...actions([]),
      onToggleUnread: () => {},
      moveToGroup: { label: "Move to group", submenu: [] },
    },
  );
  assert.deepEqual(labels(entries), ["Pin", "Rename", "—", "Delete"]);
});

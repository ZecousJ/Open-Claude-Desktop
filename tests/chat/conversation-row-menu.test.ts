import test from "node:test";
import { readSource } from "../support/read-source";
import assert from "node:assert/strict";
import type { Conversation, Project } from "../../shared/types";
import type { MenuEntry } from "../../src/ui/Menu";
import {
  rowMenuWidth,
  type RowMenuAbilities,
  type RowMenuHandlers,
} from "../../src/sidebar/RowMenu";
import { rowMenuEntries } from "../../src/sidebar/row-menu-entries";

const conversation = (extra: Partial<Conversation> = {}) =>
  ({
    id: "c1",
    title: "Test",
    mode: "chat",
    turns: [],
    ...extra,
  }) as unknown as Conversation;

const all: RowMenuAbilities = {
  splitView: true,
  newWindow: true,
  folder: true,
  terminal: true,
  share: true,
  copyLink: true,
};

function build(
  c: Conversation,
  can: Partial<RowMenuAbilities> = {},
  projects: Project[] = [],
  platform = "darwin",
  extra: Partial<RowMenuHandlers> = {},
) {
  const calls: string[] = [];
  // The optional rows (editors, Continue in, scheduled task, keep awake)
  // are only there when given; extra adds them.
  const optional = new Set([
    "editors",
    "continueInCloud",
    "goToScheduledTask",
    "keepAwake",
    "transcriptView",
    "outputStyle",
    "unarchiving",
    "markCompleted",
    "suppressTitleOffers",
    "acceptTitleOffer",
    "hideNested",
    "showNested",
    "detach",
    "releaseRunner",
    "openInDesktop",
  ]);
  const on = new Proxy({ ...extra } as RowMenuHandlers, {
    get: (target, name: string) =>
      name in target
        ? (target as Record<string, unknown>)[name]
        : optional.has(name)
          ? undefined
          : (...args: unknown[]) => calls.push([name, ...args].join(":")),
  });
  const entries = rowMenuEntries({
    conversation: c,
    projects,
    platform,
    can: { ...all, ...can },
    moveToGroup: { label: "Move to group", submenu: [] },
    on,
  });
  return { entries, calls };
}

/** Labels with hints ("Pin P"), "—" for a divider, Open in's items in brackets. */
function outline(entries: MenuEntry[]): string[] {
  return entries.map((entry) => {
    if ("separator" in entry) return "—";
    if ("heading" in entry) return `# ${entry.heading}`;
    const text = entry.hint ? `${entry.label} ${entry.hint}` : entry.label;
    return entry.submenu && entry.label === "Open in"
      ? `${text} [${outline(entry.submenu).join(", ")}]`
      : text;
  });
}

type Item = Extract<MenuEntry, { label: string }>;
const find = (entries: MenuEntry[], label: string) =>
  entries.find((entry) => "label" in entry && entry.label === label) as
    Item | undefined;

test("Code row menu follows R-0083 with Split view then New window in Open in", () => {
  const { entries } = build(conversation({ mode: "code" }));
  assert.deepEqual(outline(entries), [
    "Open in [Split view 1, New window 2, —, Terminal 3, Finder 4]",
    "—",
    "Pin P",
    "Mark as unread U",
    "Rename R",
    "—",
    "Share",
    "Copy link C",
    "—",
    "Move to group",
    "—",
    "Archive A",
    "Delete D",
  ]);
});

test("Code rows add Fork after Rename and Export after Copy link (live ce4f4374c groups)", () => {
  const done = conversation({ mode: "code", turns: [{ id: "t" }] as never });
  const { entries, calls } = build(done, { fork: true, export: true });
  assert.deepEqual(outline(entries).slice(2), [
    "Pin P",
    "Mark as unread U",
    "Rename R",
    "Fork F",
    "—",
    "Share",
    "Copy link C",
    "Export E",
    "—",
    "Move to group",
    "—",
    "Archive A",
    "Delete D",
  ]);
  find(entries, "Fork")!.onSelect!();
  find(entries, "Export")!.onSelect!();
  assert.deepEqual(calls, ["fork", "exportConversation"]);
  // Nothing to fork from, and an incognito session is never saved.
  const fresh = build(conversation({ mode: "code" }), {
    fork: false,
    export: true,
  });
  assert.equal(find(fresh.entries, "Fork"), undefined);
  const hidden = build(conversation({ mode: "code", incognito: true }), {
    fork: true,
    export: true,
  });
  assert.equal(find(hidden.entries, "Export"), undefined);
  // Without Share, Copy link or Export the second rule is not doubled.
  const bare = build(conversation({ mode: "code" }), {
    share: false,
    copyLink: false,
    export: false,
  });
  // Open in's rule, then the rules around Move to group.
  assert.equal(outline(bare.entries).filter((line) => line === "—").length, 3);
  // Chat and Cowork rows are not Code sessions: no Fork or Export.
  const chat = build(conversation(), { fork: true, export: true });
  assert.equal(find(chat.entries, "Fork"), undefined);
  assert.equal(find(chat.entries, "Export"), undefined);
});

test("a pinned Code row offers Move up and Move down before Move to group", () => {
  const pinned = conversation({ mode: "code", pinned: true });
  const { entries, calls } = build(pinned);
  // build() answers every handler, so both moves exist here.
  const lines = outline(entries);
  assert.deepEqual(lines.slice(lines.indexOf("Move up") - 1).slice(0, 5), [
    "—",
    "Move up",
    "Move down",
    "Move to group",
    "—",
  ]);
  find(entries, "Move up")!.onSelect!();
  find(entries, "Move down")!.onSelect!();
  assert.deepEqual(calls, ["moveUp", "moveDown"]);
  // An unpinned row, and a Chat row, have no place to move along.
  const loose = build(conversation({ mode: "code", pinned: false }));
  assert.equal(find(loose.entries, "Move up"), undefined);
  const chat = build(conversation({ pinned: true }));
  assert.equal(find(chat.entries, "Move up"), undefined);
});

test("Open in numbers follow the items that show", () => {
  const { entries } = build(conversation({ mode: "code" }), {
    newWindow: false,
  });
  assert.equal(
    outline(entries)[0],
    "Open in [Split view 1, —, Terminal 2, Finder 3]",
  );
  const win = build(conversation({ mode: "code" }), {}, [], "win32");
  assert.equal(
    outline(win.entries)[0],
    "Open in [Split view 1, New window 2, —, Terminal 3, Explorer 4]",
  );
  const only = build(conversation({ mode: "code" }), {
    folder: false,
    terminal: false,
  });
  assert.equal(
    outline(only.entries)[0],
    "Open in [Split view 1, New window 2]",
  );
});

test("a host with one pane (the web) leaves Split view out, not greyed", () => {
  const { entries } = build(conversation({ mode: "code" }), {
    splitView: false,
  });
  assert.equal(
    outline(entries)[0],
    "Open in [New window 1, —, Terminal 2, Finder 3]",
  );
  // Chat and Cowork rows never had it.
  assert.equal(find(build(conversation()).entries, "Open in"), undefined);
});

test("a host without panes, windows, folders or a terminal drops Open in", () => {
  const { entries } = build(conversation({ mode: "code" }), {
    splitView: false,
    newWindow: false,
    folder: false,
    terminal: false,
  });
  assert.equal(find(entries, "Open in"), undefined);
  assert.equal(outline(entries)[0], "Pin P");
});

test("Chat row menu starts with Open in new window (R-0044-0083)", () => {
  const projects = [{ id: "p1", name: "Docs" }] as Project[];
  const { entries } = build(conversation(), {}, projects);
  assert.deepEqual(outline(entries), [
    "Open in new window",
    "Mark as unread U",
    "—",
    "Pin P",
    "Rename R",
    "Add to project",
    "Share",
    "Copy link C",
    "Move to group",
    "—",
    "Delete D",
  ]);
  // A Cowork task's menu leads with Open as quick task and a rule.
  const cowork = build(conversation({ mode: "cowork" }), { newWindow: false });
  assert.deepEqual(outline(cowork.entries).slice(0, 5), [
    "Open as quick task",
    "—",
    "Mark as unread U",
    "—",
    "Pin P",
  ]);
});

test("Open as quick task: Cowork tasks only, greyed for the open one", () => {
  const chat = build(conversation(), {});
  assert.equal(find(chat.entries, "Open as quick task"), undefined);
  const incognito = build(conversation({ mode: "cowork", incognito: true }));
  assert.equal(find(incognito.entries, "Open as quick task"), undefined);
  const open = build(conversation({ mode: "cowork" }), {
    quickTaskDisabled: true,
  });
  assert.equal(find(open.entries, "Open as quick task")?.disabled, true);
  const other = build(conversation({ mode: "cowork" }));
  find(other.entries, "Open as quick task")?.onSelect?.();
  assert.deepEqual(other.calls, ["openAsQuickTask"]);
});

test("Share and Copy link show only when they can be carried out", () => {
  const off = build(conversation(), { share: false, copyLink: false });
  assert.equal(find(off.entries, "Share"), undefined);
  assert.equal(find(off.entries, "Copy link"), undefined);
  const shareOnly = build(conversation({ mode: "code" }), {
    copyLink: false,
  });
  assert.ok(find(shareOnly.entries, "Share"));
  assert.equal(find(shareOnly.entries, "Copy link"), undefined);
  // A link made earlier can still be copied after sharing was turned off.
  const linkOnly = build(conversation(), { share: false });
  assert.ok(find(linkOnly.entries, "Copy link"));
});

test("an incognito chat offers Delete only: no new window, Pin, Rename, projects, groups, Share or Copy link", () => {
  const { entries } = build(conversation({ incognito: true }));
  assert.deepEqual(outline(entries), ["Delete D"]);
});

test("entries call their handlers", () => {
  const code = build(conversation({ mode: "code" }));
  for (const entry of find(code.entries, "Open in")!.submenu!)
    if ("label" in entry) entry.onSelect?.();
  find(code.entries, "Share")!.onSelect!();
  find(code.entries, "Copy link")!.onSelect!();
  find(code.entries, "Archive")!.onSelect!();
  assert.deepEqual(code.calls, [
    "openInSplit",
    "openInWindow",
    "openIn:terminal",
    "openIn:folder",
    "share",
    "copyLink",
    "toggleArchive",
  ]);
  const chat = build(conversation(), {}, [
    { id: "p1", name: "Docs" } as Project,
  ]);
  find(chat.entries, "Open in new window")!.onSelect!();
  const project = find(chat.entries, "Add to project")!.submenu![0];
  if ("label" in project) project.onSelect?.();
  assert.deepEqual(chat.calls, ["openInWindow", "moveToProject:p1"]);
});

test("the menu widens only for Open in new window", () => {
  assert.equal(
    rowMenuWidth(build(conversation({ mode: "code" })).entries),
    144,
  );
  assert.equal(rowMenuWidth(build(conversation()).entries), 168);
  assert.equal(
    rowMenuWidth(build(conversation(), { newWindow: false }).entries),
    144,
  );
});

test("a Code session with a pull request opens it first (Open PR, G)", () => {
  const { entries, calls } = build(conversation({ mode: "code" }), {
    pullRequest: true,
  });
  assert.deepEqual(outline(entries).slice(0, 3), [
    "Open PR G",
    "Open in [Split view 1, New window 2, —, Terminal 3, Finder 4]",
    "—",
  ]);
  find(entries, "Open PR")!.onSelect!();
  assert.deepEqual(calls, ["openPr"]);
  // Without Open in, Open PR still has its rule under it; Chat never has it.
  const alone = build(conversation({ mode: "code" }), {
    pullRequest: true,
    splitView: false,
    newWindow: false,
    folder: false,
    terminal: false,
  }).entries;
  assert.deepEqual(outline(alone).slice(0, 3), ["Open PR G", "—", "Pin P"]);
  assert.equal(
    find(build(conversation(), { pullRequest: true }).entries, "Open PR"),
    undefined,
  );
});

test("Code row menu: editors, Terminal and the file manager under Open in, Continue in Cloud, scheduled task, keep awake", () => {
  const c = {
    ...conversation({ mode: "code" }),
    scheduledTaskId: "r1",
  } as Conversation;
  const { entries } = build(c, {}, [], "darwin", {
    editors: [{ name: "Cursor", onSelect() {} }],
    continueInCloud() {},
    goToScheduledTask() {},
    keepAwake: { on: true, onToggle() {} },
  });
  const openIn = entries.find(
    (e) => "label" in e && e.label === "Open in",
  ) as Extract<MenuEntry, { label: string }>;
  assert.deepEqual(
    openIn.submenu!.map((e) =>
      "separator" in e
        ? "—"
        : "heading" in e
          ? `# ${e.heading}`
          : `${e.label}${e.hint ? ` ${e.hint}` : ""}`,
    ),
    [
      "Split view 1",
      "New window 2",
      "—",
      "# Open in",
      "Cursor 3",
      "Terminal 4",
      "Finder 5",
      "—",
      "# Continue in",
      "Cloud 6",
    ],
  );
  const labels = entries
    .filter((e) => "label" in e)
    .map((e) => (e as { label: string }).label);
  assert.ok(labels.includes("Go to scheduled task"));
  const awake = entries.find(
    (e) => "label" in e && e.label === "Keep computer awake",
  ) as Extract<MenuEntry, { label: string }>;
  assert.equal(awake.switched, true);
  assert.equal(awake.description, "Only for this session");
});

test("Code row menu: Transcript view and Output style in the session group; Unarchiving… while it runs", () => {
  const c = {
    ...conversation({ mode: "code" }),
    archived: true,
  } as Conversation;
  const { entries } = build(c, {}, [], "darwin", {
    transcriptView: [{ label: "Normal", checked: true, onSelect() {} }],
    outputStyle: [{ label: "Default", checked: true, onSelect() {} }],
    unarchiving: true,
  });
  const labels = entries
    .filter((e) => "label" in e)
    .map((e) => (e as { label: string }).label);
  assert.ok(labels.indexOf("Transcript view") < labels.indexOf("Output style"));
  const archive = entries.find(
    (e) => "label" in e && e.label === "Unarchiving…",
  ) as Extract<MenuEntry, { label: string }>;
  assert.equal(archive.disabled, true);
});

test("Code row menu hides resolved, suppressed and manually superseded title offers", () => {
  for (const extra of [
    { titleOffersSuppressed: true },
    { title: "Suggested" },
    {
      titleOffer: { proposedTitle: "Suggested", at: 1, state: "kept" as const },
    },
    {
      titleOffer: {
        proposedTitle: "Suggested",
        at: 1,
        state: "accepted" as const,
      },
    },
    {
      titleOffer: {
        proposedTitle: "Suggested",
        at: 1,
        titleAtOffer: "Old name",
      },
    },
  ]) {
    const value = conversation({
      mode: "code",
      titleOffer: { proposedTitle: "Suggested", at: 1 },
      ...extra,
    });
    const { entries } = build(value, {}, [], "darwin", {
      acceptTitleOffer() {},
      suppressTitleOffers() {},
    });
    assert.equal(find(entries, "Use suggested title"), undefined);
    if (value.titleOffersSuppressed)
      assert.equal(find(entries, "Suppress title offers"), undefined);
  }
});

test("Code row menu exposes completion, title, nesting, and runner actions conditionally", () => {
  // Mark as completed waits for a session ready for its review (the
  // original's onAckAwaiting), and Suppress title offers for an offer.
  const idle = build(conversation({ mode: "code" }), {}, [], "darwin", {
    markCompleted: () => {},
    suppressTitleOffers: () => {},
  });
  assert.equal(find(idle.entries, "Mark as completed"), undefined);
  assert.equal(find(idle.entries, "Suppress title offers"), undefined);
  const child = conversation({
    mode: "code",
    parentSessionId: "parent",
    sessionState: "ready_for_review",
    titleOffer: { proposedTitle: "Suggested", at: 1 },
  });
  const { entries, calls } = build(child, {}, [], "darwin", {
    markCompleted: () => calls.push("markCompleted"),
    suppressTitleOffers: () => calls.push("suppressTitleOffers"),
    acceptTitleOffer: () => calls.push("acceptTitleOffer"),
    detach: () => calls.push("detach"),
    hideNested: () => calls.push("hideNested"),
    releaseRunner: () => calls.push("releaseRunner"),
  });
  assert.equal(find(entries, "Mark as completed") !== undefined, true);
  assert.equal(find(entries, "Suppress title offers") !== undefined, true);
  assert.equal(find(entries, "Use suggested title") !== undefined, true);
  assert.equal(
    find(entries, "Detach session to top level") !== undefined,
    true,
  );
  assert.equal(find(entries, "Release runner") !== undefined, true);
  assert.equal(find(entries, "Hide nested sessions"), undefined);
  for (const label of [
    "Mark as completed",
    "Suppress title offers",
    "Use suggested title",
    "Detach session to top level",
    "Release runner",
  ])
    find(entries, label)!.onSelect!();
  assert.deepEqual(calls, [
    "markCompleted",
    "suppressTitleOffers",
    "acceptTitleOffer",
    "detach",
    "releaseRunner",
  ]);

  const parent = conversation({ mode: "code", nestedSessionsHidden: true });
  const folded = build(parent, {}, [], "darwin", {
    hideNested: () => calls.push("hideNested"),
    showNested: () => calls.push("showNested"),
  });
  const count = build(parent, {}, [], "darwin", {
    hideNested: () => calls.push("hideNested"),
    showNested: () => calls.push("showNested"),
  });
  assert.equal(find(folded.entries, "Show nested sessions"), undefined);
  assert.equal(find(count.entries, "Show nested sessions"), undefined);
  // A parent gets the row only when the caller supplies its child count.
  const withChild = rowMenuEntries({
    conversation: parent,
    projects: [],
    platform: "darwin",
    can: { ...all },
    moveToGroup: { label: "Move to group", submenu: [] },
    nestedSessionCount: 1,
    on: {
      ...({} as RowMenuHandlers),
      togglePin: () => {},
      toggleUnread: () => {},
      rename: () => {},
      share: () => {},
      copyLink: () => {},
      moveToProject: () => {},
      toggleArchive: () => {},
      remove: () => {},
      showNested: () => calls.push("showNested"),
    },
  });
  assert.equal(find(withChild, "Show nested sessions") !== undefined, true);
});

test("Release runner sits in the session group after Output style and before Keep computer awake", () => {
  const { entries } = build(conversation({ mode: "code" }), {}, [], "darwin", {
    transcriptView: [{ label: "Normal", onSelect() {} }],
    outputStyle: [{ label: "Default", onSelect() {} }],
    keepAwake: { on: false, onToggle() {} },
    releaseRunner() {},
  });
  const labels = outline(entries);
  const at = (label: string) => labels.findIndex((l) => l.startsWith(label));
  assert.ok(at("Transcript view") < at("Output style"));
  assert.ok(at("Output style") < at("Release runner"));
  assert.ok(at("Release runner") < at("Keep computer awake"));
  // Not at the top beside Open in.
  assert.ok(at("Pin") < at("Release runner"));
});

test("Code row items carry no icons while Chat row items keep theirs", () => {
  const withIcon = (entries: ReturnType<typeof build>["entries"]) =>
    entries.filter((entry) => "icon" in entry && entry.icon);
  const code = build(conversation({ mode: "code" }), {});
  assert.deepEqual(
    withIcon(code.entries).map((entry) => "label" in entry && entry.label),
    [],
  );
  const chat = build(conversation(), {});
  const labels = withIcon(chat.entries).map(
    (entry) => "label" in entry && entry.label,
  );
  for (const label of ["Pin", "Rename", "Delete"])
    assert.ok(labels.includes(label), `${label} keeps its icon`);
});

test("the row's Copy link copies an invited-only chat at its invitation link, like the title menu", () => {
  const menu = readSource("src/sidebar/RowMenu.tsx", "utf8");
  assert.match(
    menu,
    /c\.mode !== "code" && current\.access === "invited"\s*\?\s*\(current\.inviteUrl \?\? current\.url\)\s*:\s*current\.url/,
  );
});

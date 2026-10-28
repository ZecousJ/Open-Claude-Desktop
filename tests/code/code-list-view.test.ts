import test from "node:test";
import assert from "node:assert/strict";
import { act, createElement, StrictMode } from "react";
import { parseHTML } from "linkedom";
import { createRoot } from "react-dom/client";
import type { Conversation } from "../../shared/types";
import type { ConversationGroups } from "../../shared/collections-api";
import {
  codeListGroups,
  codeListRows,
  codePlace,
  codeSessionState,
  defaultCodeListView as defaults,
  isDefaultCodeListView,
  parseCodeListView,
  readCodeListView,
  saveCodeListView,
  useCodeListView,
  type CodeListView,
} from "../../src/sidebar/code-list-view";
import { codeListMenuEntries } from "../../src/sidebar/code-list-menu-entries";
import {
  codeMetadata,
  codePlaceDescription,
} from "../../src/sidebar/CodeRowMetadata";
import { codeListFixture } from "../../scripts/preview/fixtures/code-list";
import type { MenuEntry } from "../../src/ui/Menu";
import { Menu } from "../../src/ui/Menu";

const row = (id: string, extra: Partial<Conversation> = {}): Conversation => ({
  id,
  title: id,
  mode: "code",
  pinned: false,
  archived: false,
  providerId: "p",
  model: "Opus 5.5",
  createdAt: 1,
  updatedAt: 1,
  turns: [],
  ...extra,
});
const entries = (view = defaults, classify = true) =>
  codeListMenuEntries(
    view,
    () => {},
    () => {},
    () => {},
    classify,
  );
function item(list: MenuEntry[], label: string) {
  const result = list.find((e) => "label" in e && e.label === label);
  assert.ok(result && "label" in result);
  return result;
}
test("Code menu matches the current root, children, defaults and live classification capability", () => {
  assert.deepEqual(
    entries().map((e) => ("label" in e ? e.label : "separator")),
    [
      "Group by",
      "Sort by",
      "Show",
      "separator",
      "New section",
      "separator",
      "Reset to defaults",
      "View all",
    ],
  );
  assert.equal(item(entries(), "Reset to defaults").disabled, true);
  assert.equal(
    item(entries({ ...defaults, metadata: true }), "Reset to defaults")
      .disabled,
    false,
  );
  assert.deepEqual(
    item(entries(), "Group by").submenu?.map((e) =>
      "label" in e ? e.label : "separator",
    ),
    ["Date", "Status", "Folder", "Environment", "separator", "None"],
  );
  assert.ok(
    !item(entries(defaults, false), "Group by").submenu?.some(
      (e) => "label" in e && e.label === "Status",
    ),
  );
  assert.deepEqual(
    item(entries(), "Show").submenu?.map((e) =>
      "label" in e ? e.label : "separator",
    ),
    ["Metadata", "separator", "Empty groups"],
  );
  for (const entry of item(entries(), "Show").submenu ?? [])
    if ("label" in entry) assert.equal(entry.checkedRole, "checkbox");
  for (const entry of item(entries(), "Sort by").submenu ?? [])
    if ("label" in entry) assert.equal(entry.keepOpen, true);
  for (const entry of item(entries(), "Group by").submenu ?? [])
    if ("label" in entry) assert.equal(entry.keepOpen, true);
});
test("Code root actions create a section, open history and reset every view preference", () => {
  let created = 0,
    viewed = 0,
    next: CodeListView | undefined;
  const list = codeListMenuEntries(
    { ...defaults, metadata: true, ascending: true, groupBy: "folder" },
    (v) => {
      next = v;
    },
    () => {
      created++;
    },
    () => {
      viewed++;
    },
  );
  item(list, "New section").onSelect?.();
  item(list, "View all").onSelect?.();
  item(list, "Reset to defaults").onSelect?.();
  assert.equal(created, 1);
  assert.equal(viewed, 1);
  assert.deepEqual(next, defaults);
  item(item(list, "Show").submenu!, "Empty groups").onSelect?.();
  assert.equal(next?.emptyGroups, true);
});
test("Both sort directions use real values before nesting, without changing pins or archived visibility", () => {
  const rows = [
    row("b", { updatedAt: 3, createdAt: 1 }),
    row("a", { updatedAt: 1, createdAt: 3 }),
    row("c", { updatedAt: 2, createdAt: 2, parentSessionId: "a" }),
    row("pin", { pinned: true }),
    row("archive", { archived: true }),
    row("chat", { mode: "chat" }),
  ];
  const ids = (sort: CodeListView["sort"], ascending: boolean) =>
    codeListRows(rows, { ...defaults, sort, ascending }).map((r) => r.id);
  assert.deepEqual(ids("updated", false), ["b", "a", "c"]);
  assert.deepEqual(ids("updated", true), ["a", "c", "b"]);
  assert.deepEqual(ids("created", false), ["a", "c", "b"]);
  assert.deepEqual(ids("created", true), ["b", "a", "c"]);
  assert.deepEqual(ids("name", true), ["a", "c", "b"]);
  assert.deepEqual(ids("name", false), ["b", "a", "c"]);
  rows[1].nestedSessionsHidden = true;
  assert.deepEqual(ids("updated", true), ["a", "b"]);
});
test("Custom sections survive None, other grouping and Reset; empty sections use the existing visibility rule", () => {
  const custom: ConversationGroups = {
    groups: [
      { id: "one", name: "Owner section" },
      { id: "empty", name: "Empty section" },
    ],
    members: { a: "one", b: "removed" },
  };
  const rows = [
    row("a"),
    row("b", { cwd: "/work/a" }),
    row("c", { cwd: "/work/b" }),
  ];
  const group = (view = defaults, show = false) =>
    codeListGroups(rows, view, custom, () => show, new Set(), true, 100);
  assert.deepEqual(
    group().map((g) => [g.key, g.rows.map((r) => r.id)]),
    [
      ["group:one", ["a"]],
      ["ungrouped", ["b", "c"]],
    ],
  );
  assert.equal(group({ ...defaults, groupBy: "folder" })[0].key, "group:one");
  assert.equal(group(defaults, true)[1].key, "group:empty");
  assert.deepEqual(custom.members, { a: "one", b: "removed" });
});
test("Status grouping uses approvals, actual in-flight turns and saved classifier results; disabled classification falls back to Date", () => {
  const turn = {
    id: "t",
    prompt: "",
    attachments: [],
    items: [],
    createdAt: 1,
    status: "inProgress" as const,
  };
  const rows = [
    row("done"),
    row("working", { turns: [turn] }),
    row("review", { sessionState: "ready_for_review" }),
    row("ask"),
  ];
  const approval = new Set(["ask"]);
  assert.equal(codeSessionState(rows[1], approval), "working");
  const groups = codeListGroups(
    rows,
    { ...defaults, groupBy: "status" },
    { groups: [], members: {} },
    () => false,
    approval,
    true,
    100,
  );
  assert.deepEqual(
    groups.map((g) => g.label),
    ["Needs input", "Ready for review", "Working", "Completed"],
  );
  assert.equal(
    codeListGroups(
      rows,
      { ...defaults, groupBy: "status" },
      { groups: [], members: {} },
      () => false,
      approval,
      false,
      100,
    )[0].label,
    "Today",
  );
});

test("Folder/environment headings suppress only repeated place marks; custom sections keep their own metadata", () => {
  const rows = [
    row("a", { cwd: "/work/project" }),
    row("b", {
      cwd: "/work/project",
      environment: { kind: "space", spaceId: "cloud" },
    }),
    row("c", { linkedToComputer: true, linkedComputerId: "computer" }),
  ];
  const custom = { groups: [], members: {} };
  const folders = codeListGroups(
    rows,
    { ...defaults, groupBy: "folder" },
    custom,
    () => false,
    new Set(),
  );
  assert.equal(folders[0].hidePlace, false);
  assert.equal(folders[1].label, "Remote Control");
  assert.equal(folders[1].hidePlace, true);
  const environments = codeListGroups(
    rows,
    { ...defaults, groupBy: "environment" },
    custom,
    () => false,
    new Set(),
  );
  assert.ok(environments.every((g) => g.hidePlace));
});
test("Environment facts distinguish cloud/SSH/linked computer and never turn absent connection data into Connected", () => {
  assert.equal(
    codePlace(row("cloud", { environment: { kind: "space", spaceId: "s" } }))
      .kind,
    "cloud",
  );
  assert.equal(
    codePlace(row("cloud-id", { cloudEnvironmentId: "s" })).kind,
    "cloud",
  );
  assert.equal(
    codePlace(row("ssh", { environment: { kind: "ssh", hostId: "h" } })).key,
    "ssh:h",
  );
  const linked = row("remote", {
    linkedToComputer: true,
    linkedComputerName: "Remote name",
    linkedComputerOnline: true,
  });
  assert.equal(codePlace(linked).connected, undefined);
  assert.equal(codePlaceDescription(linked), "Remote name");
  assert.equal(
    codePlace({ ...linked, linkedComputerAccess: true }).connected,
    true,
  );
  assert.equal(
    codePlace({ ...linked, linkedComputerAccess: false }).connected,
    false,
  );
});
test("Metadata is opt-in, conditional and backed by actual branch/folder/blocked data; pins and duplicate folder headings stay single-line", () => {
  const c = row("real", { branch: "feature/a", cwd: "/work/project" });
  assert.equal(codeMetadata(c, defaults, false, false), undefined);
  assert.deepEqual(
    codeMetadata(c, { ...defaults, metadata: true }, false, false)?.parts,
    ["feature/a", "project"],
  );
  assert.deepEqual(
    codeMetadata(
      c,
      { ...defaults, metadata: true, groupBy: "folder" },
      false,
      false,
    )?.parts,
    ["feature/a"],
  );
  assert.deepEqual(
    codeMetadata(
      c,
      { ...defaults, metadata: true, groupBy: "folder" },
      false,
      true,
    )?.parts,
    ["feature/a", "project"],
  );
  assert.equal(
    codeMetadata(
      { ...c, pinned: true },
      { ...defaults, metadata: true },
      false,
      false,
    ),
    undefined,
  );
  assert.equal(
    codeMetadata(
      c,
      { ...defaults, metadata: true, groupBy: "status" },
      true,
      false,
    ),
    undefined,
  );
  assert.equal(
    codeMetadata(row("unknown"), { ...defaults, metadata: true }, false, false),
    undefined,
  );
});
test("Corrupt or unsupported stored preferences are sanitized without merging old filter inventories", () => {
  for (const raw of [
    "broken",
    "null",
    "[]",
    "42",
    '{"groupBy":"custom","sort":"activity","ascending":"true","metadata":1}',
  ])
    assert.deepEqual(parseCodeListView(raw), defaults);
  assert.ok(isDefaultCodeListView(parseCodeListView()));
});
test("Preferences survive remount, update both mounted readers and switch accounts without a stale frame, including storage failure", async () => {
  const { window, document } = parseHTML(
    "<html><body><main></main></body></html>",
  );
  const stored = new Map<string, string>();
  let deny = false;
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      getItem: (k: string) => stored.get(k) ?? null,
      setItem: (k: string, v: string) => {
        if (deny) throw Error("denied");
        stored.set(k, v);
      },
    },
  });
  const values = { window, document, IS_REACT_ACT_ENVIRONMENT: true };
  const old = new Map(
    Object.keys(values).map((k) => [
      k,
      Object.getOwnPropertyDescriptor(globalThis, k),
    ]),
  );
  for (const [k, v] of Object.entries(values))
    Object.defineProperty(globalThis, k, {
      configurable: true,
      writable: true,
      value: v,
    });
  let account = "r7-one";
  let set!: (v: CodeListView) => void;
  function Reader({ id }: { id: string }) {
    const [view, save] = useCodeListView(account);
    set = save;
    return createElement("output", { id }, JSON.stringify(view));
  }
  const root = createRoot(document.querySelector("main")!);
  const render = () =>
    act(async () =>
      root.render(
        createElement(
          StrictMode,
          null,
          createElement(Reader, { id: "one" }),
          createElement(Reader, { id: "two" }),
        ),
      ),
    );
  try {
    await render();
    await act(async () => set({ ...defaults, metadata: true, sort: "name" }));
    assert.equal(
      document.querySelector("#one")?.textContent,
      document.querySelector("#two")?.textContent,
    );
    assert.equal(JSON.parse(readCodeListView(account)!).metadata, true);
    account = "r7-two";
    await render();
    assert.equal(
      document.querySelector("#one")?.textContent,
      JSON.stringify(defaults),
    );
    deny = true;
    await act(async () =>
      saveCodeListView(account, { ...defaults, ascending: true }),
    );
    assert.equal(
      JSON.parse(document.querySelector("#one")!.textContent!).ascending,
      true,
    );
    account = "r7-one";
    await render();
    assert.equal(
      JSON.parse(document.querySelector("#one")!.textContent!).metadata,
      true,
    );
  } finally {
    await act(async () => root.unmount());
    for (const [k, v] of old) {
      if (v) Object.defineProperty(globalThis, k, v);
      else Reflect.deleteProperty(globalThis, k);
    }
  }
});
test("Offline section fixture uses real bridge contracts, rejects a failed save and keeps actual membership intact", async () => {
  const make = (params: URLSearchParams) =>
    codeListFixture.bridge({
      params,
      state: { conversations: [] } as never,
      origin: 1,
      emit() {},
    });
  const bridge = make(new URLSearchParams());
  const saved = await bridge.createConversationGroup!("Reference section");
  const id = saved.groups[0].id;
  assert.deepEqual(
    (await bridge.moveConversationToGroup!("real-row", id)).members,
    { "real-row": id },
  );
  await assert.rejects(
    bridge.createConversationGroup!("Reference section"),
    /already exists/,
  );
  assert.equal((await bridge.listConversationGroups!()).groups.length, 1);
  const failed = make(new URLSearchParams("codeList=error"));
  await assert.rejects(
    failed.createConversationGroup!("Section"),
    /save failed/,
  );
  assert.equal((await failed.listConversationGroups!()).groups.length, 0);
});

test("Actual menu follows programmatic keyboard focus and keeps submenu checks open; frame styles opt in", async () => {
  const { window, document } = parseHTML(
    "<html><body><main></main></body></html>",
  );
  const values = {
    window,
    document,
    Element: window.Element,
    HTMLElement: window.HTMLElement,
    Node: window.Node,
    innerWidth: 1280,
    innerHeight: 720,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const old = new Map(
    Object.keys(values).map((k) => [
      k,
      Object.getOwnPropertyDescriptor(globalThis, k),
    ]),
  );
  for (const [k, v] of Object.entries(values))
    Object.defineProperty(globalThis, k, {
      configurable: true,
      writable: true,
      value: v,
    });
  let closed = 0,
    next = defaults;
  const root = createRoot(document.querySelector("main")!);
  try {
    await act(async () =>
      root.render(
        createElement(Menu, {
          label: "Group and sort",
          entries: codeListMenuEntries(
            defaults,
            (v) => {
              next = v;
            },
            () => {},
            () => {},
          ),
          position: { left: 20, top: 20 },
          width: 200,
          size: "regular",
          className: "root-frame",
          submenuClassName: "child-frame",
          onClose: () => {
            closed++;
          },
        }),
      ),
    );
    const sort = document.querySelector<HTMLElement>('[data-index="1"]')!;
    await act(async () =>
      sort.dispatchEvent(new window.Event("focusin", { bubbles: true })),
    );
    const key = new window.Event("keydown", {
      bubbles: true,
      cancelable: true,
    });
    Object.assign(key, { key: "ArrowRight" });
    await act(async () => sort.dispatchEvent(key));
    const submenu = document.querySelector("[data-submenu]")!;
    assert.ok(submenu);
    assert.equal(submenu.getAttribute("aria-label"), "Sort by");
    assert.ok(submenu.classList.contains("child-frame"));
    assert.ok(!submenu.classList.contains("root-frame"));
    const name = [
      ...submenu.querySelectorAll<HTMLButtonElement>("button"),
    ].find((b) => b.textContent === "Name")!;
    await act(async () => name.click());
    assert.equal(next.sort, "name");
    assert.equal(closed, 0);
    assert.ok(document.querySelector("[data-submenu]"));
  } finally {
    await act(async () => root.unmount());
    for (const [k, v] of old) {
      if (v) Object.defineProperty(globalThis, k, v);
      else Reflect.deleteProperty(globalThis, k);
    }
  }
});

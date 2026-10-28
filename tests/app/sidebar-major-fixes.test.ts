import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { MoreMenu } from "../../src/sidebar/MainNav";
import {
  dragHidesSidebar,
  minimumSidebarWidth,
} from "../../shared/sidebar-layout";

const css = (path: string) =>
  readFileSync(new URL(`../../src/${path}`, import.meta.url), "utf8").replace(
    /\/\*[\s\S]*?\*\//g,
    "",
  );

test("native Code's full-bleed sidebar handle centres on the sidebar's right edge like Chat's", () => {
  assert.match(
    css("code-home/native-code-home.css"),
    /\.app:not\(\.web\)\.mode-code:not\(\.sidebar-hidden\) \.sidebar-resize-handle\s*\{[^}]*top: var\(--sidebar-chrome-height\);[^}]*bottom: 0;[^}]*left: calc\(var\(--sidebar-width\) - 6px\)/s,
  );
});

test("macOS full-bleed frames collapse the toggle to spacer + 8px, the floating card keeps 90px", () => {
  const chrome = css("sidebar/sidebar-chrome.css");
  assert.match(chrome, /\.collapsed-chrome\s*\{[^}]*left: 90px/s);
  assert.match(
    chrome,
    /\.app\.darwin:not\(\.web\):not\(\.full-screen\) \.collapsed-chrome\s*\{[^}]*left: calc\(var\(--traffic-light-spacer\) \+ 8px\)/s,
  );
});

test("dragging the sidebar handle under half the minimum width collapses it", () => {
  assert.equal(minimumSidebarWidth, 200);
  assert.ok(dragHidesSidebar(99));
  assert.ok(!dragHidesSidebar(100));
  assert.ok(!dragHidesSidebar(150));
});

/** Renders in a linkedom document with the globals React and the sidebar read. */
async function withDom(
  run: (document: Document, window: typeof globalThis) => Promise<void>,
) {
  const { window, document } = parseHTML(
    "<html><body><div id='root'></div></body></html>",
  );
  // linkedom has no focus model: record the focused element.
  let focused: Element | null = null;
  Object.defineProperty(document, "activeElement", {
    configurable: true,
    get: () => focused,
  });
  window.HTMLElement.prototype.focus = function () {
    focused = this;
  };
  const globals = {
    window,
    document,
    localStorage: { getItem: () => null, setItem: () => {} },
    innerWidth: 1200,
    innerHeight: 800,
    IS_REACT_ACT_ENVIRONMENT: true,
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
  try {
    await run(
      document as unknown as Document,
      window as unknown as typeof globalThis,
    );
  } finally {
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}

const sleep = (ms: number) =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });

function pointer(window: typeof globalThis, target: Element, type: string) {
  const event = new window.Event(type, { bubbles: true });
  Object.defineProperty(event, "pointerType", { value: "mouse" });
  Object.defineProperty(event, "relatedTarget", { value: null });
  target.dispatchEvent(event);
}

const moreMenu = () =>
  createElement(MoreMenu, {
    mode: "chat",
    page: "chat",
    extra: [{ id: "dispatch", label: "Dispatch", icon: null }],
    onPageChange: () => {},
    onEditSidebar: () => {},
  });

test("the More menu opens on hover after 120ms, closes 180ms after the pointer leaves, and a click keeps it open", async () => {
  await withDom(async (document, window) => {
    const root = createRoot(document.querySelector("#root")!);
    await act(async () => root.render(moreMenu()));
    const anchor = document.querySelector(".main-nav-more")!;
    const row = anchor.querySelector("button")!;
    row.getBoundingClientRect = () => ({ right: 200, top: 80 }) as DOMRect;
    const open = () => document.querySelector('[role="menu"]') !== null;
    await act(async () => pointer(window, row, "pointerover"));
    assert.ok(!open());
    await sleep(60);
    assert.ok(!open());
    await sleep(120);
    assert.ok(open());
    await act(async () => pointer(window, row, "pointerout"));
    await sleep(90);
    assert.ok(open());
    await sleep(160);
    assert.ok(!open());
    // Leaving before the open delay cancels it.
    await act(async () => pointer(window, row, "pointerover"));
    await act(async () => pointer(window, row, "pointerout"));
    await sleep(200);
    assert.ok(!open());
    // A click opens it for good: leaving does not close it, a second click does.
    await act(async () => row.click());
    assert.ok(open());
    await act(async () => pointer(window, row, "pointerout"));
    await sleep(260);
    assert.ok(open());
    await act(async () => row.click());
    assert.ok(!open());
    await act(async () => root.unmount());
  });
});

test("the More menu takes arrow keys: ↓ opens onto the first item, ↑ ↓ Home End walk, Escape returns to the row", async () => {
  await withDom(async (document, window) => {
    const root = createRoot(document.querySelector("#root")!);
    await act(async () => root.render(moreMenu()));
    const row = document.querySelector<HTMLButtonElement>(
      ".main-nav-more > button",
    )!;
    row.getBoundingClientRect = () => ({ right: 200, top: 80 }) as DOMRect;
    const key = (target: Element, name: string) =>
      act(async () => {
        const event = new window.Event("keydown", {
          bubbles: true,
          cancelable: true,
        });
        Object.defineProperty(event, "key", { value: name });
        target.dispatchEvent(event);
      });
    const items = () => [
      ...document.querySelectorAll<HTMLElement>('[role="menuitem"]'),
    ];
    row.focus();
    await key(row, "ArrowDown");
    assert.ok(items().length >= 2);
    assert.ok(document.activeElement === items()[0]);
    await key(items()[0], "ArrowUp");
    assert.ok(document.activeElement === items().at(-1));
    await key(items().at(-1)!, "ArrowDown");
    assert.ok(document.activeElement === items()[0]);
    await key(items()[0], "End");
    assert.ok(document.activeElement === items().at(-1));
    await key(items().at(-1)!, "Home");
    assert.ok(document.activeElement === items()[0]);
    await key(items()[0], "Escape");
    assert.equal(document.querySelector('[role="menu"]'), null);
    assert.ok(document.activeElement === row);
    await act(async () => root.unmount());
  });
});

test("Edit sidebar draws the sidebar's own glyphs and Dispatch has its Dispatch glyph", () => {
  const read = (path: string) =>
    readFileSync(new URL(`../../src/${path}`, import.meta.url), "utf8");
  const dialog = read("sidebar/EditSidebarDialog.tsx");
  const nav = read("sidebar/MainNav.tsx");
  assert.doesNotMatch(dialog, /BriefcaseIcon|ProjectsIcon|KeyIcon|PulseIcon/);
  assert.doesNotMatch(nav + dialog, /MobilePhone/);
  assert.equal((nav.match(/name="Dispatch"/g) ?? []).length, 2);
  assert.match(dialog, /customize: <AppIcon name="Tool" \/>/);
  assert.match(dialog, /dispatch: <AppIcon name="Dispatch" \/>/);
});

test("section and group headings use the CaretRight caret on every surface, pointing down while open", () => {
  const read = (path: string) =>
    readFileSync(new URL(`../../src/${path}`, import.meta.url), "utf8");
  for (const file of [
    "sidebar/ConversationListLabels.tsx",
    "sidebar/GroupToggle.tsx",
  ]) {
    const source = read(file);
    assert.match(source, /<AppIcon name="CaretRight" \/>/);
    assert.doesNotMatch(source, /ChevronDownIcon/);
  }
  assert.match(
    css("sidebar/sidebar-list.css"),
    /\.section-toggle > \.app-icon\s*\{[^}]*rotate: 90deg/s,
  );
  assert.match(
    css("sidebar/sidebar-list.css"),
    /\.section-toggle\.collapsed > \.app-icon\s*\{\s*rotate: 0deg/,
  );
  assert.match(
    css("sidebar/sidebar-groups.css"),
    /\.group-toggle\[aria-expanded="false"\] > \.app-icon\s*\{\s*rotate: 0deg/,
  );
});

test("Code's group heading menu reads Rename section, New section and Delete section", async () => {
  const { GroupHeader } = await import("../../src/sidebar/GroupHeader");
  for (const [section, expected] of [
    [true, ["Rename section", "New section", "Delete section"]],
    [false, ["Rename group", "New group…", "Delete group"]],
  ] as const)
    await withDom(async (document, window) => {
      const root = createRoot(document.querySelector("#root")!);
      await act(async () =>
        root.render(
          createElement(GroupHeader, {
            label: "Work",
            groupId: "g1",
            members: 2,
            section,
          }),
        ),
      );
      await act(async () => {
        const event = new window.Event("contextmenu", {
          bubbles: true,
          cancelable: true,
        });
        Object.defineProperty(event, "clientX", { value: 10 });
        Object.defineProperty(event, "clientY", { value: 10 });
        document.querySelector(".row-group-label")!.dispatchEvent(event);
      });
      const labels = [...document.querySelectorAll('[role="menuitem"]')].map(
        (item) => item.textContent,
      );
      for (const label of expected)
        assert.ok(labels.includes(label), `${label} in ${labels.join("|")}`);
      await act(async () => root.unmount());
    });
});

test("the Recents filter button uses the icon font's Filter glyph on the desktop too", async () => {
  const { HistoryFilter } = await import("../../src/sidebar/HistoryFilter");
  const { defaultFilter } = await import("../../src/sidebar/listFilter");
  for (const mode of ["chat", "code"] as const) {
    const { document } = parseHTML(
      renderToStaticMarkup(
        createElement(HistoryFilter, {
          mode,
          value: defaultFilter,
          onChange: () => {},
        }),
      ),
    );
    assert.ok(document.querySelector('[data-icon="Filter"]'));
  }
});

test("a session under its parent starts 20px in; a lone child or one in the other section does not", async () => {
  const { isNestedSidebarRow } = await import("../../src/sidebar/listFilter");
  const row = (id: string, patch: Record<string, unknown> = {}) =>
    ({
      id,
      title: id,
      mode: "code",
      providerId: "p",
      model: "m",
      pinned: false,
      archived: false,
      createdAt: 1,
      updatedAt: 1,
      turns: [],
      ...patch,
    }) as never;
  const all = [
    row("parent"),
    row("child", { parentSessionId: "parent" }),
    row("orphan", { parentSessionId: "gone" }),
    row("pinned-child", { parentSessionId: "parent", pinned: true }),
  ];
  assert.ok(!isNestedSidebarRow(all[0], all));
  assert.ok(isNestedSidebarRow(all[1], all));
  assert.ok(!isNestedSidebarRow(all[2], all));
  assert.ok(!isNestedSidebarRow(all[3], all));
  assert.match(
    css("sidebar/sidebar-list.css"),
    /\.conversation-row\[data-nested\] > \.conversation-link\s*\{\s*margin-inline-start: 20px/,
  );
});

test("a searchable submenu such as Add to project is at least 240px wide", () => {
  assert.match(
    css("ui/menu.css"),
    /\.menu\[data-searchable\]\s*\{\s*min-width: 240px/,
  );
  assert.match(
    readFileSync(new URL("../../src/ui/Submenu.tsx", import.meta.url), "utf8"),
    /data-searchable=\{searchable !== undefined \? "" : undefined\}/,
  );
});

test("the menu over selected rows counts what each action runs on, gives icons and keys, and offers both halves of a mixed selection", async () => {
  const { bulkEntries } = await import("../../src/sidebar/BulkRowMenu");
  const row = (id: string, patch: Record<string, unknown> = {}) =>
    ({
      id,
      title: id,
      mode: "chat",
      providerId: "p",
      model: "m",
      pinned: false,
      archived: false,
      createdAt: 1,
      updatedAt: 1,
      turns: [],
      ...patch,
    }) as never;
  const calls: string[] = [];
  const rows = [row("a", { pinned: true, unread: true }), row("b"), row("c")];
  const entries = bulkEntries(
    rows,
    {
      onTogglePin: (c: { id: string }) => calls.push(`pin:${c.id}`),
      onToggleUnread: (c: { id: string }) => calls.push(`unread:${c.id}`),
      onToggleArchive: (c: { id: string }) => calls.push(`archive:${c.id}`),
      onDeleteMany: (ids) => calls.push(`delete:${ids.join(",")}`),
    },
    () => {},
    {
      list: [{ id: "g1", name: "Work" }],
      members: {},
      moveTo: () => {},
      newGroup: (list) => calls.push(`new-group:${list.length}`),
    },
  );
  const item = (label: string) =>
    entries.find((e) => "label" in e && e.label === label) as
      | (Extract<(typeof entries)[number], { label: string }> & {
          onSelect: () => void;
        })
      | undefined;
  // Mixed pinned: both halves, each counting its own rows; the key is Pin's.
  assert.equal(item("Pin 2")?.hint, "P");
  assert.equal(item("Unpin 1")?.hint, undefined);
  assert.equal(item("Mark 1 as read")?.hint, "U");
  assert.equal(item("Mark 2 as unread")?.hint, undefined);
  assert.equal(item("Archive 3")?.hint, "A");
  assert.equal(item("Delete 3")?.hint, "D");
  for (const label of [
    "Pin 2",
    "Unpin 1",
    "Mark 1 as read",
    "Mark 2 as unread",
    "Archive 3",
    "Delete 3",
  ])
    assert.ok(item(label)?.icon, `${label} has an icon`);
  item("Pin 2")!.onSelect();
  item("Unpin 1")!.onSelect();
  item("Delete 3")!.onSelect();
  assert.deepEqual(calls, ["pin:b", "pin:c", "pin:a", "delete:a,b,c"]);
  // Move 3 to group ends in New group…, which asks for the name.
  const move = entries.find(
    (e) => "label" in e && e.label === "Move 3 to group",
  ) as { submenu: { label?: string; onSelect?: () => void }[] };
  const last = move.submenu.at(-1)!;
  assert.equal(last.label, "New group…");
  last.onSelect!();
  assert.equal(calls.at(-1), "new-group:3");
});

test("the update button, status strip and notice read in the interface language", async () => {
  const { setLocale } = await import("../../src/i18n");
  const { sourceLocale } = await import("../../shared/locales");
  const { RelaunchToUpdate, UpdateStatusStrip } =
    await import("../../src/updates/RelaunchToUpdate");
  const { UpdateNotice } = await import("../../src/policy/UpdateNotice");
  await setLocale("zh-CN");
  try {
    const button = renderToStaticMarkup(
      createElement(RelaunchToUpdate, {
        version: "0.0.33",
        onError: () => {},
      }),
    );
    assert.match(button, /重启以更新/);
    assert.match(button, /title="安装 Claudex 0\.0\.33 并重启"/);
    const retry = renderToStaticMarkup(
      createElement(RelaunchToUpdate, {
        version: "0.0.33",
        retry: true,
        onError: () => {},
      }),
    );
    assert.match(retry, /重新启动以重试更新/);
    assert.match(retry, /上次更新未完成/);
    assert.match(
      renderToStaticMarkup(
        createElement(UpdateStatusStrip, { phase: "checking" }),
      ),
      /正在检查更新/,
    );
    const notice = (state: "required" | "available", enforced: boolean) =>
      renderToStaticMarkup(
        createElement(UpdateNotice, {
          update: {
            state,
            currentVersion: "0.0.1",
            latestVersion: "0.0.33",
            enforced,
          } as never,
          onDismiss: () => {},
        }),
      );
    const available = notice("available", false);
    assert.match(available, /有可用更新/);
    assert.match(available, /Claudex 0\.0\.33 已可用/);
    assert.match(available, /aria-label="忽略"/);
    const required = notice("required", true);
    assert.match(required, /需要更新/);
    assert.match(required, /请安装 Claudex 0\.0\.33/);
  } finally {
    await setLocale(sourceLocale);
  }
});

test("light theme: headings lift to the secondary ink under the pointer on the desktop and the web, Code's group headings rest muted", () => {
  const light = css("sidebar/sidebar-light.css");
  assert.match(
    light,
    /@media \(hover: hover\) \{\s*:root\[data-theme="light"\] \.section-label:hover \{\s*color: var\(--text-secondary\)/,
  );
  const web = css("styles/95-web.css");
  assert.match(
    web,
    /@media \(hover: hover\) \{\s*:root\[data-surface="web"\]\[data-theme="light"\] \.section-label:hover \{\s*color: var\(--text-secondary\)/,
  );
  // The web's light secondary ink is the official #52514e; muted stays #898781.
  assert.match(
    web,
    /:root\[data-surface="web"\]\[data-theme="light"\] \{[^}]*--text-secondary: #52514e;[^}]*--text-muted: #898781;/s,
  );
  assert.match(
    css("sidebar/sidebar-groups.css"),
    /:root\[data-theme="light"\] \.row-group-label \{\s*color: #898781;/,
  );
});

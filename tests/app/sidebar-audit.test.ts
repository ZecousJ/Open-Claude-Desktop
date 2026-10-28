import test from "node:test";
import assert from "node:assert/strict";
import { act, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { createRoot } from "react-dom/client";
import { MainNav, MoreMenu } from "../../src/sidebar/MainNav";
import { SurfaceSwitch } from "../../src/sidebar/SurfaceSwitch";
import {
  defaultHiddenNavItems,
  defaultHiddenNavItemsFor,
  moreNavState,
  navBadgeLabel,
  navItems,
  sidebarNav,
  type NavBadge,
} from "../../src/sidebar/navItems";
import { readSource } from "../support/read-source";

const noop = () => {};
const documentOf = (element: Parameters<typeof renderToStaticMarkup>[0]) =>
  parseHTML(renderToStaticMarkup(element)).document;

test("unified navigation is independent of the task execution capability", () => {
  for (const mode of ["chat", "cowork"] as const) {
    for (const hub of [false, true]) {
      const nav = sidebarNav(mode, undefined, hub);
      assert.deepEqual(
        nav.shown.map((item) => item.id),
        ["projects", "artifacts", "api", "status"],
      );
      // Customize and Scheduled live in More; Dispatch has no row.
      assert.deepEqual(
        nav.inMore.map((item) => item.id),
        ["scheduled", "customize"],
      );
      assert.deepEqual(nav.offered, nav.shown);
    }
  }
});

test("API and Service status stay on the sidebar even with legacy saved navigation preferences", () => {
  // Both sit on the sidebar in every mode.
  assert.deepEqual(defaultHiddenNavItems, ["dispatch"]);
  for (const mode of ["chat", "cowork", "code"] as const) {
    for (const hidden of [
      [],
      ["artifacts", "scheduled", "customize"],
      ["api", "status"],
    ]) {
      const nav = sidebarNav(mode, hidden);
      assert.ok(nav.shown.some((item) => item.id === "api"));
      assert.ok(nav.shown.some((item) => item.id === "status"));
      assert.ok(
        !nav.inMore.some((item) => ["api", "status"].includes(item.id)),
      );
      assert.ok(!nav.shown.some((item) => item.id === "dispatch"));
      if (mode !== "code") assert.equal(nav.shown.length, 4);
    }
  }
});

test("Code retains its own collection navigation", () => {
  const nav = sidebarNav("code");
  assert.deepEqual(
    nav.shown.map((item) => item.id),
    ["artifacts", "api", "status"],
  );
  assert.deepEqual(
    nav.inMore.map((item) => item.id),
    ["scheduled", "customize"],
  );
  assert.ok(defaultHiddenNavItemsFor("code").includes("scheduled"));
});

test("#18 More uses the selected hidden item's label, selection and accessible badge", () => {
  for (const badge of [
    "beta",
    "ant",
    "lab",
    "preview",
    "new-neutral",
  ] as NavBadge[]) {
    const document = documentOf(
      createElement(MoreMenu, {
        mode: "code",
        page: "customize",
        extra: [{ id: "customize", label: "Customize", badge, icon: null }],
        onPageChange: noop,
        onEditSidebar: noop,
      }),
    );
    const trigger = document.querySelector(".main-nav-more > button")!;
    assert.ok(trigger.classList.contains("current"));
    assert.equal(
      trigger.getAttribute("aria-label"),
      `Customize, ${navBadgeLabel(badge)}`,
    );
    assert.equal(trigger.children[1]?.textContent, "Customize");
    assert.equal(
      trigger.querySelector(".main-nav-badge")?.textContent,
      badge === "lab" ? undefined : navBadgeLabel(badge),
    );
    assert.equal(
      Boolean(trigger.querySelector('[aria-label="New items available"]')),
      badge === "new-neutral",
    );
  }
});

test("#18 unselected More has its own accessible name and seen new items do not mark it", () => {
  const items = [
    { id: "customize", label: "Customize", badge: "new-neutral" as const },
  ];
  assert.deepEqual(moreNavState(items, "chat"), {
    selected: undefined,
    hasUnseenNew: true,
  });
  assert.deepEqual(moreNavState(items, "customize", ["customize"]), {
    selected: items[0],
    hasUnseenNew: false,
  });
  assert.equal(
    moreNavState([{ ...items[0], badge: "new" }], "chat").hasUnseenNew,
    false,
  );
  const document = documentOf(
    createElement(MoreMenu, {
      mode: "code",
      page: "chat",
      extra: [],
      onPageChange: noop,
      onEditSidebar: noop,
    }),
  );
  const trigger = document.querySelector("button")!;
  assert.equal(trigger.getAttribute("aria-label"), "More navigation items");
  assert.equal(trigger.textContent, "More");
  assert.ok(!trigger.classList.contains("current"));
});

test("#18 opening More clears its marker; using a new item clears its badge across reloads", async () => {
  const { window, document } = parseHTML(
    "<html><body><div id='root'></div></body></html>",
  );
  const stored = new Map<string, string>();
  const globals = {
    window,
    document,
    localStorage: {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => stored.set(key, value),
    },
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const descriptors = new Map(
    Object.keys(globals).map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  for (const [key, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value,
    });
  }
  const root = createRoot(document.querySelector("#root")!);
  const pages: string[] = [];
  const render = (page: string) =>
    createElement(MoreMenu, {
      mode: "code",
      page,
      extra: [
        {
          id: "customize",
          label: "Customize",
          badge: "new-neutral",
          icon: null,
        },
      ],
      onPageChange: (page) => pages.push(page),
      onEditSidebar: noop,
    });
  try {
    await act(async () => root.render(render("chat")));
    assert.ok(document.querySelector(".main-nav-new-marker"));
    const trigger = document.querySelector<HTMLButtonElement>(
      ".main-nav-more > button",
    )!;
    trigger.getBoundingClientRect = () => ({ right: 200, top: 80 }) as DOMRect;
    await act(async () => {
      trigger.click();
    });
    assert.equal(document.querySelector(".main-nav-new-marker"), null);
    assert.equal(
      document.querySelector(".main-nav-more-menu .main-nav-badge")
        ?.textContent,
      "New",
    );
    await act(async () => {
      document.querySelector<HTMLButtonElement>('[role="menuitem"]')!.click();
    });
    assert.deepEqual(pages, ["customize"]);
    assert.equal(document.querySelector('[role="menu"]'), null);
    await act(async () =>
      root.render(
        createElement(MoreMenu, {
          ...render("customize").props,
          key: "reload",
        }),
      ),
    );
    assert.equal(document.querySelector(".main-nav-new-marker"), null);
    assert.equal(document.querySelector(".main-nav-badge"), null);
    assert.equal(
      document
        .querySelector(".main-nav-more > button")
        ?.getAttribute("aria-label"),
      "Customize",
    );
  } finally {
    await act(async () => root.unmount());
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

test("#22 New is a direct navigation row, without a create-menu or disabled window trigger", () => {
  for (const mode of ["chat", "cowork", "code"] as const) {
    const document = documentOf(
      createElement(MainNav, {
        mode,
        page: "chat",
        onNewChat: noop,
        onPageChange: noop,
        onEditSidebar: noop,
      }),
    );
    const trigger = document.querySelector("button.new")!;
    assert.equal(
      trigger.querySelector("span:not(.nav-glyph)")?.textContent,
      "New",
    );
    assert.equal(trigger.getAttribute("aria-haspopup"), null);
    assert.equal(document.querySelector(".main-nav-new-window"), null);
  }
});

test("#13 desktop keeps two icon segments with current Mode radio names", () => {
  for (const mode of ["chat", "cowork", "code"] as const) {
    const document = documentOf(
      createElement(SurfaceSwitch, {
        mode,
        conversations: [],
        onSwitch: noop,
      }),
    );
    const group = document.querySelector('[role="radiogroup"]')!;
    assert.equal(group.getAttribute("aria-label"), "Mode");
    assert.equal(group.querySelectorAll('[role="radio"]').length, 2);
    const selected = group.querySelector('[aria-checked="true"]')!;
    assert.equal(
      selected.getAttribute("aria-label"),
      mode === "code" ? "Code" : "Claudex",
    );
    assert.equal(selected.getAttribute("tabindex"), "0");
    assert.equal(group.querySelectorAll('[tabindex="-1"]').length, 1);
  }
});

test("#13 the track and thumb use the live CDS colors in both themes", () => {
  const css = readSource(
    new URL("../../src/sidebar/sidebar.css", import.meta.url),
    "utf8",
  );
  assert.match(css, /--cds-segmented-control-track: rgb\(255 255 255 \/ 5%\)/);
  assert.match(css, /--cds-segmented-control-thumb: rgb\(255 255 255 \/ 10%\)/);
  assert.match(css, /--cds-segmented-control-track: rgb\(11 11 11 \/ 5%\)/);
  assert.match(css, /--cds-segmented-control-thumb: #fff/);
  assert.match(css, /background: var\(--cds-segmented-control-track\)/);
  assert.match(css, /background: var\(--cds-segmented-control-thumb\)/);
});

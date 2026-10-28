import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { act, createElement, useState } from "react";
import { routineDom } from "../support/routine-dom";
import ConnectorFeatured from "../../src/settings/directory/ConnectorFeatured";
import { CustomizePage } from "../../src/collections/customize/CustomizePage";
import { HostContext } from "../../src/host/HostContext";
import { webHost } from "../../shared/host";
import { defaultSettings } from "../../electron/store/store";
import type { ApprovedDirectoryEntry } from "../../shared/directory-submissions";
import {
  customizePath,
  parseCustomizePath,
  type CustomizePlace,
} from "../../src/web/customize-route";
import { AppContext, type AppController } from "../../src/app/AppContext";
import { CustomizeRoute } from "../../src/app/CollectionPages";
import {
  directoryConnectors,
  findConnectors,
  defaultConnectorFilter,
  type CatalogueConnector,
} from "../../shared/connectors-catalogue";

const noop = () => {};
const host = {
  ...webHost,
  capabilities: { ...webHost.capabilities, customConnectors: true },
};
const featured = (id: string): CatalogueConnector => ({
  id,
  name: id,
  description: `Description ${id}`,
  byline: "by Runtime publisher",
  type: "community",
  topic: "",
  icon: "server",
  url: `https://${id}.example/mcp`,
  iconUrl: `https://${id}.example/icon.svg`,
  featured: {
    title: `Feature ${id}`,
    subtitle: `Published subtitle ${id}`,
    curator: "Runtime curator",
  },
});

async function connectorDom(bridge: Partial<Window["desktop"]> = {}) {
  const e = await routineDom(
    {
      customizeSkills: async () => [],
      mcpServers: async () => ({
        configPath: "/profile/mcp.json",
        servers: [],
      }),
      linearStatus: async () => ({ connected: false }),
      listApprovedDirectory: async () => [],
      listPlugins: async () => ({
        plugins: [],
        marketplaces: [],
        loadErrors: [],
      }),
      copyText: async () => {},
      ...bridge,
    },
    { jsdom: true },
  );
  delete e.document.documentElement.dataset.motion;
  let reduced = false;
  const listeners = new Set<() => void>();
  e.window.matchMedia = (() => ({
    get matches() {
      return reduced;
    },
    addEventListener: (_type: string, listener: () => void) => {
      listeners.add(listener);
    },
    removeEventListener: (_type: string, listener: () => void) => {
      listeners.delete(listener);
    },
  })) as never;
  const globals = {
    location: e.window.location,
    history: e.window.history,
    sessionStorage: e.window.sessionStorage,
    localStorage: e.window.localStorage,
    innerWidth: 1440,
    innerHeight: 900,
    addEventListener: e.window.addEventListener.bind(e.window),
    removeEventListener: e.window.removeEventListener.bind(e.window),
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
  const style = e.document.createElement("style");
  style.textContent = [
    "src/styles/00-foundation.css",
    "src/settings/directory/connector-directory.css",
    "src/collections/customize/customize-directory.css",
    "src/collections/customize/customize-connectors.css",
  ]
    .map((path) => readFileSync(path, "utf8"))
    .join("\n");
  e.document.head.append(style);
  // JSDOM lacks AnimationEvent; React selects its WebKit event name.
  return {
    ...e,
    active: () =>
      e.document.querySelector<HTMLElement>(
        '.connector-featured-slide[aria-hidden="false"]',
      )!,
    progress: () =>
      e.document.querySelector<HTMLElement>(
        '.connector-featured-dots [aria-current="true"] > span',
      )!,
    carousel: () =>
      e.document.querySelector<HTMLElement>(
        '[aria-roledescription="carousel"]',
      )!,
    async motion(value: boolean) {
      await act(async () => {
        reduced = value;
        for (const listener of listeners) listener();
      });
    },
    async settle(predicate: () => boolean) {
      for (let count = 0; count < 60 && !predicate(); count++)
        await act(async () => {
          await new Promise((done) => setTimeout(done, 5));
        });
      assert.ok(predicate());
    },
    async clean() {
      await e.clean();
      for (const [key, value] of saved) {
        if (value) Object.defineProperty(globalThis, key, value);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}

const carousel = (
  entries: CatalogueConnector[],
  onOpen: (entry: CatalogueConnector) => void = noop,
) =>
  createElement(ConnectorFeatured, {
    entries,
    onOpen,
    variant: "customize",
    remoteIcons: false,
  });

test("settings43 source carousel keeps the selected record through inventory reorder and refresh", async () => {
  const e = await connectorDom();
  const a = featured("a"),
    b = featured("b"),
    c = featured("c");
  const opened: CatalogueConnector[] = [];
  try {
    await e.render(
      carousel([a, b, c], (row) => {
        opened.push(row);
      }),
    );
    await e.click('[aria-label="Next slide"]');
    assert.equal(e.active().getAttribute("aria-label"), "Feature b");
    const refreshed = {
      ...b,
      name: "Refreshed b",
      featured: { ...b.featured!, title: "Refreshed feature b" },
    };
    await e.render(
      carousel([a, c, refreshed], (row) => {
        opened.push(row);
      }),
    );
    assert.equal(e.active().getAttribute("aria-label"), "Refreshed feature b");
    assert.equal(
      e.document
        .querySelector('.connector-featured-dots [aria-current="true"]')
        ?.getAttribute("aria-label"),
      "Show Refreshed feature b",
    );
    await e.event(e.active().querySelector("button")!, "click");
    assert.equal(
      opened[0],
      refreshed,
      "Explore uses the latest selected directory record",
    );
    await e.render(carousel([a, c]));
    assert.equal(e.active().getAttribute("aria-label"), "Feature a");
    await e.render(carousel([a, refreshed, c]));
    assert.equal(e.active().getAttribute("aria-label"), "Refreshed feature b");
    assert.equal(
      e.document.querySelectorAll(
        '.connector-featured-slide[aria-hidden="true"][inert]',
      ).length,
      2,
    );
  } finally {
    await e.clean();
  }
});

test("settings43 completed autoplay waits for both pointer and keyboard focus to leave, then advances once", async () => {
  const e = await connectorDom();
  try {
    await e.render(carousel([featured("a"), featured("b"), featured("c")]));
    const root = e.carousel();
    await e.event(root, "pointerover", {
      pointerType: "mouse",
      relatedTarget: e.document.body,
    });
    await e.event(e.active().querySelector("button")!, "focusin", {
      relatedTarget: null,
    });
    assert.equal(e.progress().style.animationPlayState, "paused");
    await e.event(e.progress(), "webkitAnimationEnd");
    assert.equal(e.active().getAttribute("aria-label"), "Feature a");
    await e.event(root, "pointerout", {
      pointerType: "mouse",
      relatedTarget: e.document.body,
    });
    assert.equal(
      e.active().getAttribute("aria-label"),
      "Feature a",
      "focus keeps the source pause active",
    );
    await e.event(e.active().querySelector("button")!, "focusout", {
      relatedTarget: null,
    });
    assert.equal(e.active().getAttribute("aria-label"), "Feature b");
    await e.event(root, "pointerout", {
      pointerType: "mouse",
      relatedTarget: e.document.body,
    });
    assert.equal(e.active().getAttribute("aria-label"), "Feature b");
    assert.equal(e.progress().style.animationPlayState, "running");
  } finally {
    await e.clean();
  }
});

test("settings43 manual selection retires queued autoplay; touch does not emulate hover pause", async () => {
  const e = await connectorDom();
  try {
    await e.render(carousel([featured("a"), featured("b"), featured("c")]));
    await e.event(e.carousel(), "pointerover", {
      pointerType: "touch",
      relatedTarget: e.document.body,
    });
    assert.equal(e.progress().style.animationPlayState, "running");
    await e.event(e.progress(), "webkitAnimationEnd");
    assert.equal(e.active().getAttribute("aria-label"), "Feature b");
    await e.event(e.carousel(), "pointerover", {
      pointerType: "mouse",
      relatedTarget: e.document.body,
    });
    await e.event(e.progress(), "webkitAnimationEnd");
    await e.click('[aria-label="Next slide"]');
    assert.equal(e.active().getAttribute("aria-label"), "Feature c");
    await e.event(e.carousel(), "pointerout", {
      pointerType: "mouse",
      relatedTarget: e.document.body,
    });
    assert.equal(e.active().getAttribute("aria-label"), "Feature c");
    assert.equal(e.progress().classList.contains("auto"), false);
  } finally {
    await e.clean();
  }
});

test("settings43 carousel follows system and app reduced-motion preferences without losing manual navigation", async () => {
  const e = await connectorDom();
  try {
    await e.render(carousel([featured("a"), featured("b")]));
    assert.ok(e.progress().classList.contains("auto"));
    await e.motion(true);
    assert.equal(e.progress().classList.contains("auto"), false);
    assert.equal(
      e.document
        .querySelector(".connector-featured-slides")
        ?.getAttribute("aria-live"),
      "polite",
    );
    await e.motion(false);
    assert.ok(e.progress().classList.contains("auto"));
    await act(async () => {
      e.document.documentElement.dataset.motion = "reduced";
    });
    assert.equal(e.progress().classList.contains("auto"), false);
    await e.event(e.progress(), "webkitAnimationEnd");
    assert.equal(e.active().getAttribute("aria-label"), "Feature a");
    await e.click('[aria-label="Next slide"]');
    assert.equal(e.active().getAttribute("aria-label"), "Feature b");
  } finally {
    await e.clean();
  }
});

test("settings43 feature artwork uses the selected published record, source icon scale, and declared curator", async () => {
  const e = await connectorDom();
  const record = featured("published");
  try {
    await e.render(
      createElement(ConnectorFeatured, {
        entries: [record],
        variant: "customize",
        remoteIcons: true,
        onOpen: noop,
      }),
    );
    const tile = e.document.querySelector<HTMLElement>(
      ".customize-connector-featured-cluster > span",
    )!;
    const image = tile.querySelector<HTMLImageElement>("img")!;
    assert.equal(tile.style.width, "83px");
    assert.equal(image.style.width, "59px");
    assert.equal(image.style.height, "59px");
    assert.equal(image.src, record.iconUrl);
    assert.equal(
      e.document.querySelector(".connector-featured-slide small")?.textContent,
      "Curated by Runtime curator",
    );
    assert.equal(
      e.document.body.textContent?.includes("Curated by Anthropic"),
      false,
    );
    assert.equal(
      e.document.querySelector('[aria-roledescription="carousel"]'),
      null,
    );
    await e.render(
      createElement(ConnectorFeatured, {
        entries: [{ ...record, featured: undefined }],
        variant: "customize",
        onOpen: noop,
      }),
    );
    assert.equal(e.document.querySelector(".connector-featured-slide"), null);
  } finally {
    await e.clean();
  }
});

const published = (id: string): ApprovedDirectoryEntry => ({
  id,
  kind: "mcp",
  name: `Runtime ${id}`,
  description: `Runtime connector ${id}`,
  author: "Runtime publisher",
  url: `https://${id}.example/mcp`,
  added: "2025-11-12",
  curation: {
    featured: {
      title: `Runtime feature ${id}`,
      subtitle: `Runtime subtitle ${id}`,
      curator: "Runtime curator",
    },
  },
});
function RoutedDiscovery() {
  const [place, setPlace] = useState<CustomizePlace>({
    section: "connectors",
    view: "discover",
  });
  return createElement(
    HostContext.Provider,
    { value: host },
    createElement(CustomizePage, {
      settings: defaultSettings,
      route: place,
      onRouteChange: setPlace,
      onUseSkill: noop,
      onOpenSettings: noop,
      onConfirmRemove: noop,
      onError: (error) => {
        throw error;
      },
    }),
  );
}

test("settings43 routed discovery consumes real curation/counts and Explore opens that connector in-app (settings55 reuse)", async () => {
  const records = [published("one"), published("two")];
  records[0].curation!.featured!.memberIds = records.map((record) => record.id);
  const e = await connectorDom({ listApprovedDirectory: async () => records });
  try {
    await e.render(createElement(RoutedDiscovery));
    await e.settle(
      () => !!e.document.querySelector('[aria-roledescription="carousel"]'),
    );
    assert.equal(e.active().getAttribute("aria-label"), "Runtime feature one");
    assert.equal(
      e
        .active()
        .querySelectorAll(".customize-connector-featured-cluster > span")
        .length,
      2,
    );
    const heading = [
      ...e.document.querySelectorAll(".customize-connector-shelf-head h2"),
    ].find((node) => node.firstChild?.textContent === "Top connectors")!;
    assert.ok(heading);
    assert.equal(
      heading.querySelector("span")?.textContent,
      String(directoryConnectors(records).length),
    );
    const style = (selector: string) =>
      getComputedStyle(e.document.querySelector(selector)!);
    assert.equal(
      style(".customize-connector-featured .connector-featured-slide")
        .minHeight,
      "264px",
    );
    assert.equal(style(".connector-featured-slide h2").fontSize, "22px");
    assert.equal(style(".connector-featured-slide h2").lineHeight, "28px");
    assert.equal(style(".connector-featured-slide small").fontSize, "12px");
    assert.equal(style(".connector-featured-slide small").lineHeight, "17px");
    assert.equal(style(".connector-featured-slide p").fontSize, "14px");
    assert.equal(style(".connector-featured-slide p").lineHeight, "20px");
    assert.equal(
      style(".connector-featured-slide .directory-outline-button").minWidth,
      "auto",
    );
    assert.equal(
      style(".connector-featured-slide .directory-outline-button").height,
      "40px",
    );
    assert.equal(style(".connector-directory-seat").paddingTop, "1px");
    assert.equal(style(".connector-featured-next").width, "40px");
    assert.equal(style(".connector-featured-next").height, "40px");
    assert.equal(
      style('.connector-featured-dots button[aria-current="true"]').width,
      "32px",
    );
    assert.equal(
      style(".connector-featured-dots button:not([aria-current])").width,
      "8px",
    );
    assert.equal(getComputedStyle(heading).fontSize, "15px");
    assert.equal(getComputedStyle(heading).lineHeight, "20px");
    await e.click('[aria-label="Next slide"]');
    await e.event(e.active().querySelector("button")!, "click");
    await e.settle(
      () =>
        e.document.querySelector(".connector-published-detail h1")
          ?.textContent === "Runtime two",
    );
    assert.equal(
      e.document.querySelector(".connector-published-url > span")?.textContent,
      records[1].url,
    );
    assert.equal(
      e.document.querySelector(".connector-published-metadata a"),
      null,
      "missing publisher website is not fabricated",
    );
    await e.click('.connector-published-nav a[href="/customize/connectors"]');
    await e.settle(
      () => !!e.document.querySelector('[aria-roledescription="carousel"]'),
    );
    assert.equal(
      e.document.querySelectorAll(".connector-featured-slide").length,
      2,
    );
  } finally {
    await e.clean();
  }
});

function HistoryDiscovery() {
  const [controllerScope] = useState({});
  return createElement(
    HostContext.Provider,
    { value: host },
    createElement(
      AppContext.Provider,
      {
        value: {
          accountId: "settings28-connectors",
          controllerScope,
          mode: "chat",
          snapshot: {
            settings: defaultSettings,
            conversations: [],
            projects: [],
            approvals: [],
          },
          report: (error: unknown) => {
            throw error;
          },
          openSettingsTab: noop,
          setConfirm: noop,
        } as unknown as AppController,
      },
      createElement(CustomizeRoute),
    ),
  );
}

test("settings43 published Show all anchors route real inventory through refresh and browser back", async () => {
  const records = [
    { ...published("trending"), curation: { isTrending: true, isNew: false } },
    { ...published("new"), curation: { isTrending: false, isNew: true } },
    { ...published("ordinary"), curation: { isTrending: false, isNew: false } },
  ];
  const copies: string[] = [];
  const e = await connectorDom({
    listApprovedDirectory: async () => records,
    copyText: async (text) => {
      copies.push(text);
    },
    mcpServers: async () => ({
      servers: [
        {
          name: "private-runtime",
          displayName: "Private Runtime",
          state: "ready",
          tools: 1,
          command: "fixture-runtime",
        },
      ],
      configPath: "",
    }),
  });
  e.window.history.replaceState({}, "", "/customize/connectors");
  const rows = () =>
    [
      ...e.document.querySelectorAll<HTMLAnchorElement>(
        ".customize-connector-category-results .connector-directory-row-main",
      ),
    ].map((link) => link.getAttribute("href"));
  const heading = () =>
    e.document.querySelector(".customize-connector-category-header h1")
      ?.textContent;
  try {
    await e.render(createElement(HistoryDiscovery));
    await e.settle(
      () =>
        !!e.document.querySelector('[aria-label="Show all Top connectors"]'),
    );
    const top = e.document.querySelector<HTMLAnchorElement>(
      '[aria-label="Show all Top connectors"]',
    )!;
    assert.equal(top.tagName, "A");
    assert.equal(top.getAttribute("href"), "/customize/connectors/all");
    assert.ok(e.document.querySelector('[aria-label="View private-runtime"]'));
    assert.equal(
      e.document
        .querySelector('[aria-label="Show all Trending connectors"]')
        ?.getAttribute("href"),
      "/customize/connectors/trending",
    );
    assert.equal(
      e.document
        .querySelector('[aria-label="Show all New connectors"]')
        ?.getAttribute("href"),
      "/customize/connectors/new",
    );
    await e.event(top, "click");
    await e.settle(
      () =>
        heading() === "All connectors" &&
        rows().includes("/customize/connectors/id/ordinary"),
    );
    assert.equal(e.window.location.pathname, "/customize/connectors/all");
    assert.equal(
      e.document.querySelector('[aria-label="View private-runtime"]'),
      null,
      "Top Show all retains its published inventory rather than mixing the private shelf",
    );
    assert.ok(
      e.document.querySelector('[aria-label="Filter"][aria-haspopup="menu"]'),
    );
    assert.ok(e.document.querySelector('[aria-label="Add connector"]'));
    assert.equal(
      e.document.querySelector(
        '[role="tablist"][aria-label="Customize sections"]',
      ),
      null,
    );
    assert.equal(
      e.document.querySelector(".customize-connector-category-results h2")
        ?.textContent,
      "Connectors",
    );
    assert.equal(rows().length, directoryConnectors(records).length);
    await e.click(".connector-published-copy");
    assert.deepEqual(copies, ["http://localhost/customize/connectors/all"]);
    await e.render(createElement("div", {}, "Refresh"));
    await e.render(createElement(HistoryDiscovery));
    await e.settle(
      () =>
        heading() === "All connectors" &&
        rows().includes("/customize/connectors/id/ordinary"),
    );
    assert.equal(e.window.location.pathname, "/customize/connectors/all");
    await act(async () => {
      e.window.history.back();
      await new Promise((done) => setTimeout(done, 15));
    });
    await e.settle(
      () =>
        !heading() &&
        !!e.document.querySelector(
          '[aria-label="Show all Trending connectors"]',
        ),
    );
    assert.equal(e.window.location.pathname, "/customize/connectors");
    await e.click('[aria-label="Show all Trending connectors"]');
    await e.settle(() => heading() === "Trending" && rows().length === 1);
    assert.equal(e.window.location.pathname, "/customize/connectors/trending");
    assert.deepEqual(rows(), ["/customize/connectors/id/trending"]);
    await e.render(createElement("div", {}, "Refresh"));
    await e.render(createElement(HistoryDiscovery));
    await e.settle(() => heading() === "Trending" && rows().length === 1);
    assert.deepEqual(rows(), ["/customize/connectors/id/trending"]);
    await e.click(".customize-connector-category-header > a");
    await e.settle(
      () =>
        !!e.document.querySelector('[aria-label="Show all New connectors"]'),
    );
    assert.equal(e.window.location.pathname, "/customize/connectors");
    await e.click('[aria-label="Show all New connectors"]');
    const expectedNew = findConnectors(
      { ...defaultConnectorFilter, type: "new" },
      directoryConnectors(records),
    ).map((entry) => `/customize/connectors/id/${entry.id}`);
    await e.settle(
      () => heading() === "New" && rows().length === expectedNew.length,
    );
    assert.deepEqual(rows(), expectedNew);
    assert.ok(rows().includes("/customize/connectors/id/new"));
    assert.equal(rows().includes("/customize/connectors/id/ordinary"), false);
    assert.equal(e.window.location.pathname, "/customize/connectors/new");
  } finally {
    await e.clean();
  }
});

test("settings43 connector scope/type routes round-trip published segments without claiming arbitrary slugs", () => {
  for (const path of [
    "/customize/connectors/all",
    "/customize/connectors/trending",
    "/customize/connectors/new",
    "/customize/connectors/all/verified",
    "/customize/connectors/in-chat-ui",
    "/customize/connectors/desktop-extensions",
    "/customize/connectors/topic-databases/new",
  ]) {
    const place = parseCustomizePath(path);
    assert.ok(place, path);
    assert.equal(customizePath(place), path);
  }
  for (const path of [
    "/customize/connectors/Top-connectors",
    "/customize/connectors/trending/new",
    "/customize/connectors/all/arbitrary",
    "/customize/connectors/not-a-published-category",
  ])
    assert.equal(parseCustomizePath(path), undefined, path);
});

test("settings43 source banner spacing derives height from declared content and shares the grid row", async () => {
  const e = await connectorDom();
  const entries = [featured("one"), featured("two")];
  const paint = (members: CatalogueConnector[]) =>
    e.render(
      createElement(ConnectorFeatured, {
        entries,
        onOpen: noop,
        variant: "customize",
        remoteIcons: false,
        featuredMembers: () => members,
      }),
    );
  try {
    await paint(entries);
    const slide = e.active();
    const style = (node: Element) => getComputedStyle(node);
    const banner = style(slide);
    const copy = slide.querySelector<HTMLElement>(
      ".customize-connector-featured-copy",
    )!;
    const typography = [...copy.children].map((node) =>
      parseFloat(style(node).lineHeight),
    );
    assert.deepEqual(typography, [17, 28, 20]);
    assert.equal(style(copy).display, "flex");
    assert.equal(style(copy).gap, "4px");
    assert.equal(style(copy.querySelector("h2")!).margin, "0px");
    assert.equal(banner.minHeight, "264px");
    assert.equal(banner.padding, "24px");
    assert.equal(banner.gap, "24px");
    assert.equal(banner.borderRadius, "12px");
    assert.equal(
      banner.height,
      "auto",
      "content, not a fixed279px box, determines banner height",
    );
    const curator = style(copy.querySelector("small")!);
    assert.equal(curator.textTransform, "uppercase");
    assert.equal(curator.letterSpacing, "0.3px");
    const cluster = slide.querySelector<HTMLElement>(
      ".customize-connector-featured-cluster",
    )!;
    assert.equal(style(cluster).gap, "20px");
    assert.equal(style(cluster).padding, "0px 40px");
    assert.equal(style(cluster).minHeight, "auto");
    const intrinsic = () =>
      typography.reduce((sum, value) => sum + value, 0) +
      2 * parseFloat(style(copy).gap) +
      Math.max(
        ...[...cluster.children].map((node) => parseFloat(style(node).height)),
      ) +
      parseFloat(
        style(slide.querySelector(".directory-outline-button")!).height,
      ) +
      2 * parseFloat(banner.gap) +
      parseFloat(banner.paddingTop) +
      parseFloat(banner.paddingBottom);
    assert.equal(
      intrinsic(),
      279,
      "the genuine two-member layout needs no forced279px height",
    );
    assert.equal(
      style(e.document.querySelector(".connector-featured-slides")!).display,
      "grid",
    );
    for (const node of e.document.querySelectorAll(".connector-featured-slide"))
      assert.equal(style(node).gridArea, "1 / 1");
    assert.equal(style(e.carousel()).gap, "16px");
    for (const selector of [
      ".connector-featured-previous",
      ".connector-featured-next",
    ]) {
      const button = style(e.document.querySelector(selector)!);
      assert.equal(button.width, "40px");
      assert.equal(button.height, "40px");
      assert.equal(button.borderRadius, "50%");
      assert.equal(button.getPropertyValue("backdrop-filter"), "blur(12px)");
      assert.equal(button.backgroundColor, "rgba(0, 0, 0, 0.55)");
    }
    await paint([entries[0]]);
    assert.equal(
      intrinsic(),
      292,
      "an independently declared83px test tile honestly yields a taller banner",
    );
    e.document.documentElement.dataset.theme = "light";
    assert.equal(
      style(e.document.querySelector(".connector-featured-previous")!)
        .backgroundColor,
      "rgba(255, 255, 255, 0.6)",
    );
  } finally {
    await e.clean();
  }
});

test("settings43 actual discovery keeps a truthful Add connector entry on a readonly host", async () => {
  const e = await connectorDom();
  try {
    await e.render(
      createElement(
        HostContext.Provider,
        { value: webHost },
        createElement(CustomizePage, {
          settings: defaultSettings,
          route: { section: "connectors", view: "discover" },
          onRouteChange: noop,
          onUseSkill: noop,
          onOpenSettings: noop,
          onConfirmRemove: noop,
          onError: noop,
        }),
      ),
    );
    await e.settle(
      () => !!e.document.querySelector(".customize-connector-directory"),
    );
    const add = e.document.querySelector<HTMLButtonElement>(
      '[aria-label="Add connector"]',
    )!;
    assert.ok(add);
    assert.equal(add.disabled, true);
    assert.equal(
      add.title,
      "Custom connectors aren’t available for this account.",
    );
    await e.event(add, "click");
    assert.equal(e.document.querySelector('[role="menu"]'), null);
  } finally {
    await e.clean();
  }
});

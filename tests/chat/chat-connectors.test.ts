import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { act, createElement, useState } from "react";
import { routineDom } from "../support/routine-dom";
import { defaultSettings } from "../../electron/store/store";
import { webHost } from "../../shared/host";
import type { ApprovedDirectoryEntry } from "../../shared/directory-submissions";
import type { CatalogueConnector } from "../../shared/connectors-catalogue";
import type { CustomizePlace } from "../../src/web/customize-route";
import type { AppController } from "../../src/app/AppContext";
import { AppContext } from "../../src/app/AppContext";
import { HostContext } from "../../src/host/HostContext";
import { CustomizeRoute } from "../../src/app/CollectionPages";
import { connectorCategory } from "../../src/settings/directory/connector-categories";
import {
  customizePath,
  parseCustomizePath,
} from "../../src/web/customize-route";
import { CustomizePage } from "../../src/collections/customize/CustomizePage";
import ConnectorDetail from "../../src/settings/tabs/ConnectorDetail";
import { currentToasts } from "../../src/ui/toast-store";

const noop = () => {};
const host = {
  ...webHost,
  capabilities: { ...webHost.capabilities, customConnectors: true },
};
const synthetic: ApprovedDirectoryEntry = {
  id: "published-example",
  kind: "mcp",
  name: "Published example",
  description: "A supplied directory description",
  url: "https://published.example/mcp",
  added: "2025-11-12",
  author: "Published author",
};
const props = {
  editable: true,
  onBack: noop,
  onConnect: async () => {},
  onSet: noop,
  onError: noop,
};
const entry = (
  extra: Partial<CatalogueConnector> = {},
): CatalogueConnector => ({
  id: synthetic.id,
  name: synthetic.name,
  description: synthetic.description,
  url: synthetic.url,
  byline: "by Published author",
  topic: "",
  type: "verified",
  icon: "book",
  ...extra,
});

async function detailDom(bridge: Partial<Window["desktop"]> = {}) {
  const e = await routineDom(
    {
      customizeSkills: async () => [],
      mcpServers: async () => ({ servers: [], configPath: "" }),
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
  const globals = {
    location: e.window.location,
    history: e.window.history,
    addEventListener: e.window.addEventListener.bind(e.window),
    removeEventListener: e.window.removeEventListener.bind(e.window),
    sessionStorage: e.window.sessionStorage,
    localStorage: e.window.localStorage,
    innerWidth: 1440,
    innerHeight: 900,
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
  style.textContent =
    readFileSync("src/styles/00-foundation.css", "utf8") +
    readFileSync("src/ui/menu.css", "utf8") +
    readFileSync("src/settings/tabs/connector-detail.css", "utf8") +
    readFileSync("src/collections/customize/customize-connectors.css", "utf8");
  e.document.head.append(style);
  return {
    ...e,
    async settle(predicate: () => boolean) {
      for (let count = 0; count < 50 && !predicate(); count++)
        await act(async () => {
          await new Promise((done) => setTimeout(done, 5));
        });
      assert.ok(predicate(), "expected connector detail did not appear");
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

function PageHarness({
  initial = { section: "connectors", view: "discover", detailId: "notion" },
  onPlace = noop,
  onError = noop,
}: {
  initial?: CustomizePlace;
  onPlace?: (place: CustomizePlace) => void;
  onError?: (error: unknown) => void;
}) {
  const [place, setPlace] = useState(initial);
  return createElement(
    HostContext.Provider,
    { value: host },
    createElement(CustomizePage, {
      settings: defaultSettings,
      route: place,
      onRouteChange: (next) => {
        onPlace(next);
        setPlace(next);
      },
      onUseSkill: noop,
      onOpenSettings: noop,
      onConfirmRemove: noop,
      onError,
    }),
  );
}

const metadata = (document: Document) =>
  [...document.querySelectorAll(".connector-published-metadata dt")].map(
    (node) => node.textContent,
  );
const toolNames = (document: Document) =>
  [...document.querySelectorAll(".connector-published-tool-names li")].map(
    (node) => node.textContent,
  );

test("shell54 real Customize route exposes the existing detail shell and metadata headings, then returns to Connectors", async () => {
  const copies: string[] = [],
    places: CustomizePlace[] = [],
    errors: unknown[] = [];
  const e = await detailDom({
    copyText: async (value) => {
      copies.push(value);
    },
    addCustomConnector: async () => {
      throw new Error("Connection rejected");
    },
  });
  try {
    await e.render(
      createElement(PageHarness, {
        onPlace: (place) => {
          places.push(place);
        },
        onError: (error) => {
          errors.push(error);
        },
      }),
    );
    await e.settle(
      () =>
        e.document.querySelector(".connector-published-detail h1")
          ?.textContent === "Notion",
    );
    const document = e.document;
    assert.deepEqual(metadata(document), [
      "Made by",
      "Categories",
      "Sign-in",
      "Connector URL",
      "Added to directory",
      "More info",
    ]);
    assert.deepEqual(
      [
        ...document.querySelectorAll(".connector-published-metadata dt > h3"),
      ].map((node) => node.textContent),
      metadata(document),
    );
    assert.equal(
      getComputedStyle(
        document.querySelector(".connector-published-identity h1")!,
      ).fontSize,
      "38px",
    );
    const logo = document.querySelector<HTMLElement>(
      ".connector-published-icon .connector-logo",
    )!;
    assert.equal(getComputedStyle(logo).width, "48px");
    assert.equal(getComputedStyle(logo).height, "48px");
    assert.equal(
      getComputedStyle(document.querySelector(".connector-published-field dt")!)
        .fontSize,
      "12px",
    );
    assert.equal(
      getComputedStyle(document.querySelector(".connector-published-columns")!)
        .gridTemplateColumns,
      "minmax(0, 1fr) 288px",
    );
    const copyLink = document.querySelector<HTMLButtonElement>(
      ".customize-connector-pane-actions .connector-published-copy",
    )!;
    assert.equal(copyLink.textContent, "Copy link");
    await e.event(copyLink, "click");
    await e.click('[aria-label="Copy server URL"]');
    assert.deepEqual(copies, [
      "http://localhost/customize/connectors/id/notion",
      "https://mcp.notion.com/mcp",
    ]);
    assert.equal(
      document.querySelectorAll(".connector-published-tools > h3").length,
      1,
    );
    assert.deepEqual(toolNames(document), [
      "create-comment",
      "create-database",
      "create-pages",
      "duplicate-page",
      "fetch",
      "get-comments",
      "get-self",
      "get-user",
      "get-users",
      "move-pages",
      "search",
      "update-database",
      "update-page",
    ]);
    assert.equal(
      getComputedStyle(
        document.querySelector(".connector-published-tool-names")!,
      ).columnCount,
      "3",
    );
    assert.equal(
      getComputedStyle(
        document.querySelector(".connector-published-tool-names")!,
      ).listStyleType,
      "none",
    );
    assert.ok(document.querySelector('a[href="https://notion.com/"]'));
    assert.ok(
      document.querySelector(
        'a[href="https://developers.notion.com/docs/mcp"]',
      ),
    );
    assert.ok(
      document.querySelector('a[href="mailto:developers@makenotion.com"]'),
    );
    const connect = document.querySelector<HTMLButtonElement>(
      ".connector-published-primary > .primary",
    )!;
    assert.equal(connect.textContent, "Connect to Claudex");
    assert.equal(connect.disabled, false);
    await e.event(connect, "click");
    assert.equal((errors[0] as Error).message, "Connection rejected");
    assert.equal(connect.textContent, "Connect to Claudex");
    assert.equal(connect.disabled, false);
    await e.click('.connector-published-nav a[href="/customize/connectors"]');
    await e.settle(
      () =>
        !document.querySelector(".connector-published-detail") &&
        !!document.querySelector(".customize-connector-directory"),
    );
    assert.deepEqual(places.at(-1), {
      section: "connectors",
      view: "discover",
    });
    assert.equal(document.querySelector(".connector-published-copy"), null);
  } finally {
    await e.clean();
  }
});

test("shell54 real detail sorts published tools, shows18 chips, and Show all reveals the remaining actual names", async () => {
  const tools = Array.from(
    { length: 22 },
    (_, i) => `tool_${String(22 - i).padStart(2, "0")}`,
  );
  const e = await detailDom({
    listApprovedDirectory: async () => [{ ...synthetic, tools }],
  });
  try {
    await e.render(
      createElement(PageHarness, {
        initial: {
          section: "connectors",
          view: "discover",
          detailId: synthetic.id,
        },
      }),
    );
    await e.settle(
      () => !!e.document.querySelector(".connector-published-tool-names"),
    );
    const expected = [...tools].sort((a, b) =>
      a.toLowerCase().localeCompare(b.toLowerCase()),
    );
    assert.deepEqual(toolNames(e.document), expected.slice(0, 18));
    assert.equal(
      e.document.querySelectorAll(".connector-published-tool-names li > span")
        .length,
      18,
    );
    assert.equal(
      getComputedStyle(
        e.document.querySelector(".connector-published-tool-names")!,
      ).columnCount,
      "3",
    );
    const expand = e.document.querySelector<HTMLButtonElement>(
      ".connector-published-show-tools",
    )!;
    assert.equal(expand.textContent, "Show all");
    await e.event(expand, "click");
    assert.deepEqual(toolNames(e.document), expected);
    assert.equal(
      e.document.querySelector(".connector-published-show-tools"),
      null,
    );
  } finally {
    await e.clean();
  }
});

for (const count of [1, 5, 6, 10, 11, 18])
  test(`shell54 ${count} supplied tools use the source column threshold without inventing names`, async () => {
    const e = await detailDom();
    const tools = Array.from({ length: count }, (_, i) => `tool_${i}`);
    try {
      await e.render(
        createElement(ConnectorDetail, {
          ...props,
          presentation: "customize",
          entry: entry({ tools }),
        }),
      );
      assert.equal(toolNames(e.document).length, count);
      assert.equal(
        getComputedStyle(
          e.document.querySelector(".connector-published-tool-names")!,
        ).columnCount,
        String(count >= 11 ? 3 : count >= 6 ? 2 : 1),
      );
      assert.equal(
        e.document.querySelector(".connector-published-show-tools"),
        null,
      );
    } finally {
      await e.clean();
    }
  });

test("shell54 URL copy Check appears only after successful clipboard write and resets after2seconds", async (t) => {
  let resolve!: () => void;
  const e = await detailDom({
    copyText: () =>
      new Promise<void>((done) => {
        resolve = done;
      }),
  });
  try {
    await e.render(
      createElement(ConnectorDetail, {
        ...props,
        presentation: "customize",
        entry: entry(),
      }),
    );
    const button = e.document.querySelector<HTMLButtonElement>(
      '[aria-label="Copy server URL"]',
    )!;
    t.mock.timers.enable({ apis: ["setTimeout"] });
    await e.event(button, "click");
    assert.equal(button.querySelector('[data-icon="Check"]'), null);
    await act(async () => resolve());
    assert.ok(button.querySelector('[data-icon="Check"]'));
    assert.equal(currentToasts().length, 0, "URL copying uses inline feedback");
    await act(async () => t.mock.timers.tick(1999));
    assert.ok(button.querySelector('[data-icon="Check"]'));
    await act(async () => t.mock.timers.tick(1));
    assert.equal(button.querySelector('[data-icon="Check"]'), null);
    assert.ok(button.querySelector('[data-icon="Copy"]'));
  } finally {
    t.mock.timers.reset();
    await e.clean();
  }
});

test("shell54 missing published metadata stays absent in the real detail DOM", async () => {
  const e = await detailDom();
  try {
    await e.render(
      createElement(ConnectorDetail, {
        ...props,
        presentation: "customize",
        entry: entry({
          byline: "",
          url: undefined,
          added: "not a date",
          isAuthless: undefined,
          categories: [],
          tools: undefined,
          documentationUrl: "javascript:alert(1)",
          supportUrl: "https://user:secret@example.com/",
          privacyPolicyUrl: undefined,
        }),
      }),
    );
    assert.deepEqual(metadata(e.document), []);
    assert.equal(e.document.querySelector(".connector-published-tools"), null);
    assert.equal(
      e.document.querySelector(".connector-published-related"),
      null,
    );
    assert.equal(
      e.document.querySelector('[aria-label="Copy server URL"]'),
      null,
    );
  } finally {
    await e.clean();
  }
});

for (const outcome of ["success", "failure"] as const)
  test(`shell54 stale clipboard ${outcome} cannot affect the next account's detail`, async () => {
    const e = await detailDom({
      copyText: () =>
        new Promise<void>((done, fail) => {
          resolve = done;
          reject = fail;
        }),
    });
    let resolve!: () => void, reject!: (error: Error) => void;
    const errors: unknown[] = [];
    const scope = {},
      controller = { current: undefined as AppController | undefined };
    const before = {
      accountId: "before",
      controllerScope: scope,
      currentController: controller,
    } as AppController;
    controller.current = before;
    const render = (app: AppController) =>
      e.render(
        createElement(
          AppContext.Provider,
          { value: app },
          createElement(ConnectorDetail, {
            ...props,
            presentation: "customize",
            entry: entry(),
            onError: (error) => {
              errors.push(error);
            },
          }),
        ),
      );
    try {
      await render(before);
      await e.click('[aria-label="Copy server URL"]');
      const after = { ...before, accountId: "after", controllerScope: {} };
      controller.current = after;
      await render(after);
      await act(async () => {
        if (outcome === "success") resolve();
        else reject(new Error("Old copy failed"));
      });
      assert.equal(
        e.document.querySelector(
          '[aria-label="Copy server URL"] [data-icon="Check"]',
        ),
        null,
      );
      assert.deepEqual(errors, []);
      assert.equal(currentToasts().length, 0);
    } finally {
      await e.clean();
    }
  });

function RoutedCategoryHarness() {
  const [controllerScope] = useState({});
  const app = {
    accountId: "connector-route",
    controllerScope,
    mode: "chat",
    snapshot: {
      settings: defaultSettings,
      conversations: [],
      projects: [],
      approvals: [],
    },
    report: noop,
    openSettingsTab: noop,
    setConfirm: noop,
  } as unknown as AppController;
  return createElement(
    HostContext.Provider,
    { value: host },
    createElement(
      AppContext.Provider,
      { value: app },
      createElement(CustomizeRoute),
    ),
  );
}

test("shell54 real category chip writes the observed taxonomy route, filters actual records, and survives remount", async () => {
  const records: ApprovedDirectoryEntry[] = [
    {
      ...synthetic,
      id: "legacy-notes",
      name: "Legacy notes record",
      curation: { categories: ["notes-memory"] },
    },
    {
      ...synthetic,
      id: "other-category",
      name: "Database record",
      curation: { categories: ["Databases"] },
    },
  ];
  const e = await detailDom({ listApprovedDirectory: async () => records });
  e.window.history.replaceState({}, "", "/customize/connectors/id/notion");
  const categoryPath = "/customize/connectors/topic-notes-memory";
  const categoryVisible = () =>
    e.document.querySelector(".customize-connector-category-header h1")
      ?.textContent === "Notes & memory";
  try {
    await e.render(createElement(RoutedCategoryHarness));
    await e.settle(
      () => !!e.document.querySelector(".connector-published-detail"),
    );
    const category = [
      ...e.document.querySelectorAll<HTMLButtonElement>(
        ".connector-published-categories button",
      ),
    ].find((button) => button.textContent === "Notes & memory")!;
    assert.ok(category);
    await e.event(category, "click");
    await e.settle(categoryVisible);
    assert.equal(e.window.location.pathname, categoryPath);
    assert.equal(e.document.querySelector(".connector-published-detail"), null);
    assert.equal(
      e.document.querySelector(".customize-connector-category-results h2")
        ?.textContent,
      "Connectors",
    );
    const actualIds = () =>
      [
        ...e.document.querySelectorAll<HTMLAnchorElement>(
          ".connector-directory-row-main",
        ),
      ].map((link) => link.getAttribute("href"));
    assert.ok(actualIds().includes("/customize/connectors/id/notion"));
    assert.ok(
      actualIds().includes("/customize/connectors/id/legacy-notes"),
      "source legacy category aliases filter the real directory records",
    );
    assert.equal(
      actualIds().includes("/customize/connectors/id/other-category"),
      false,
    );
    await e.render(createElement("div", {}, "Reloading the route"));
    await e.render(createElement(RoutedCategoryHarness));
    await e.settle(categoryVisible);
    assert.equal(e.window.location.pathname, categoryPath);
    assert.ok(actualIds().includes("/customize/connectors/id/legacy-notes"));
    assert.equal(
      actualIds().includes("/customize/connectors/id/other-category"),
      false,
    );
    await e.click(".customize-connector-category-header > a");
    await e.settle(
      () =>
        !e.document.querySelector(".customize-connector-category-header") &&
        !!e.document.querySelector(".customize-connector-directory"),
    );
    assert.equal(e.window.location.pathname, "/customize/connectors");
    const oldFilter = [
      ...e.document.querySelectorAll<HTMLButtonElement>(
        ".customize-connector-categories button",
      ),
    ].find((button) => button.textContent === "Notes & memory")!;
    assert.ok(oldFilter);
    await e.event(oldFilter, "click");
    await e.settle(categoryVisible);
    assert.equal(
      e.window.location.pathname,
      categoryPath,
      "the existing directory category filter uses the same durable route",
    );
  } finally {
    await e.clean();
  }
});

test("shell54 taxonomy routes use published IDs and explicit aliases, with no label slug guessing", () => {
  for (const value of [
    "Notes & memory",
    "notes-memory",
    "topic-notes-memory",
  ]) {
    assert.deepEqual(connectorCategory(value), {
      id: "topic-notes-memory",
      label: "Notes & memory",
    });
  }
  assert.equal(
    connectorCategory("Files & documents")?.id,
    "topic-files-documents",
  );
  assert.equal(connectorCategory("Engineering")?.id, "department-engineering");
  assert.equal(connectorCategory("invented label"), undefined);
  const place: CustomizePlace = {
    section: "connectors",
    view: "discover",
    category: "topic-notes-memory",
  };
  assert.equal(
    customizePath(place),
    "/customize/connectors/topic-notes-memory",
  );
  assert.deepEqual(parseCustomizePath(customizePath(place)), place);
  assert.deepEqual(
    parseCustomizePath("/customize/connectors/notes-memory"),
    place,
  );
  for (const path of [
    "/customize/connectors/topic-not-real",
    "/customize/connectors/topic-notes-memory/extra",
    "/customize/skills/topic-notes-memory",
    "/customize/connectors/%2Ftopic-notes-memory",
    "/customize/connectors/Notes%20%26%20memory",
  ])
    assert.equal(parseCustomizePath(path), undefined);
});

test("shell54 category landing uses its dedicated header and real nested taxonomy/type filters", async () => {
  const copies: string[] = [];
  const records: ApprovedDirectoryEntry[] = [
    {
      ...synthetic,
      id: "trend-notes",
      name: "Trending notes record",
      curation: { categories: ["notes-memory"], isTrending: true },
    },
    {
      ...synthetic,
      id: "other-notes",
      name: "Other notes record",
      curation: { categories: ["Notes & memory"], isTrending: false },
    },
    {
      ...synthetic,
      id: "database",
      name: "Database record",
      curation: { categories: ["Databases"] },
    },
  ];
  const e = await detailDom({
    listApprovedDirectory: async () => records,
    copyText: async (value) => {
      copies.push(value);
    },
  });
  e.window.history.replaceState(
    {},
    "",
    "/customize/connectors/topic-notes-memory",
  );
  const names = () =>
    [
      ...e.document.querySelectorAll(".connector-directory-row-name strong"),
    ].map((node) => node.textContent);
  const menu = () =>
    e.document.querySelector<HTMLElement>(
      '[role="menu"][aria-label="Filter"]',
    )!;
  const leaf = (root: HTMLElement, label: string) =>
    [...root.querySelectorAll<HTMLButtonElement>(":scope > button")].find(
      (button) =>
        button.querySelector(".menu-item-text")?.textContent === label ||
        button.textContent === label,
    )!;
  try {
    await e.render(createElement(RoutedCategoryHarness));
    await e.settle(() => names().includes("Trending notes record"));
    assert.equal(e.document.querySelector(".customize-tabs"), null);
    assert.equal(e.document.querySelector(".customize-views"), null);
    assert.equal(e.document.querySelector(".customize-search"), null);
    assert.equal(
      e.document.querySelector(".customize-connector-shelf-head"),
      null,
    );
    const title = e.document.querySelector(
      ".customize-connector-category-header h1",
    )!;
    assert.equal(title.textContent, "Notes & memory");
    const titleStyle = getComputedStyle(title);
    assert.equal(titleStyle.fontSize, "24px");
    assert.equal(titleStyle.lineHeight, "32px");
    assert.equal(titleStyle.fontWeight, "500");
    assert.ok(titleStyle.fontFamily.includes("Claudex Serif"));
    const hiddenHeading = e.document.querySelector(
      ".customize-connector-category-results h2",
    )!;
    assert.equal(hiddenHeading.textContent, "Connectors");
    assert.equal(getComputedStyle(hiddenHeading).width, "1px");
    assert.equal(getComputedStyle(hiddenHeading).height, "1px");
    await e.click(
      ".customize-connector-pane-actions .connector-published-copy",
    );
    assert.deepEqual(copies, [
      "http://localhost/customize/connectors/topic-notes-memory",
    ]);
    const add = e.document.querySelector<HTMLButtonElement>(
      '[aria-label="Add connector"]',
    )!;
    assert.equal(add.textContent?.trim(), "Add");
    await e.event(add, "click");
    const addMenu = e.document.querySelector(
      '[role="menu"][aria-label="Add"]',
    )!;
    assert.ok(addMenu.textContent?.includes("Submit an MCP connector"));
    assert.ok(addMenu.textContent?.includes("Add in Developer settings"));
    await e.event(addMenu, "keydown", { key: "Escape" });
    const filter = e.document.querySelector<HTMLButtonElement>(
      '[aria-label="Filter: Notes & memory"]',
    )!;
    await e.event(filter, "click");
    assert.ok(menu());
    const rootLabels = [
      ...menu().querySelectorAll<HTMLButtonElement>(":scope > button"),
    ].map((button) => button.textContent);
    assert.deepEqual(rootLabels, [
      "All categories",
      "TopicNotes & memory",
      "Department",
      "Industry",
      "Everyday life",
      "All",
      "Trending",
      "New",
      "Verified",
      "Community",
      "In-chat UI",
      "Desktop extensions",
    ]);
    const structure = [...menu().children].map((node) =>
      node.tagName === "HR"
        ? "separator"
        : node.classList.contains("menu-heading")
          ? `heading:${node.textContent}`
          : node.textContent,
    );
    assert.deepEqual(structure.slice(0, 9), [
      "All categories",
      "separator",
      "TopicNotes & memory",
      "Department",
      "Industry",
      "separator",
      "Everyday life",
      "separator",
      "heading:Type",
    ]);
    const rootStyle = getComputedStyle(menu());
    assert.equal(rootStyle.paddingTop, "4px");
    assert.equal(rootStyle.paddingBottom, "4px");
    assert.equal(rootStyle.paddingLeft, "4px");
    assert.equal(rootStyle.paddingRight, "4px");
    assert.equal(rootStyle.borderBottomWidth, "1px");
    assert.equal(rootStyle.borderBottomColor, "rgba(0, 0, 0, 0)");
    assert.equal(
      rootStyle.height,
      "auto",
      "menu height must come from the source rows and group spacing",
    );
    for (const row of menu().querySelectorAll(":scope > button"))
      assert.equal(getComputedStyle(row).height, "32px");
    const separators = [...menu().querySelectorAll(":scope > hr")];
    assert.equal(separators.length, 3);
    for (const separator of separators) {
      const style = getComputedStyle(separator);
      assert.equal(style.height, "1px");
      assert.equal(style.marginTop, "4px");
      assert.equal(style.marginBottom, "4px");
    }
    const headingStyle = getComputedStyle(
      menu().querySelector(".menu-heading")!,
    );
    assert.equal(headingStyle.height, "auto");
    assert.equal(headingStyle.lineHeight, "17px");
    assert.equal(headingStyle.paddingTop, "4px");
    assert.equal(headingStyle.paddingBottom, "4px");
    assert.equal(
      parseFloat(headingStyle.lineHeight) +
        parseFloat(headingStyle.paddingTop) +
        parseFloat(headingStyle.paddingBottom),
      25,
    );
    assert.equal(leaf(menu(), "All").getAttribute("aria-checked"), "true");
    assert.equal(
      leaf(menu(), "Desktop extensions").disabled,
      true,
      "absent runtime metadata cannot be presented as an executable filter",
    );
    assert.equal(
      leaf(menu(), "Trending").disabled,
      false,
      "explicit supplied trending flags enable the real predicate",
    );
    await e.event(leaf(menu(), "Trending"), "click");
    await e.settle(
      () =>
        e.window.location.pathname.endsWith("/trending") &&
        names().length === 1,
    );
    assert.deepEqual(names(), ["Trending notes record"]);
    assert.equal(
      e.window.location.pathname,
      "/customize/connectors/topic-notes-memory/trending",
    );
    await e.render(createElement("div", {}, "Reloading"));
    await e.render(createElement(RoutedCategoryHarness));
    await e.settle(
      () => names().length === 1 && names()[0] === "Trending notes record",
    );
    assert.equal(
      e.window.location.pathname,
      "/customize/connectors/topic-notes-memory/trending",
    );
    await e.click('[aria-label="Filter: Notes & memory, Trending"]');
    assert.equal(leaf(menu(), "Trending").getAttribute("aria-checked"), "true");
    await e.event(leaf(menu(), "All"), "click");
    await e.settle(
      () =>
        e.window.location.pathname ===
          "/customize/connectors/topic-notes-memory" &&
        names().includes("Other notes record"),
    );
    await e.click('[aria-label="Filter: Notes & memory"]');
    const topic = [
      ...menu().querySelectorAll<HTMLButtonElement>(":scope > button"),
    ].find((button) => button.textContent?.startsWith("Topic"))!;
    await e.event(topic, "click");
    const submenu = e.document.querySelector<HTMLElement>(
      '[role="menu"][aria-label="Topic"]',
    )!;
    assert.ok(submenu);
    const database = [
      ...submenu.querySelectorAll<HTMLButtonElement>("button"),
    ].find((button) => button.textContent === "Databases")!;
    assert.ok(database);
    await e.event(database, "click");
    await e.settle(
      () =>
        e.window.location.pathname ===
          "/customize/connectors/topic-databases" &&
        names().includes("Database record"),
    );
    assert.equal(names().includes("Trending notes record"), false);
    assert.equal(
      e.document.querySelector(".customize-connector-category-header h1")
        ?.textContent,
      "Databases",
    );
  } finally {
    await e.clean();
  }
});

test("shell54 actual CustomizePage retains the Add connector entry with an accurate reason on a host without writable connectors", async () => {
  const e = await detailDom();
  try {
    await e.render(
      createElement(
        HostContext.Provider,
        { value: webHost },
        createElement(CustomizePage, {
          settings: defaultSettings,
          route: {
            section: "connectors",
            view: "discover",
            category: "topic-notes-memory",
          },
          onRouteChange: noop,
          onUseSkill: noop,
          onOpenSettings: noop,
          onConfirmRemove: noop,
          onError: noop,
        }),
      ),
    );
    await e.settle(
      () => !!e.document.querySelector(".customize-connector-category-results"),
    );
    const add = e.document.querySelector<HTMLButtonElement>(
      '[aria-label="Add connector"]',
    )!;
    assert.ok(
      add,
      "read-only host capabilities must not remove the source header entry",
    );
    assert.equal(add.textContent?.trim(), "Add");
    assert.equal(add.disabled, true);
    assert.equal(
      add.title,
      "Custom connectors aren’t available for this account.",
    );
    await e.event(add, "click");
    assert.equal(
      e.document.querySelector('[role="menu"][aria-label="Add"]'),
      null,
    );
    const back = e.document.querySelector<HTMLAnchorElement>(
      ".customize-connector-category-header > a",
    )!;
    assert.equal(back.getAttribute("href"), "/customize/connectors");
    const style = getComputedStyle(back);
    assert.equal(style.height, "28px");
    assert.equal(style.paddingLeft, "10px");
    assert.equal(style.paddingRight, "10px");
    assert.equal(style.marginTop, "4px");
    assert.equal(style.marginLeft, "-10px");
    assert.equal(style.lineHeight, "20px");
    const wrapper = e.document.querySelector(
      ".customize-connector-category-title",
    )!;
    assert.equal(getComputedStyle(wrapper).minHeight, "48px");
    assert.equal(getComputedStyle(wrapper).alignItems, "center");
    assert.equal(
      getComputedStyle(wrapper.querySelector("h1")!).marginTop,
      "0px",
    );
  } finally {
    await e.clean();
  }
});

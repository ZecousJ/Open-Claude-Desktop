import test from "node:test";
import assert from "node:assert/strict";
import { act, createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import UnifiedSearch, {
  catalogQuery,
  matchesQuery,
  normalizeSearchText,
  searchSections,
  searchDelay,
  type SearchItem,
} from "../../src/collections/customize/UnifiedSearch";
import { AppContext, type AppController } from "../../src/app/AppContext";
import type { DesktopAPI } from "../../shared/types";
import type { McpServers } from "../../shared/settings-desktop-api";
import { CustomizePage } from "../../src/collections/customize/CustomizePage";
import { sections } from "../../src/collections/customize/customize-list";
import { defaultSettings } from "../../electron/store/store";
import type {
  CustomizeSkill,
  PluginEntry,
  PluginCatalog,
} from "../../shared/collections-api";
import type { ApprovedDirectoryEntry } from "../../shared/directory-submissions";
import type { CustomizePlace } from "../../src/web/customize-route";

const item = (name: string, yours = false): SearchItem => ({
  key: name,
  name,
  description: "description only",
  kind: "plugin",
  yours,
  open() {},
});

test("catalog queries count Unicode letters/digits and cap code points", () => {
  assert.equal(catalogQuery(" !a--- "), "");
  assert.equal(catalogQuery(" 中 文 "), "中 文");
  assert.equal(catalogQuery(" a1 "), "a1");
  assert.equal(Array.from(catalogQuery("𐐀".repeat(205))).length, 200);
});

test("name matching follows reference normalization and excludes local descriptions", () => {
  assert.equal(
    normalizeSearchText("  CAFÉ_weekly—‘notes’  "),
    "cafe weekly—'notes'",
  );
  assert.ok(matchesQuery(item("Café_weekly-notes", true), "cafe weekly"));
  assert.ok(matchesQuery(item("‘Notes’", true), "'notes'"));
  assert.equal(matchesQuery(item("Notes", true), "description"), false);
  assert.ok(matchesQuery(item("Notes"), "description"));
});

test("finite sections retain loaded order and never invent addable one-character hits", () => {
  const all = [item("cafe a", true), item("cafe z"), item("cafe b")];
  const found = searchSections(all, "cafe", "plugins");
  assert.deepEqual(
    found.yours.map((i) => i.name),
    ["cafe a"],
  );
  assert.deepEqual(
    found.inPage.map((i) => i.name),
    ["cafe z", "cafe b"],
  );
  const short = searchSections(all, "c", "plugins");
  assert.equal(short.keepTyping, true);
  assert.equal(short.inPage.length, 0);
});

test("failed or loading searches suppress a false empty result", () => {
  for (const state of [
    { loading: true, failed: false },
    { loading: false, failed: true },
  ]) {
    const html = renderToStaticMarkup(
      createElement(UnifiedSearch, {
        query: "missing",
        page: "skills",
        items: [],
        sources: [{ ...state, retry() {} }],
      }),
    );
    assert.doesNotMatch(html, /No skills match your search/);
    assert.match(
      html,
      state.failed ? /Couldn’t finish searching/ : /Searching…/,
    );
  }
});

async function withDOM(
  run: (context: {
    document: Document;
    render(element: ReactElement): Promise<void>;
    click(selector: string): Promise<void>;
    readBridge(): DesktopAPI;
    replaceBridge(bridge: DesktopAPI): void;
  }) => Promise<void>,
  desktop = {},
) {
  const { window, document } = parseHTML(
    "<html><body><main></main></body></html>",
  );
  Object.defineProperty(window, "location", {
    value: new URL("https://claudex.test/customize/skills"),
    configurable: true,
  });
  window.desktop = {
    onEvent: () => () => {},
    linearStatus: async () => ({ connected: false }),
    customizeSkills: async () => [],
    mcpServers: async () => ({ servers: [] }),
    listPlugins: async () => ({
      plugins: [],
      marketplaces: [],
      loadErrors: [],
    }),
    listApprovedDirectory: async () => [],
    ...desktop,
  } as never;
  window.HTMLElement.prototype.getBoundingClientRect = () => ({
    x: 0,
    y: 0,
    top: 0,
    right: 32,
    bottom: 32,
    left: 0,
    width: 32,
    height: 32,
    toJSON() {},
  });
  const globals = {
    window,
    document,
    MutationObserver: window.MutationObserver,
    HTMLElement: window.HTMLElement,
    Node: window.Node,
    innerWidth: 1440,
    innerHeight: 900,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const saved = new Map(
    Object.keys(globals).map((k) => [
      k,
      Object.getOwnPropertyDescriptor(globalThis, k),
    ]),
  );
  Object.entries(globals).forEach(([key, value]) =>
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value,
    }),
  );
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.querySelector("main")!);
  try {
    await run({
      document: document as unknown as Document,
      readBridge: () => window.desktop,
      replaceBridge: (bridge) => {
        window.desktop = bridge;
      },
      render: async (element) => {
        await act(async () => root.render(element));
      },
      click: async (selector) => {
        const button = document.querySelector<HTMLButtonElement>(selector);
        assert.ok(button, selector);
        await act(async () => button.click());
      },
    });
  } finally {
    await act(() => root.unmount());
    saved.forEach((descriptor, key) =>
      descriptor
        ? Object.defineProperty(globalThis, key, descriptor)
        : Reflect.deleteProperty(globalThis, key),
    );
  }
}

const page = (
  route: CustomizePlace = { section: "skills", view: "discover" },
) =>
  createElement(CustomizePage, {
    route,
    settings: defaultSettings,
    onUseSkill() {},
    onOpenSettings() {},
    onConfirmRemove() {},
    onError() {},
  });

test("Retry reruns failed sources and preserves existing results", async () => {
  let retries = 0;
  await withDOM(async ({ document, render, click }) => {
    await render(
      createElement(UnifiedSearch, {
        query: "notes",
        page: "plugins",
        items: [item("Notes", true)],
        sources: [
          {
            loading: false,
            failed: true,
            retry() {
              retries++;
            },
          },
        ],
      }),
    );
    await click(".customize-load-error button");
    assert.equal(retries, 1);
    assert.match(
      document.querySelector(".unified-section")!.textContent!,
      /Notes/,
    );
  });
});

test("changed queries settle after 250ms and Show more reveals existing rows", async () => {
  await withDOM(async ({ document, render, click }) => {
    const items = Array.from({ length: 16 }, (_, n) => item(`Data ${n}`));
    const results = (query: string) =>
      createElement(UnifiedSearch, { query, page: "plugins", items });
    await render(results("data"));
    assert.equal(document.querySelectorAll(".customize-row").length, 5);
    await click(".unified-more");
    assert.equal(document.querySelectorAll(".customize-row").length, 15);
    await click(".unified-more");
    assert.equal(document.querySelectorAll(".customize-row").length, 16);
    await click(".unified-more");
    assert.equal(document.querySelectorAll(".customize-row").length, 5);
    await render(results("missing"));
    assert.equal(
      document.querySelector(".unified-search")?.getAttribute("aria-busy"),
      "true",
    );
    assert.match(
      document.querySelector(".unified-heading")!.textContent!,
      /data/,
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 270));
    });
    assert.match(
      document.querySelector(".unified-heading")!.textContent!,
      /missing/,
    );
    assert.match(
      document.querySelector(".customize-nothing")!.textContent!,
      /No plugins/,
    );
  });
});

test("without the Data plugin in the catalog, Discover invents no Data feature", async () => {
  let saves = 0;
  await withDOM(
    async ({ document, render }) => {
      await render(page());
      assert.equal(document.querySelector(".customize-feature"), null);
      assert.equal(document.querySelector(".directory-detail"), null);
      assert.doesNotMatch(
        document.querySelector("main")!.textContent!,
        /Most installed|Query, chart and explain your data/,
      );
      assert.equal(saves, 0);
    },
    {
      saveSkill: async () => {
        saves++;
      },
    },
  );
});

test("Data shows the catalog entry's own content and installs only that entry", async () => {
  const installs: string[] = [];
  const data = {
    id: "data@knowledge-work-plugins",
    name: "data",
    title: "Data",
    marketplace: "knowledge-work-plugins",
    installed: false,
    installable: true,
    enabled: true,
    description: "Real data description",
    developer: "Real publisher",
  } as PluginEntry;
  await withDOM(
    async ({ document, render, click }) => {
      await render(page());
      assert.equal(
        document.querySelector(".customize-feature h3")?.textContent,
        "Data",
      );
      assert.equal(
        document.querySelector(".customize-feature small")?.textContent,
        "from Real publisher",
      );
      assert.equal(
        document.querySelector(".customize-feature p")?.textContent,
        "Real data description",
      );
      await click(".plugin-discovery-hero-add");
      assert.deepEqual(installs, [data.id]);
      assert.equal(
        document.querySelector(".plugin-discovery-hero-add")?.textContent,
        "Added",
      );
    },
    {
      listPlugins: async () => ({
        plugins: [{ ...data }],
        marketplaces: [
          {
            name: "knowledge-work-plugins",
            path: "/market",
            source: "git",
          } as PluginCatalog["marketplaces"][number],
        ],
        loadErrors: [],
      }),
      installPlugin: async (id: string) => {
        installs.push(id);
        data.installed = true;
        return { appsNeedingAuth: [] };
      },
      saveSkill: async () => {
        throw new Error("Data must use the real plugin install");
      },
    },
  );
});

test("Yours groups runtime sources in the live order with counts", async () => {
  const skill = (
    name: string,
    scope: CustomizeSkill["scope"],
  ): CustomizeSkill => ({
    name,
    scope,
    path: `/${name}/SKILL.md`,
    description: "",
    enabled: true,
    own: scope === "user",
  });
  const skills = [
    skill("Own", "user"),
    skill("Team", "admin"),
    skill("Repo", "repo"),
    skill("Runtime", "system"),
  ];
  assert.equal(sections[0].title, "In this project");
  await withDOM(
    async ({ document, render }) => {
      await render(page({ section: "skills", view: "yours" }));
      assert.deepEqual(
        Array.from(document.querySelectorAll(".customize-section h3"), (e) =>
          e.firstChild?.textContent?.trim(),
        ),
        [
          "In this project",
          "Created by you",
          "From your organization",
          "From Claudex & Partners",
        ],
      );
      assert.deepEqual(
        Array.from(
          document.querySelectorAll(".customize-section-count"),
          (e) => e.textContent,
        ),
        ["1", "1", "1", "1"],
      );
    },
    { customizeSkills: async () => skills },
  );
});

test("connector empty state routes its browse CTA to Discover", async () => {
  await withDOM(async ({ document, render, click }) => {
    const routes: CustomizePlace[] = [];
    await render(
      createElement(CustomizePage, {
        route: { section: "connectors", view: "yours" },
        settings: defaultSettings,
        onUseSkill() {},
        onOpenSettings() {},
        onConfirmRemove() {},
        onError() {},
        onRouteChange(route) {
          routes.push(route);
        },
      }),
    );
    assert.equal(
      document.querySelector(".customize-callout h3")?.textContent,
      "Add your first connectors",
    );
    assert.match(
      document.querySelector(".customize-callout p")!.textContent!,
      /Connectors let Claudex work/,
    );
    assert.equal(
      document.querySelector(".customize-callout button")?.textContent,
      "Discover connectors",
    );
    await click(".customize-callout button");
    assert.deepEqual(routes, [{ section: "connectors", view: "discover" }]);
  });
});

test("Customize gates directory reads, retries its real failure, and opens a published result", async () => {
  let reads = 0;
  const opened: string[] = [];
  await withDOM(
    async ({ document, render, click }) => {
      await render(page());
      const changeQuery = async (value: string) => {
        if (!document.querySelector(".customize-search input"))
          await click('button[aria-label="Search"]');
        const input = document.querySelector<HTMLInputElement>(
          ".customize-search input",
        )!;
        // linkedom does not implement React's native input tracker. Invoke the
        // mounted field's real onChange, leaving its page, hooks and APIs intact.
        const propsKey = Object.keys(input).find((key) =>
          key.startsWith("__reactProps$"),
        )!;
        const props = (
          input as unknown as Record<string, { onChange(event: unknown): void }>
        )[propsKey];
        await act(async () => props.onChange({ target: { value } }));
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 270));
        });
      };
      assert.equal(reads, 1, "Discover reads the directory's curation");
      await changeQuery("u");
      assert.equal(reads, 1, "one character only searches loaded names");
      await changeQuery("unlisted");
      assert.equal(reads, 2);
      assert.match(
        document.querySelector('[role="alert"]')!.textContent!,
        /Couldn’t finish searching/,
      );
      assert.equal(document.querySelector(".customize-nothing"), null);
      await click(".customize-load-error button");
      assert.equal(reads, 3);
      assert.equal(document.querySelector(".customize-load-error"), null);
      assert.match(
        document.querySelector(".unified-section")!.textContent!,
        /Unlisted fixture/,
      );
      await click(".unified-section .customize-row-main");
      assert.deepEqual(opened, ["https://fixture.invalid/plugin"]);
    },
    {
      listApprovedDirectory: async (...args: unknown[]) => {
        assert.deepEqual(
          args,
          [],
          "the bridge has a finite list protocol, not cursor search",
        );
        if (++reads <= 2) throw new Error("directory offline");
        return [
          {
            kind: "plugin",
            id: "fixture",
            name: "Unlisted fixture",
            description: "Published fixture text",
            url: "https://fixture.invalid/plugin",
            added: "2026-10-19",
          },
        ];
      },
      openExternal: async (url: string) => {
        opened.push(url);
      },
    },
  );
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function controller(
  accountId: string,
  controllerScope: object,
  currentController: { current: AppController | undefined },
) {
  const app = {
    accountId,
    controllerScope,
    currentController,
  } as AppController;
  currentController.current = app;
  return app;
}

function mountedProps<T>(element: Element): T {
  const key = Object.keys(element).find((key) =>
    key.startsWith("__reactProps$"),
  )!;
  assert.ok(key, "a mounted React control");
  return (element as unknown as Record<string, T>)[key];
}

for (const transition of ["account", "controller", "bridge"] as const)
  test(`delayed private lists retire on ${transition} replacement`, async () => {
    const aSkills = deferred<CustomizeSkill[]>(),
      bSkills = deferred<CustomizeSkill[]>();
    const aServers = deferred<McpServers>(),
      bServers = deferred<McpServers>();
    const errors: unknown[] = [];
    const ref: { current: AppController | undefined } = { current: undefined };
    const scope = {};
    let app = controller("A", scope, ref);
    let phase = "A",
      skillReads = 0,
      serverReads = 0;
    const skill = (name: string): CustomizeSkill => ({
      name,
      description: "",
      path: `/${name}`,
      scope: "user",
      own: true,
      enabled: true,
    });
    await withDOM(
      async ({ document, render, readBridge, replaceBridge }) => {
        const display = () =>
          createElement(
            AppContext.Provider,
            { value: app },
            createElement(CustomizePage, {
              route: { section: "skills", view: "yours" },
              settings: defaultSettings,
              onUseSkill() {},
              onOpenSettings() {},
              onConfirmRemove() {},
              onError(error) {
                errors.push(error);
              },
            }),
          );
        const bridgeA = readBridge();
        await render(display());
        assert.equal(skillReads, 1);
        assert.equal(serverReads, 1);
        phase = "B";
        app = controller(
          transition === "account" ? "B" : "A",
          transition === "controller" ? {} : scope,
          ref,
        );
        if (transition === "bridge")
          replaceBridge({
            ...bridgeA,
            customizeSkills: async () => {
              skillReads++;
              return bSkills.promise;
            },
            mcpServers: async () => {
              serverReads++;
              return bServers.promise;
            },
          });
        await render(display());
        assert.equal(skillReads, 2);
        assert.equal(serverReads, 2);
        await act(async () => {
          bSkills.resolve([skill("B private")]);
          bServers.resolve({ servers: [], configPath: "/fixture/mcp.json" });
        });
        assert.match(document.querySelector("main")!.textContent!, /B private/);
        await act(async () => {
          aSkills.resolve([skill("A secret")]);
          aServers.reject(new Error("old owner failure"));
        });
        assert.match(document.querySelector("main")!.textContent!, /B private/);
        assert.doesNotMatch(
          document.querySelector("main")!.textContent!,
          /A secret/,
        );
        assert.deepEqual(errors, []);
      },
      {
        customizeSkills: async () => {
          skillReads++;
          return phase === "A" ? aSkills.promise : bSkills.promise;
        },
        mcpServers: async () => {
          serverReads++;
          return phase === "A" ? aServers.promise : bServers.promise;
        },
      },
    );
  });

test("cleared currentController rejects pending private results and their errors without a rerender", async () => {
  const skills = deferred<CustomizeSkill[]>(),
    servers = deferred<{ servers: [] }>();
  const errors: unknown[] = [];
  const ref: { current: AppController | undefined } = { current: undefined };
  const app = controller("A", {}, ref);
  await withDOM(
    async ({ document, render }) => {
      await render(
        createElement(
          AppContext.Provider,
          { value: app },
          createElement(CustomizePage, {
            route: { section: "skills", view: "yours" },
            settings: defaultSettings,
            onUseSkill() {},
            onOpenSettings() {},
            onConfirmRemove() {},
            onError(error) {
              errors.push(error);
            },
          }),
        ),
      );
      const before = document.querySelector("main")!.innerHTML;
      ref.current = undefined;
      await act(async () => {
        skills.resolve([
          {
            name: "Retired secret",
            description: "",
            path: "/retired",
            scope: "user",
            enabled: true,
            own: true,
          },
        ]);
        servers.reject(new Error("retired failure"));
      });
      assert.equal(document.querySelector("main")!.innerHTML, before);
      assert.deepEqual(errors, []);
    },
    {
      customizeSkills: () => skills.promise,
      mcpServers: () => servers.promise,
    },
  );
});

test("directory responses and captured Retry cannot cross an owner boundary or a cleared controller", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const aFirst = deferred<ApprovedDirectoryEntry[]>(),
    aRetry = deferred<ApprovedDirectoryEntry[]>(),
    bRequest = deferred<ApprovedDirectoryEntry[]>();
  const aPlugins = deferred<PluginCatalog>();
  const aPluginRetry = deferred<PluginCatalog>();
  let aReads = 0,
    bReads = 0,
    pluginReads = 0;
  const ref: { current: AppController | undefined } = { current: undefined };
  let app = controller("A", {}, ref);
  await withDOM(
    async ({ document, render, click, readBridge, replaceBridge }) => {
      const display = () =>
        createElement(AppContext.Provider, { value: app }, page());
      const changeQuery = async (value: string) => {
        if (!document.querySelector(".customize-search input"))
          await click('button[aria-label="Search"]');
        const input = document.querySelector(".customize-search input")!;
        await act(async () =>
          mountedProps<{ onChange(event: unknown): void }>(input).onChange({
            target: { value },
          }),
        );
        await act(async () => t.mock.timers.tick(searchDelay));
      };
      const bridgeA = readBridge();
      await render(display());
      assert.equal(aReads, 1, "Discover reads the directory's curation");
      await changeQuery("private");
      assert.equal(
        aReads,
        2,
        "the real debounce started the search's directory request",
      );
      await act(async () => {
        aFirst.reject(new Error("A offline"));
        aPlugins.reject(new Error("A plugins offline"));
      });
      const oldRetry = mountedProps<{ onClick(): void }>(
        document.querySelector(".customize-load-error button")!,
      ).onClick;
      await click(".customize-load-error button");
      assert.equal(aReads, 3);
      app = controller("B", {}, ref);
      replaceBridge({
        ...bridgeA,
        listPlugins: async () => ({
          plugins: [],
          marketplaces: [],
          loadErrors: [],
        }),
        listApprovedDirectory: async () => {
          bReads++;
          return bRequest.promise;
        },
      });
      await render(display());
      assert.equal(
        document.querySelector(".unified-search"),
        null,
        "old query and its private results reset",
      );
      assert.equal(document.querySelector(".customize-load-error"), null);
      assert.equal(bReads, 1, "B's Discover reads its own curation");
      await act(async () => oldRetry());
      assert.equal(aReads, 3);
      assert.equal(bReads, 1);
      await changeQuery("private");
      assert.equal(bReads, 2);
      await act(async () => bRequest.reject(new Error("B offline")));
      assert.match(
        document.querySelector(".customize-load-error")!.textContent!,
        /Couldn’t finish searching/,
      );
      await act(async () => {
        aRetry.resolve([
          {
            kind: "plugin",
            id: "a-private",
            name: "Private A secret",
            description: "",
            url: "https://fixture.invalid/a",
            added: "2026-10-19",
          },
        ]);
        aPluginRetry.resolve({
          plugins: [
            {
              id: "secret@A",
              name: "private",
              title: "Private plugin A secret",
              installed: true,
              marketplace: "A",
              marketplacePath: "/A",
              enabled: true,
              installable: true,
              source: "local",
            },
          ],
          marketplaces: [],
          loadErrors: [],
        });
      });
      assert.doesNotMatch(
        document.querySelector("main")!.textContent!,
        /A secret/,
      );
      assert.ok(
        document.querySelector(".customize-load-error"),
        "old success cannot clear B failure",
      );
      const currentRetry = mountedProps<{ onClick(): void }>(
        document.querySelector(".customize-load-error button")!,
      ).onClick;
      ref.current = undefined;
      await act(async () => {
        oldRetry();
        currentRetry();
      });
      assert.equal(aReads, 3);
      assert.equal(bReads, 2);
    },
    {
      listPlugins: () =>
        ++pluginReads === 1 ? aPlugins.promise : aPluginRetry.promise,
      listApprovedDirectory: async () =>
        ++aReads <= 2 ? aFirst.promise : aRetry.promise,
    },
  );
});

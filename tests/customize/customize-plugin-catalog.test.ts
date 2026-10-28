import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { act, createElement as h } from "react";
import {
  PluginsBody,
  preloadMarketplaces,
} from "../../src/plugins/PluginsBody";
import { AppContext, type AppController } from "../../src/app/AppContext";
import type { PluginCatalog, PluginEntry } from "../../shared/collections-api";
import type { PluginsState } from "../../src/plugins/usePlugins";
import { routineDom } from "../support/routine-dom";
const noop = () => {};
const item = (name: string, extra: Partial<PluginEntry> = {}): PluginEntry => ({
  id: `${name}@market`,
  name,
  title: name,
  marketplace: "market",
  marketplacePath: "/synthetic/marketplace.json",
  installed: false,
  enabled: true,
  installable: true,
  source: "git",
  category: "development",
  ...extra,
});
const data = (extra: Partial<PluginEntry> = {}) =>
  item("data", {
    id: "data@knowledge-work-plugins",
    marketplace: "knowledge-work-plugins",
    title: "Runtime analytics",
    description: "Actual runtime description",
    developer: "Runtime author",
    category: "data",
    ...extra,
  });
const catalog = (entries: PluginEntry[]): PluginCatalog => ({
  plugins: entries,
  marketplaces: [
    {
      name: "market",
      path: "/synthetic/marketplace.json",
      plugins: entries.length,
      lastUpdated: Date.now(),
    },
  ],
  loadErrors: [],
});
const state = (extra: Partial<PluginsState> = {}): PluginsState => ({
  catalog: catalog([]),
  loading: false,
  reload: async () => {},
  install: async () => [],
  uninstall: async () => {},
  addMarketplace: async () => {},
  addOfficial: async () => {},
  removeMarketplace: async () => {},
  upgradeMarketplaces: async () => {},
  setAutoSync: async () => {},
  ...extra,
});
async function fixture() {
  const f = await routineDom({}, { jsdom: true });
  let app = {
    accountId: "catalog-account",
    controllerScope: {},
    page: "customize",
  } as AppController;
  app.currentController = { current: app };
  return {
    ...f,
    get app() {
      return app;
    },
    render: (child: ReturnType<typeof h>) =>
      f.render(h(AppContext.Provider, { value: app }, child)),
    replace(patch: Partial<AppController>) {
      const next = { ...app, ...patch };
      app.currentController!.current = next;
      app = next;
    },
    query<T extends Element = HTMLElement>(selector: string) {
      const node = f.document.querySelector<T>(selector);
      assert.ok(node, selector);
      return node;
    },
    async until(check: () => boolean) {
      for (let i = 0; i < 40 && !check(); i++)
        await act(async () => {
          await new Promise((r) => setTimeout(r, 5));
        });
      assert.ok(check());
    },
  };
}
const props = {
  view: "discover" as const,
  filter: {},
  onOpen: noop,
  onAddMarketplace: noop,
  onDiscover: noop,
  onError: noop,
};
function defer<T>() {
  let resolve!: (value: T) => void, reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
for (const customize of [false, true])
  test(`${customize ? "Customize" : "Settings"} Discover uses actual Data metadata, categories and install IDs without unsupported ranked headings`, async () => {
    const f = await fixture();
    const writes: string[] = [],
      opened: PluginEntry[] = [];
    const feature = data();
    try {
      await f.render(
        h(PluginsBody, {
          ...props,
          customize,
          plugins: state({
            catalog: catalog([feature, item("Notes")]),
            install: async (id) => {
              writes.push(id);
              return [];
            },
          }),
          onOpen: (entry) => opened.push(entry),
        }),
      );
      const hero = f.query(".plugin-discovery-hero");
      assert.equal(hero.querySelector("h3")!.textContent, feature.title);
      assert.equal(hero.querySelector("p")!.textContent, feature.description);
      assert.equal(
        hero.querySelector("small")!.textContent,
        "from Runtime author",
      );
      assert.deepEqual(
        [
          ...f.document.querySelectorAll(
            ".plugin-discovery-section > h3, .plugin-discovery-heading > h3",
          ),
        ].map((e) => e.textContent),
        ["Available plugins", "Categories"],
      );
      await f.click('[aria-label="View Runtime analytics"]');
      assert.deepEqual(opened, [feature]);
      await f.click('[aria-label="Add Runtime analytics"]');
      assert.deepEqual(writes, [feature.id]);
      assert.equal(
        f.document.querySelectorAll(".customize-catalogue-cards > li").length,
        1,
      );
      assert.equal(
        [...f.document.querySelectorAll("h3")].some(
          (e) =>
            e.textContent === "New plugins" ||
            e.textContent === "Most installed plugins",
        ),
        false,
      );
    } finally {
      await f.clean();
    }
  });
for (const source of [
  "pending",
  "failure",
  "empty",
  "unrelated",
  "mismatched-id",
] as const)
  test(`${source} runtime catalog never manufactures a Data card`, async () => {
    const f = await fixture();
    try {
      const plugins =
        source === "pending"
          ? state({ catalog: undefined, loading: true })
          : source === "failure"
            ? state({
                catalog: undefined,
                failure: "Actual catalog unavailable",
              })
            : source === "empty"
              ? state({
                  catalog: { plugins: [], marketplaces: [], loadErrors: [] },
                })
              : state({
                  catalog: catalog([
                    source === "unrelated"
                      ? item("data", { title: "Different Data plugin" })
                      : data({ marketplace: "another-market" }),
                  ]),
                });
      await f.render(h(PluginsBody, { ...props, customize: true, plugins }));
      assert.equal(f.document.querySelector(".plugin-discovery-hero"), null);
      assert.equal(
        f.document.body.textContent!.includes(
          "Query, chart and explain your data",
        ),
        false,
      );
    } finally {
      await f.clean();
    }
  });
test("an actual blocked Data entry stays readable with its actual copy and cannot install", async () => {
  const f = await fixture();
  const opened: PluginEntry[] = [];
  const feature = data({ installable: false });
  try {
    await f.render(
      h(PluginsBody, {
        ...props,
        customize: true,
        plugins: state({
          catalog: catalog([feature]),
          install: async () => {
            assert.fail("blocked install");
            return [];
          },
        }),
        onOpen: (entry) => opened.push(entry),
      }),
    );
    assert.equal(
      f.query<HTMLButtonElement>('[aria-label="Add Runtime analytics"]')
        .disabled,
      true,
    );
    assert.equal(
      f.query<HTMLButtonElement>('[aria-label="Add Runtime analytics"]').title,
      "This plugin can't be installed.",
    );
    await f.click('[aria-label="Add Runtime analytics"]');
    await f.click('[aria-label="View Runtime analytics"]');
    assert.deepEqual(opened, [feature]);
    assert.equal(
      f.document.body.textContent!.includes("From Anthropic"),
      false,
    );
  } finally {
    await f.clean();
  }
});
test("Data descriptions are never filled from static reference copy and installed Data is Added", async () => {
  const f = await fixture();
  try {
    await f.render(
      h(PluginsBody, {
        ...props,
        plugins: state({
          catalog: catalog([
            data({
              description: undefined,
              developer: undefined,
              installed: true,
            }),
          ]),
        }),
      }),
    );
    assert.equal(f.query(".plugin-discovery-hero").querySelector("p"), null);
    assert.equal(
      f.query(".plugin-discovery-hero small").textContent,
      "from knowledge-work-plugins",
    );
    assert.equal(
      f.query<HTMLButtonElement>('[aria-label="Add Runtime analytics"]')
        .disabled,
      true,
    );
    assert.equal(
      f.query<HTMLButtonElement>('[aria-label="Add Runtime analytics"]')
        .textContent,
      "Added",
    );
  } finally {
    await f.clean();
  }
});
test("actual category filters and Show all preserve catalog order, include featured Data in category results and reset per account", async () => {
  const f = await fixture();
  const entries = [
    data(),
    ...Array.from({ length: 8 }, (_, i) =>
      item(`Tool ${i}`, { category: i % 2 ? "design" : "development" }),
    ),
  ];
  const page = () =>
    h(PluginsBody, { ...props, plugins: state({ catalog: catalog(entries) }) });
  try {
    await f.render(page());
    assert.equal(
      f.document.querySelectorAll(".customize-catalogue-cards > li").length,
      6,
    );
    await f.click('[aria-label="Show all: Available plugins"]');
    assert.equal(
      f.document.querySelectorAll(".customize-catalogue-cards > li").length,
      8,
    );
    assert.deepEqual(
      [...f.document.querySelectorAll(".customize-catalogue-cards strong")].map(
        (e) => e.textContent,
      ),
      entries.slice(1).map((e) => e.title),
    );
    const category = [
      ...f.document.querySelectorAll<HTMLButtonElement>(
        ".plugin-discovery-categories button",
      ),
    ].find((e) => e.textContent === "Data")!;
    await f.event(category, "click");
    assert.equal(f.document.querySelector(".plugin-discovery-hero"), null);
    assert.deepEqual(
      [...f.document.querySelectorAll(".customize-catalogue-cards strong")].map(
        (e) => e.textContent,
      ),
      ["Runtime analytics"],
    );
    await f.event(category, "click");
    assert.equal(
      f.document.querySelectorAll(".customize-catalogue-cards > li").length,
      6,
    );
    await f.click('[aria-label="Show all: Available plugins"]');
    f.replace({ accountId: "another-account", controllerScope: {} });
    await f.render(page());
    assert.equal(
      f.document.querySelectorAll(".customize-catalogue-cards > li").length,
      6,
    );
    assert.ok(f.document.querySelector(".plugin-discovery-hero"));
  } finally {
    await f.clean();
  }
});
test("parent query and marketplace filters use real results and hide the discovery feature/categories", async () => {
  const f = await fixture();
  try {
    const plugins = state({ catalog: catalog([data(), item("notes")]) });
    await f.render(
      h(PluginsBody, { ...props, plugins, filter: { query: "notes" } }),
    );
    assert.equal(f.document.querySelector(".plugin-discovery-hero"), null);
    assert.equal(
      f.document.querySelector(".plugin-discovery-categories"),
      null,
    );
    assert.deepEqual(
      [...f.document.querySelectorAll(".customize-catalogue-cards strong")].map(
        (e) => e.textContent,
      ),
      ["notes"],
    );
    await f.render(
      h(PluginsBody, {
        ...props,
        plugins,
        filter: { marketplace: "knowledge-work-plugins" },
      }),
    );
    assert.deepEqual(
      [...f.document.querySelectorAll(".customize-catalogue-cards strong")].map(
        (e) => e.textContent,
      ),
      ["Runtime analytics"],
    );
  } finally {
    await f.clean();
  }
});
test("Data install stays busy, reports a real failure once, and retries the same runtime ID", async () => {
  const f = await fixture();
  const first = defer<string[]>(),
    second = defer<string[]>();
  const calls: string[] = [],
    errors: unknown[] = [];
  try {
    await f.render(
      h(PluginsBody, {
        ...props,
        plugins: state({
          catalog: catalog([data()]),
          install: (id) => {
            calls.push(id);
            return calls.length === 1 ? first.promise : second.promise;
          },
        }),
        onError: (e) => errors.push(e),
      }),
    );
    await f.click('[aria-label="Add Runtime analytics"]');
    await f.click('[aria-label="Add Runtime analytics"]');
    assert.equal(
      f.query<HTMLButtonElement>('[aria-label="Add Runtime analytics"]')
        .disabled,
      true,
    );
    assert.equal(calls.length, 1);
    await act(async () => first.reject(Error("Real install failed")));
    assert.equal(errors.length, 1);
    assert.equal(
      f.query<HTMLButtonElement>('[aria-label="Add Runtime analytics"]')
        .disabled,
      false,
    );
    await f.click('[aria-label="Add Runtime analytics"]');
    assert.deepEqual(calls, [data().id, data().id]);
    await act(async () => second.resolve([]));
    assert.equal(
      f.query<HTMLButtonElement>('[aria-label="Add Runtime analytics"]')
        .disabled,
      false,
    );
  } finally {
    await f.clean();
  }
});
for (const replacement of [
  "account",
  "bridge",
  "route",
  "category",
  "unmount",
] as const)
  test(`a ${replacement} replacement suppresses an old Data install failure`, async () => {
    const f = await fixture();
    const pending = defer<string[]>();
    const errors: unknown[] = [];
    try {
      const page = () =>
        h(PluginsBody, {
          ...props,
          plugins: state({
            catalog: catalog([data(), item("Notes")]),
            install: () => pending.promise,
          }),
          onError: (e) => errors.push(e),
        });
      await f.render(page());
      await f.click('[aria-label="Add Runtime analytics"]');
      if (replacement === "account") {
        f.replace({ accountId: "new-account", controllerScope: {} });
        await f.render(page());
      } else if (replacement === "bridge") {
        f.window.desktop = { ...f.window.desktop };
        await f.render(page());
      } else if (replacement === "route") {
        f.app.currentController!.current = {
          ...f.app,
          page: "home",
        } as AppController;
      } else if (replacement === "category") {
        const button = [
          ...f.document.querySelectorAll(".plugin-discovery-categories button"),
        ].find((e) => e.textContent === "Development")!;
        await f.event(button, "click");
      } else await f.render(h("div"));
      await act(async () => pending.reject(Error("Retired failure")));
      assert.deepEqual(errors, []);
    } finally {
      await f.clean();
    }
  });
test("a route/controller change before rendering refuses a retained feature action", async () => {
  const f = await fixture();
  let writes = 0,
    opens = 0;
  try {
    await f.render(
      h(PluginsBody, {
        ...props,
        plugins: state({
          catalog: catalog([data()]),
          install: async () => {
            writes++;
            return [];
          },
        }),
        onOpen: () => opens++,
      }),
    );
    f.app.currentController!.current = {
      ...f.app,
      page: "home",
    } as AppController;
    await f.click('[aria-label="Add Runtime analytics"]');
    await f.click('[aria-label="View Runtime analytics"]');
    assert.equal(writes, 0);
    assert.equal(opens, 0);
  } finally {
    await f.clean();
  }
});
test("Settings keeps actual marketplace management after the new discovery sections", async () => {
  const f = await fixture();
  await preloadMarketplaces();
  let adds = 0;
  try {
    await f.render(
      h(PluginsBody, {
        ...props,
        onAddMarketplace: () => adds++,
        plugins: state({ catalog: catalog([item("Notes")]) }),
      }),
    );
    assert.ok(f.document.querySelector(".plugin-marketplaces"));
    const button = [
      ...f.document.querySelectorAll<HTMLButtonElement>(
        ".plugin-marketplaces button",
      ),
    ].find((e) => e.textContent === "Add marketplace")!;
    await f.event(button, "click");
    assert.equal(adds, 1);
  } finally {
    await f.clean();
  }
});
test("Discover plugins use the live two-column cards with 60x28 Try and 28x28 Add", async () => {
  const f = await fixture();
  try {
    const style = f.document.createElement("style");
    style.textContent = [
      "src/styles/00-foundation.css",
      "src/collections/customize/customize.css",
      "src/collections/customize/customize-directory.css",
      "src/plugins/plugins.css",
      "src/plugins/plugin-lifecycle.css",
      "src/plugins/plugin-discover.css",
    ]
      .map((file) => readFileSync(file, "utf8"))
      .join("\n");
    f.document.head.append(style);
    await f.render(
      h(PluginsBody, {
        ...props,
        plugins: state({ catalog: catalog([item("Notes")]) }),
        onUsePlugin: noop,
      }),
    );
    const rows = f.query(".customize-catalogue-cards"),
      tryButton = f.query(".customize-catalogue-try"),
      addButton = f.query(".customize-catalogue-add");
    assert.equal(f.window.getComputedStyle(rows).display, "grid");
    assert.equal(f.window.getComputedStyle(tryButton).paddingLeft, "10px");
    assert.equal(f.window.getComputedStyle(tryButton).gap, "6px");
    assert.equal(f.window.getComputedStyle(tryButton).height, "28px");
    assert.equal(f.window.getComputedStyle(addButton).width, "28px");
    assert.equal(f.window.getComputedStyle(addButton).height, "28px");
  } finally {
    await f.clean();
  }
});

import assert from "node:assert/strict";
import test from "node:test";
import { act, createElement, type ReactElement } from "react";
import { JSDOM } from "jsdom";
import type { PluginEntry } from "../../shared/collections-api";
import type { PluginsState } from "../../src/plugins/usePlugins";
import { HostContext } from "../../src/host/HostContext";
import { hostFor } from "../../shared/host";

const entry = (
  name: string,
  overrides: Partial<PluginEntry> = {},
): PluginEntry => ({
  id: `${name}@example`,
  name,
  title: name,
  marketplace: "example",
  marketplacePath: "/marketplace.json",
  installed: false,
  enabled: true,
  installable: true,
  source: "local",
  category: "development",
  ...overrides,
});
const marketplace = {
  name: "example",
  path: "/marketplace.json",
  plugins: 1,
  source: "owner/repo",
};
function state(overrides: Partial<PluginsState> = {}): PluginsState {
  return {
    catalog: {
      marketplaces: [marketplace],
      plugins: [entry("plugin")],
      loadErrors: [],
    },
    loading: false,
    reload: async () => {},
    install: async () => [],
    uninstall: async () => {},
    addMarketplace: async () => {},
    addOfficial: async () => {},
    removeMarketplace: async () => {},
    upgradeMarketplaces: async () => {},
    setAutoSync: async () => {},
    ...overrides,
  };
}
const fail = (error: unknown) => {
  throw error;
};
async function dom(
  run: (ui: {
    document: Document;
    window: JSDOM["window"];
    render: (
      element: ReactElement,
      surface?: "desktop" | "web",
    ) => Promise<void>;
    click: (selector: string) => Promise<void>;
    input: (selector: string, text: string) => Promise<void>;
    settle: () => Promise<void>;
  }) => Promise<void>,
) {
  const jsdom = new JSDOM(
    '<!doctype html><html data-motion="reduced"><body><main></main></body></html>',
    { url: "https://claudex.test", pretendToBeVisual: true },
  );
  const { window } = jsdom;
  const { document } = window;
  Object.assign(window, {
    desktop: {
      readPlugin: async () => ({
        description: "Plugin description",
        skills: [],
        apps: [],
        mcpServers: [],
        hooks: 0,
      }),
      githubStatus: async () => ({ configured: true, connected: true }),
      githubRepositories: async () => ({
        items: [],
        nextPage: null,
        truncated: false,
      }),
    },
  });
  window.HTMLElement.prototype.getBoundingClientRect = () => ({
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: 32,
    bottom: 32,
    width: 32,
    height: 32,
    toJSON() {},
  });
  const globals = {
    window,
    document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    Element: window.Element,
    Node: window.Node,
    MutationObserver: window.MutationObserver,
    CustomEvent: window.CustomEvent,
    innerWidth: 1440,
    innerHeight: 900,
    getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
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
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.querySelector("main")!);
  const click = async (selector: string) => {
    const button = document.querySelector<HTMLButtonElement>(selector);
    assert.ok(button, selector);
    await act(async () => button.click());
  };
  const input = async (selector: string, value: string) => {
    const field = document.querySelector<HTMLInputElement>(selector);
    assert.ok(field, selector);
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      )!.set!.call(field, value);
      field.dispatchEvent(new window.Event("input", { bubbles: true }));
    });
  };
  const settle = async () => {
    await act(async () => new Promise((resolve) => setTimeout(resolve, 230)));
  };
  try {
    await run({
      document,
      window,
      render: async (element, surface = "desktop") => {
        await act(async () =>
          root.render(
            createElement(
              HostContext.Provider,
              { value: hostFor(surface) },
              element,
            ),
          ),
        );
      },
      click,
      input,
      settle,
    });
  } finally {
    await act(async () => root.unmount());
    jsdom.window.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}

test("plugin detail moves supported actions to overflow and uses the real duplicate/remove handlers", async () => {
  await dom(async ({ document, render, click, settle }) => {
    const { PluginDetailDialog } =
      await import("../../src/plugins/PluginDetailDialog");
    const plugin = entry("Personal", { installed: true, personal: true });
    const removed: string[] = [];
    await render(
      createElement(PluginDetailDialog, {
        plugin,
        plugins: state({
          catalog: {
            marketplaces: [marketplace],
            plugins: [plugin],
            loadErrors: [],
          },
          duplicate: async () => ({ id: "copy", appsNeedingAuth: [] }),
          rename: async () => ({ id: "renamed", appsNeedingAuth: [] }),
          uninstall: async (id) => {
            removed.push(id);
          },
        }),
        onClose() {},
        onError: fail,
      }),
    );
    assert.equal(document.querySelector('[role="menu"]'), null);
    assert.equal(
      document
        .querySelector(".plugin-detail-actions")!
        .textContent!.replace(/\p{Co}/gu, ""),
      "Added",
    );
    await click('button[aria-label="More actions for Personal"]');
    const items = Array.from(
      document.querySelectorAll('[role="menuitem"]'),
      (item) => item.textContent,
    );
    assert.deepEqual(items, ["Rename", "Duplicate", "Remove"]);
    assert.doesNotMatch(document.body.textContent!, /Share|Update|Try in chat/);
    await click('[role="menuitem"]:last-child');
    assert.deepEqual(removed, []);
    await settle();
    assert.ok(document.querySelector('[role="alertdialog"]'));
    await click('[role="alertdialog"] .primary');
    assert.deepEqual(removed, [plugin.id]);
  });
});

test("Try in chat obeys installed/enabled capability and install completes before row Try", async () => {
  await dom(async ({ document, render, click }) => {
    const { PluginDetailDialog } =
      await import("../../src/plugins/PluginDetailDialog");
    const { PluginRows } = await import("../../src/plugins/PluginRows");
    const calls: string[] = [];
    let resolve!: (services: string[]) => void;
    const plugin = entry("Example", { installed: true, enabled: false });
    await render(
      createElement(PluginDetailDialog, {
        plugin,
        plugins: state(),
        onClose() {},
        onError: fail,
        onTry: () => calls.push("try"),
      }),
    );
    assert.equal(
      document.querySelector<HTMLButtonElement>(
        ".plugin-detail-actions .primary",
      )?.disabled,
      true,
    );
    await render(
      createElement(PluginRows, {
        entries: [entry("Example")],
        plugins: state({
          install: async () => {
            calls.push("install");
            return new Promise((done) => {
              resolve = done;
            });
          },
        }),
        onOpen() {},
        onError: fail,
        onTry: () => calls.push("try"),
      }),
    );
    await click('[aria-label="Add Example and try it in chat"]');
    assert.deepEqual(calls, ["install"]);
    await act(async () => resolve([]));
    assert.deepEqual(calls, ["install", "try"]);
  });
});

test("marketplaces management preserves empty/Done and exposes one refresh plus GitHub auto-sync", async () => {
  await dom(async ({ document, render, click }) => {
    const { ManageMarketplacesDialog } =
      await import("../../src/plugins/ManageMarketplacesDialog");
    let closed = 0;
    const syncs: string[] = [];
    const props = {
      onClose: () => {
        closed++;
      },
      onAdd() {},
      onError: fail,
    };
    await render(
      createElement(ManageMarketplacesDialog, {
        ...props,
        plugins: state({
          catalog: { marketplaces: [], plugins: [], loadErrors: [] },
        }),
      }),
    );
    assert.match(document.body.textContent!, /No marketplaces added yet\./);
    await click(".button-row .primary");
    assert.equal(closed, 1);
    await render(
      createElement(ManageMarketplacesDialog, {
        ...props,
        plugins: state({
          upgradeMarketplaces: async (name) => {
            syncs.push(name!);
          },
          setAutoSync: async (name, enabled) => {
            syncs.push(`${name}:${enabled}`);
          },
        }),
      }),
    );
    assert.equal(
      document.querySelectorAll(
        '.plugin-marketplaces-management [role="list"] > li',
      ).length,
      1,
    );
    await click('[aria-label="More actions for example"]');
    assert.equal(
      Array.from(document.querySelectorAll('[role="menuitem"]')).filter(
        (item) => item.textContent === "Check for updates",
      ).length,
      1,
    );
    assert.doesNotMatch(document.body.textContent!, /Refresh marketplace/);
    await click('[role="menuitem"]');
    assert.deepEqual(syncs, ["example"]);
    await click('[aria-label="More actions for example"]');
    await click('[role="menuitemcheckbox"]');
    assert.deepEqual(syncs, ["example", "example:true"]);
  });
});

test("Discover uses its actual Data entry and only installs the confirmed runtime Data plugin", async () => {
  await dom(async ({ document, render, click }) => {
    const { PluginsBody } = await import("../../src/plugins/PluginsBody");
    const entries = [
      entry("data", {
        id: "data@knowledge-work-plugins",
        marketplace: "knowledge-work-plugins",
        title: "Data",
        category: "data",
      }),
      ...Array.from({ length: 8 }, (_, i) => entry(`Tool ${i}`)),
    ];
    const installed: string[] = [];
    await render(
      createElement(PluginsBody, {
        customize: true,
        view: "discover",
        filter: {},
        plugins: state({
          catalog: {
            marketplaces: [marketplace],
            plugins: entries,
            loadErrors: [],
          },
          install: async (id) => {
            installed.push(id);
            return [];
          },
        }),
        onOpen() {},
        onAddMarketplace() {},
        onDiscover() {},
        onError: fail,
      }),
    );
    assert.equal(
      document.querySelector(".plugin-discovery-hero h3")?.textContent,
      "Data",
    );
    assert.equal(
      document.querySelectorAll(".customize-catalogue-cards > li").length,
      6,
    );
    await click('[aria-label="Show all: Available plugins"]');
    assert.equal(
      document.querySelectorAll(".customize-catalogue-cards > li").length,
      8,
    );
    await click('[aria-label="Add Data"]');
    assert.deepEqual(installed, ["data@knowledge-work-plugins"]);
    await click(".plugin-discovery-categories button");
    assert.equal(document.querySelector(".plugin-discovery-hero"), null);
    assert.ok(
      document.querySelector(
        '.plugin-discovery-categories [aria-pressed="true"]',
      ),
    );
    assert.doesNotMatch(
      document.body.textContent!,
      /Most installed|New plugins|Marketplaces/,
    );
    await render(
      createElement(PluginsBody, {
        customize: true,
        view: "discover",
        filter: {},
        plugins: state(),
        onOpen() {},
        onAddMarketplace() {},
        onDiscover() {},
        onError: fail,
      }),
    );
    assert.equal(document.querySelector(".plugin-discovery-hero"), null);
  });
});

test("repository search pages real GitHub results, selects a source and blocks pending close", async () => {
  await dom(async ({ document, window, render, click, input, settle }) => {
    const { AddMarketplaceDialog } =
      await import("../../src/plugins/AddMarketplaceDialog");
    const requests: unknown[] = [];
    const added: string[] = [];
    let finish!: () => void;
    let closed = 0;
    let changed = 0;
    window.desktop.githubRepositories = async (request) => {
      requests.push(request);
      return {
        items: [
          {
            fullName: request?.page === 2 ? "owner/second" : "owner/first",
            name: "first",
            owner: "owner",
            description: "Repository",
            private: false,
            defaultBranch: "main",
            cloneUrl: "https://github.com/owner/first.git",
          },
        ],
        nextPage: request?.page === 2 ? null : 2,
        truncated: false,
      };
    };
    await render(
      createElement(AddMarketplaceDialog, {
        plugins: state({
          addMarketplace: async (source) => {
            added.push(source);
            return new Promise<void>((resolve) => {
              finish = resolve;
            });
          },
        }),
        onClose: () => {
          closed++;
        },
        onAdded: () => {
          changed++;
        },
      }),
    );
    await click(".directory-option:nth-child(2)");
    await click("#marketplace-repository-trigger");
    await input("#marketplace-repository", "owner");
    await settle();
    assert.deepEqual(requests, [{ query: "owner", page: 1 }]);
    const firstOption = document.querySelector(
      '#marketplace-repositories [role="option"]',
    )!;
    assert.equal(firstOption.querySelector("strong")?.textContent, "first");
    assert.equal(firstOption.querySelector("small")?.textContent, "owner");
    assert.equal(firstOption.getAttribute("aria-label"), "owner/first");
    await click("#marketplace-repositories > button:last-child");
    assert.deepEqual(requests, [
      { query: "owner", page: 1 },
      { query: "owner", page: 2 },
    ]);
    await click('#marketplace-repositories [role="option"]:last-of-type');
    assert.equal(
      document.querySelector("#marketplace-repository-trigger span")
        ?.textContent,
      "owner/second",
    );
    await click('button[type="submit"]');
    assert.deepEqual(added, ["owner/second"]);
    assert.equal(
      document.querySelector(".add-marketplace-dialog header button"),
      null,
    );
    await act(async () =>
      document.dispatchEvent(
        new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      ),
    );
    await act(async () =>
      document
        .querySelector(".overlay")!
        .dispatchEvent(new window.MouseEvent("mousedown", { bubbles: true })),
    );
    assert.equal(closed, 0);
    await act(async () => finish());
    assert.equal(closed, 1);
    assert.equal(changed, 1);
  });
});

test("repository errors retry, invalid addresses never sync, and desktop auth stays on the local flow", async () => {
  await dom(async ({ document, window, render, click, input, settle }) => {
    const { AddMarketplaceDialog } =
      await import("../../src/plugins/AddMarketplaceDialog");
    let attempts = 0;
    const added: string[] = [];
    window.desktop.githubStatus = async () => ({
      configured: true,
      connected: false,
    });
    await render(
      createElement(AddMarketplaceDialog, {
        plugins: state({
          addMarketplace: async (source) => {
            added.push(source);
          },
        }),
        onClose() {},
        onAdded() {},
      }),
    );
    await click(".directory-option:nth-child(2)");
    await click("#marketplace-repository-trigger");
    assert.match(document.body.textContent!, /gh auth login/);
    assert.doesNotMatch(document.body.textContent!, /Connect GitHub/);
    await input(
      "#marketplace-repository",
      "https://user:secret@github.com/owner/repo",
    );
    assert.equal(
      document.querySelector('[aria-invalid="true"]')?.id,
      "marketplace-repository",
    );
    assert.equal(
      document.querySelector<HTMLButtonElement>('button[type="submit"]')
        ?.disabled,
      true,
    );
    assert.deepEqual(added, []);
    window.desktop.githubStatus = async () => ({
      configured: true,
      connected: true,
    });
    await click(".marketplace-github-access button");
    window.desktop.githubRepositories = async () => {
      attempts++;
      if (attempts === 1) throw new Error("Repository lookup failed");
      return { items: [], nextPage: null, truncated: false };
    };
    await input("#marketplace-repository", "owner");
    await settle();
    assert.match(document.body.textContent!, /Repository lookup failed/);
    await click('#marketplace-repositories [role="alert"] button');
    await settle();
    assert.equal(attempts, 2);
    assert.match(document.body.textContent!, /No repositories found/);
  });
});

test("repository queries discard stale responses and allow failed sync to retry", async () => {
  await dom(async ({ document, window, render, click, input, settle }) => {
    const { AddMarketplaceDialog } =
      await import("../../src/plugins/AddMarketplaceDialog");
    const pending: Array<{
      query?: string;
      resolve: (result: {
        items: never[];
        nextPage: null;
        truncated: false;
      }) => void;
    }> = [];
    window.desktop.githubRepositories = async (request) =>
      new Promise((resolve) =>
        pending.push({ query: request?.query, resolve }),
      );
    let attempts = 0;
    let closed = 0;
    await render(
      createElement(AddMarketplaceDialog, {
        plugins: state({
          addMarketplace: async () => {
            attempts++;
            if (attempts === 1) throw new Error("Marketplace unavailable");
          },
        }),
        onClose: () => {
          closed++;
        },
        onAdded() {},
      }),
    );
    await click(".directory-option:nth-child(2)");
    await click("#marketplace-repository-trigger");
    await input("#marketplace-repository", "first");
    await settle();
    await input("#marketplace-repository", "second");
    await settle();
    assert.deepEqual(
      pending.map((item) => item.query),
      ["first", "second"],
    );
    await act(async () =>
      pending[0].resolve({ items: [], nextPage: null, truncated: false }),
    );
    assert.match(
      document.querySelector("#marketplace-repositories")!.textContent!,
      /Searching repositories/,
    );
    await act(async () =>
      pending[1].resolve({ items: [], nextPage: null, truncated: false }),
    );
    assert.match(
      document.querySelector("#marketplace-repositories")!.textContent!,
      /No repositories found/,
    );
    await input("#marketplace-repository", "https://github.com/owner/repo.git");
    await click(".marketplace-repository-custom");
    await click('button[type="submit"]');
    assert.equal(closed, 0);
    assert.match(document.body.textContent!, /Marketplace unavailable/);
    assert.equal(
      document.querySelector<HTMLButtonElement>('button[type="submit"]')
        ?.disabled,
      false,
    );
    await click('button[type="submit"]');
    assert.equal(attempts, 2);
    assert.equal(closed, 1);
  });
});

test("web repository access opens the existing GitHub connection settings", async () => {
  await dom(async ({ document, window, render, click }) => {
    const { AddMarketplaceDialog } =
      await import("../../src/plugins/AddMarketplaceDialog");
    const {
      readSettingsConnectorTarget,
      settingsNavigationEvent,
      takeSettingsConnectorTarget,
    } = await import("../../src/settings/navigation");
    window.desktop.githubStatus = async () => ({
      configured: true,
      connected: false,
    });
    let closed = 0;
    let target = "";
    window.addEventListener(settingsNavigationEvent, (event) => {
      target = (event as CustomEvent).detail;
    });
    await render(
      createElement(AddMarketplaceDialog, {
        plugins: state(),
        onClose: () => {
          closed++;
        },
        onAdded() {},
      }),
      "web",
    );
    await click(".directory-option:nth-child(2)");
    await click("#marketplace-repository-trigger");
    assert.doesNotMatch(document.body.textContent!, /gh auth login/);
    await click(".marketplace-github-access button");
    assert.equal(closed, 1);
    assert.equal(target, "connectors");
    assert.equal(readSettingsConnectorTarget(), "integration-github");
    assert.equal(
      new URL(window.location.href).searchParams.get("connector"),
      "integration-github",
    );
    takeSettingsConnectorTarget();
  });
});

test("Discover never fabricates Data and keeps an actual blocked Data entry readable without installing it", async () => {
  await dom(async ({ document, render, click }) => {
    const { PluginsBody } = await import("../../src/plugins/PluginsBody");
    const writes: string[] = [];
    const opened: PluginEntry[] = [];
    const blocked = entry("data", {
      id: "data@knowledge-work-plugins",
      marketplace: "knowledge-work-plugins",
      title: "Data",
      description: "Actual marketplace description",
      developer: "Runtime developer",
      installable: false,
    });
    const sources: Partial<PluginsState>[] = [
      { catalog: undefined, loading: true },
      { catalog: undefined, loading: false, failure: "Runtime unavailable" },
      { catalog: { marketplaces: [], plugins: [], loadErrors: [] } },
      {
        catalog: {
          marketplaces: [marketplace],
          plugins: [entry("data", { title: "Another Data plugin" })],
          loadErrors: [],
        },
      },
      {
        catalog: {
          marketplaces: [marketplace],
          plugins: [blocked],
          loadErrors: [],
        },
      },
    ];
    for (const source of sources) {
      await render(
        createElement(PluginsBody, {
          customize: true,
          view: "discover",
          filter: {},
          plugins: state({
            ...source,
            install: async (id) => {
              writes.push(id);
              return [];
            },
          }),
          onOpen(entry) {
            opened.push(entry);
          },
          onAddMarketplace() {},
          onDiscover() {},
          onError: fail,
        }),
      );
      const hero = document.querySelector(".plugin-discovery-hero");
      if (!source.catalog?.plugins.includes(blocked)) {
        assert.equal(hero, null);
        continue;
      }
      assert.ok(hero);
      assert.equal(hero.querySelector("h3")?.textContent, "Data");
      assert.equal(
        hero.querySelector("small")?.textContent,
        "from Runtime developer",
      );
      assert.equal(hero.querySelector("p")?.textContent, blocked.description);
      const add = hero.querySelector<HTMLButtonElement>(
        '[aria-label="Add Data"]',
      )!;
      assert.equal(add.disabled, true);
      assert.equal(add.title, "This plugin can't be installed.");
      await act(async () => add.click());
    }
    assert.deepEqual(writes, []);
    await click('.plugin-discovery-hero [aria-label="View Data"]');
    assert.deepEqual(opened, [blocked]);
    assert.equal(document.querySelector('[role="dialog"]'), null);
    assert.deepEqual(writes, []);
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
const pluginCatalog = (name: string) => ({
  marketplaces: [marketplace],
  plugins: [entry(name)],
  loadErrors: [],
});

// A live controller reference can retire independently from a React render.
async function ownershipFixtures() {
  const { AppContext } = await import("../../src/app/AppContext");
  type Controller = import("../../src/app/AppContext").AppController;
  const owner = (accountId: string) => {
    const controllerScope = {};
    const currentController = { current: undefined as Controller | undefined };
    const app = { accountId, controllerScope, currentController } as Controller;
    currentController.current = app;
    return app;
  };
  return { AppContext, owner };
}

test("plugin hook captures its bridge and owner for load, retry and retained operations", async () => {
  await dom(async ({ document, window, render }) => {
    const { AppContext, owner } = await ownershipFixtures();
    const { usePlugins, isPluginOperationRetired } =
      await import("../../src/plugins/usePlugins");
    const a = owner("A"),
      b = owner("B");
    const first = deferred<ReturnType<typeof pluginCatalog>>();
    const retry = deferred<ReturnType<typeof pluginCatalog>>();
    const next = deferred<ReturnType<typeof pluginCatalog>>();
    const calls: string[] = [];
    const bridgeA = {
      ...window.desktop,
      listPlugins: () => {
        calls.push("read:A");
        return calls.length === 1 ? first.promise : retry.promise;
      },
      installPlugin: async () => {
        calls.push("write:A");
        return { appsNeedingAuth: [] };
      },
    };
    const bridgeB = {
      ...window.desktop,
      listPlugins: () => {
        calls.push("read:B");
        return next.promise;
      },
      installPlugin: async () => {
        calls.push("write:B");
        return { appsNeedingAuth: [] };
      },
    };
    let captured!: PluginsState;
    function Probe() {
      captured = usePlugins();
      return createElement(
        "output",
        null,
        `${captured.catalog?.plugins[0]?.title ?? "pending"}|${captured.failure ?? ""}`,
      );
    }
    const show = (app: typeof a) =>
      render(
        createElement(
          AppContext.Provider,
          { value: app },
          createElement(Probe),
        ),
      );
    window.desktop = bridgeA as never;
    await show(a);
    const old = captured;
    await act(async () => {
      void old.reload();
    });
    window.desktop = bridgeB as never;
    await show(b);
    assert.equal(document.querySelector("output")!.textContent, "pending|");
    await act(async () => {
      first.resolve(pluginCatalog("Old A"));
      retry.reject(new Error("Old failure"));
    });
    assert.equal(document.querySelector("output")!.textContent, "pending|");
    await act(async () => next.resolve(pluginCatalog("Current B")));
    assert.equal(document.querySelector("output")!.textContent, "Current B|");
    await act(async () => {
      void old.reload();
      await assert.rejects(old.install("retired"), isPluginOperationRetired);
    });
    assert.deepEqual(calls, ["read:A", "read:A", "read:B"]);
    const current = captured;
    await render(createElement("div"));
    await act(async () => {
      void current.reload();
      await assert.rejects(
        current.install("unmounted"),
        isPluginOperationRetired,
      );
    });
    assert.deepEqual(calls, ["read:A", "read:A", "read:B"]);
  });
});

test("late plugin actions cannot refresh or notify a different account or a retired controller", async () => {
  await dom(async ({ window, render }) => {
    const { AppContext, owner } = await ownershipFixtures();
    const { usePlugins, usePluginOwner, isPluginOperationRetired } =
      await import("../../src/plugins/usePlugins");
    const a = owner("A"),
      b = owner("B"),
      c = owner("C");
    const pendingA = deferred<{ appsNeedingAuth: string[] }>();
    const pendingB = deferred<{ appsNeedingAuth: string[] }>();
    const calls: string[] = [];
    window.desktop = {
      ...window.desktop,
      listPlugins: async () => {
        calls.push("read");
        return pluginCatalog("Current");
      },
      installPlugin: () => {
        calls.push("install");
        return calls.filter((call) => call === "install").length === 1
          ? pendingA.promise
          : pendingB.promise;
      },
    } as never;
    let captured!: PluginsState;
    let checkOwner!: () => boolean;
    function Probe() {
      captured = usePlugins();
      checkOwner = usePluginOwner().current;
      return createElement("output");
    }
    const show = (app: typeof a) =>
      render(
        createElement(
          AppContext.Provider,
          { value: app },
          createElement(Probe),
        ),
      );
    let notified = 0;
    let finalized = 0;
    await show(a);
    const old = captured;
    const ownerA = checkOwner;
    let operationA!: Promise<string[]>;
    await act(async () => {
      operationA = old.install("A").finally(() => {
        finalized++;
      });
    });
    const cancelledA = assert.rejects(operationA, isPluginOperationRetired);
    void operationA.then(
      () => {
        if (ownerA()) notified++;
      },
      (error) => {
        if (ownerA() && !isPluginOperationRetired(error)) notified++;
      },
    );
    await show(b);
    await act(async () => pendingA.resolve({ appsNeedingAuth: [] }));
    await cancelledA;
    assert.equal(finalized, 1);
    assert.equal(notified, 0);
    assert.deepEqual(calls, ["read", "install", "read"]);
    const current = captured;
    const ownerB = checkOwner;
    let operationB!: Promise<string[]>;
    await act(async () => {
      operationB = current.install("B").finally(() => {
        finalized++;
      });
    });
    const cancelledB = assert.rejects(operationB, isPluginOperationRetired);
    void operationB.then(
      () => {
        if (ownerB()) notified++;
      },
      (error) => {
        if (ownerB() && !isPluginOperationRetired(error)) notified++;
      },
    );
    b.currentController!.current = undefined;
    await act(async () => {
      pendingB.reject(new Error("Retired failure"));
      await current.reload();
      await assert.rejects(
        current.install("retired"),
        isPluginOperationRetired,
      );
    });
    await cancelledB;
    assert.equal(finalized, 2);
    assert.equal(notified, 0);
    assert.deepEqual(calls, ["read", "install", "read", "install"]);
    await show(c);
    assert.deepEqual(calls, ["read", "install", "read", "install", "read"]);
  });
});

test("marketplace GitHub status/search/more and add callbacks stop at owner retirement", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  await dom(async ({ document, window, render, click, input }) => {
    const { AppContext, owner } = await ownershipFixtures();
    const { AddMarketplaceDialog } =
      await import("../../src/plugins/AddMarketplaceDialog");
    const a = owner("A"),
      b = owner("B"),
      c = owner("C"),
      d = owner("D");
    const oldStatus = deferred<{ configured: boolean; connected: boolean }>();
    const oldSearch = deferred<{
      items: never[];
      nextPage: null;
      truncated: false;
    }>();
    const oldMore = deferred<{
      items: never[];
      nextPage: null;
      truncated: false;
    }>();
    const oldAdd = deferred<void>();
    const calls: string[] = [];
    let notified = 0;
    let searchPage = 0;
    const repo = {
      fullName: "owner/current",
      owner: "owner",
      name: "current",
      private: false,
      description: "",
      defaultBranch: "main",
      cloneUrl: "https://github.com/owner/current",
    };
    const props = {
      plugins: state({
        addMarketplace: () => {
          calls.push("add");
          return oldAdd.promise;
        },
      }),
      onClose: () => {
        notified++;
      },
      onAdded: () => {
        notified++;
      },
    };
    const show = (app: typeof a) =>
      render(
        createElement(
          AppContext.Provider,
          { value: app },
          createElement(AddMarketplaceDialog, props),
        ),
      );
    const original = window.desktop;
    window.desktop = {
      ...original,
      githubStatus: () => {
        calls.push("status:A");
        return oldStatus.promise;
      },
    } as never;
    await show(a);
    await click(".directory-option:nth-child(2)");
    await click("#marketplace-repository-trigger");
    window.desktop = {
      ...original,
      githubStatus: async () => {
        calls.push("status:B");
        return { configured: true, connected: true };
      },
      githubRepositories: () => {
        calls.push("search:B");
        return oldSearch.promise;
      },
    } as never;
    await show(b);
    await act(async () =>
      oldStatus.resolve({ configured: true, connected: false }),
    );
    await click(".directory-option:nth-child(2)");
    await click("#marketplace-repository-trigger");
    assert.equal(document.querySelector(".marketplace-github-access"), null);
    await input("#marketplace-repository", "old");
    await act(async () => context.mock.timers.tick(200));
    assert.ok(calls.includes("search:B"));
    window.desktop = {
      ...original,
      githubStatus: async () => ({ configured: true, connected: true }),
      githubRepositories: () => {
        searchPage++;
        return searchPage === 1
          ? Promise.resolve({ items: [repo], nextPage: 2, truncated: false })
          : oldMore.promise;
      },
    } as never;
    await show(c);
    await act(async () => oldSearch.reject(new Error("Old search failure")));
    assert.doesNotMatch(document.body.textContent!, /Old search failure/);
    await click(".directory-option:nth-child(2)");
    await click("#marketplace-repository-trigger");
    await input("#marketplace-repository", "current");
    await act(async () => context.mock.timers.tick(200));
    await click("#marketplace-repositories > button:last-child");
    c.currentController!.current = undefined;
    await act(async () => oldMore.reject(new Error("Old page failure")));
    assert.doesNotMatch(document.body.textContent!, /Old page failure/);
    await show(d);
    await click(".directory-option:first-child");
    await click('[data-source="knowledge-work-plugins"] button');
    assert.equal(
      document.querySelector<HTMLButtonElement>(
        '[data-source="knowledge-work-plugins"] button',
      )?.disabled,
      true,
    );
    d.currentController!.current = undefined;
    await act(async () => oldAdd.resolve());
    assert.equal(notified, 0);
    assert.equal(calls.filter((call) => call === "add").length, 1);
    await render(createElement("div"));
  });
});

test("plugin detail reads and retained Try actions observe controller retirement", async () => {
  await dom(async ({ document, window, render, click }) => {
    const { AppContext, owner } = await ownershipFixtures();
    const { PluginDetailDialog } =
      await import("../../src/plugins/PluginDetailDialog");
    const a = owner("A"),
      b = owner("B");
    const read = deferred<{
      description: string;
      skills: never[];
      apps: never[];
      mcpServers: never[];
      hooks: number;
    }>();
    const plugin = entry("Installed", { installed: true });
    let tried = 0;
    window.desktop = {
      ...window.desktop,
      readPlugin: () => read.promise,
    } as never;
    const show = (app: typeof a) =>
      render(
        createElement(
          AppContext.Provider,
          { value: app },
          createElement(PluginDetailDialog, {
            plugin,
            plugins: state({
              catalog: {
                marketplaces: [marketplace],
                plugins: [plugin],
                loadErrors: [],
              },
            }),
            onClose() {},
            onError: fail,
            onTry: () => {
              tried++;
            },
          }),
        ),
      );
    await show(a);
    a.currentController!.current = undefined;
    await act(async () =>
      read.resolve({
        description: "Retired private description",
        skills: [],
        apps: [],
        mcpServers: [],
        hooks: 0,
      }),
    );
    assert.doesNotMatch(
      document.body.textContent!,
      /Retired private description/,
    );
    await click(".plugin-detail-actions .primary");
    assert.equal(tried, 0);
    window.desktop = {
      ...window.desktop,
      readPlugin: async () => ({
        description: "Current owner description",
        skills: [],
        apps: [],
        mcpServers: [],
        hooks: 0,
      }),
    } as never;
    await show(b);
    assert.match(document.body.textContent!, /Current owner description/);
    await click(".plugin-detail-actions .primary");
    assert.equal(tried, 1);
  });
});

test("marketplace repository picker is folded until opened, commits external URLs and closes its popup separately", async () => {
  await dom(async ({ document, window, render, click, input }) => {
    const { AddMarketplaceDialog } =
      await import("../../src/plugins/AddMarketplaceDialog");
    const { readFileSync } = await import("node:fs");
    const styles = document.createElement("style");
    styles.textContent = [
      "styles/00-foundation.css",
      "styles/50-controls-menus.css",
      "styles/80-dialogs-responsive.css",
      "settings/directory/directory.css",
      "collections/customize/customize.css",
      "plugins/plugins.css",
    ]
      .map((path) =>
        readFileSync(new URL(`../../src/${path}`, import.meta.url), "utf8"),
      )
      .join("\n");
    document.head.append(styles);
    const added: string[] = [];
    let closed = 0;
    await render(
      createElement(AddMarketplaceDialog, {
        plugins: state({
          addMarketplace: async (source) => {
            added.push(source);
          },
        }),
        onClose: () => {
          closed++;
        },
        onAdded() {},
      }),
    );
    assert.match(document.body.textContent!, /Browse curated sources/);
    assert.match(document.body.textContent!, /Curated marketplaces of plugins/);
    assert.doesNotMatch(document.body.textContent!, /Browse community sources/);
    await click(".directory-option:nth-child(2)");
    const trigger =
      document.querySelector<HTMLButtonElement>('[role="combobox"]')!;
    assert.equal(trigger.textContent, "Select a repository");
    assert.equal(trigger.getAttribute("aria-expanded"), "false");
    assert.equal(document.querySelector("#marketplace-repository"), null);
    assert.equal(document.querySelector("#marketplace-repositories"), null);
    assert.equal(window.getComputedStyle(trigger).height, "32px");
    const warning = window.getComputedStyle(
      document.querySelector('.add-marketplace-repository [role="note"]')!,
    );
    assert.equal(warning.display, "flex");
    assert.equal(warning.gap, "8px");
    assert.equal(warning.padding, "12px 16px");
    assert.equal(warning.backgroundColor, "rgb(60, 14, 14)");
    assert.equal(warning.color, "rgb(236, 126, 126)");
    assert.equal(warning.borderRadius, "12px");
    assert.equal(warning.lineHeight, "20px");
    assert.equal(warning.fontSize, "14px");
    assert.equal(warning.boxShadow, "inset 0 0 0 1px rgb(100 25 25)");
    assert.equal(
      window.getComputedStyle(
        document.querySelector('.add-marketplace-repository [role="note"] p')!,
      ).margin,
      "0px",
    );
    const header = window.getComputedStyle(
      document.querySelector(".add-marketplace-repository > header")!,
    );
    assert.equal(header.marginTop, "-4px");
    assert.equal(header.marginBottom, "28px");
    assert.equal(header.minHeight, "28px");
    const title = window.getComputedStyle(
      document.querySelector(".add-marketplace-repository h2")!,
    );
    assert.equal(title.lineHeight, "28px");
    assert.equal(title.fontWeight, "580");
    const close = window.getComputedStyle(
      document.querySelector(".add-marketplace-repository header > button")!,
    );
    assert.equal(close.width, "32px");
    assert.equal(close.height, "32px");
    assert.equal(close.margin, "-8px -8px 0px 0px");
    const field = window.getComputedStyle(
      document.querySelector(".marketplace-repository-field")!,
    );
    assert.equal(field.display, "flex");
    assert.equal(field.flexDirection, "column");
    assert.equal(field.gap, "0px");
    assert.equal(
      window.getComputedStyle(
        document.querySelector(".add-marketplace-repository form")!,
      ).display,
      "flex",
    );
    assert.equal(
      window.getComputedStyle(
        document.querySelector("#marketplace-repository-hint")!,
      ).lineHeight,
      "17.875px",
    );
    assert.equal(
      window.getComputedStyle(
        document.querySelector(".add-marketplace-dialog header h2")!,
      ).fontSize,
      "22px",
    );
    assert.equal(
      window.getComputedStyle(
        document.querySelector(".add-marketplace-dialog .button-row .primary")!,
      ).width,
      "56px",
    );
    assert.equal(
      window.getComputedStyle(
        document.querySelector(
          ".add-marketplace-dialog .button-row .secondary",
        )!,
      ).width,
      "70px",
    );
    await click("#marketplace-repository-trigger");
    assert.equal(trigger.getAttribute("aria-expanded"), "true");
    assert.ok(document.querySelector(".marketplace-repository-popover input"));
    assert.equal(
      window.getComputedStyle(
        document.querySelector(".marketplace-repository-popover input")!,
      ).height,
      "37px",
    );
    assert.equal(
      window.getComputedStyle(
        document.querySelector(".marketplace-repository-popover input")!,
      ).fontSize,
      "14px",
    );
    await act(async () =>
      document
        .querySelector("#marketplace-repository")!
        .dispatchEvent(
          new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
        ),
    );
    assert.equal(
      document.querySelector(".marketplace-repository-popover"),
      null,
    );
    assert.equal(closed, 0);
    await click("#marketplace-repository-trigger");
    await input(
      "#marketplace-repository",
      "https://git.example.test/team/marketplace.git",
    );
    await act(async () =>
      document.querySelector("#marketplace-repository")!.dispatchEvent(
        new window.KeyboardEvent("keydown", {
          key: "Enter",
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    assert.equal(
      document.querySelector(".marketplace-repository-popover"),
      null,
    );
    assert.equal(
      trigger.querySelector("span")?.textContent,
      "https://git.example.test/team/marketplace.git",
    );
    assert.deepEqual(added, []);
    await click('button[type="submit"]');
    assert.deepEqual(added, ["https://git.example.test/team/marketplace.git"]);
    assert.equal(closed, 1);
  });
});

test("Anthropic source rows match only actual GitHub sources and keep the internal directory distinct", async () => {
  await dom(async ({ document, render, click }) => {
    const { AddMarketplaceDialog } =
      await import("../../src/plugins/AddMarketplaceDialog");
    const { notAvailable } = await import("../../src/settings/unavailable");
    const added: string[] = [];
    let closed = 0;
    const catalog = {
      marketplaces: [
        {
          ...marketplace,
          name: "claude-plugins-official",
          source: "anthropics/claude-plugins-official",
        },
        {
          ...marketplace,
          name: "knowledge-work-plugins",
          title: "Knowledge Work",
          source: "https://github.com/impostor/knowledge-work-plugins",
        },
        {
          ...marketplace,
          name: "custom-manifest-name",
          source: "https://github.com/anthropics/knowledge-work-plugins.git",
        },
        {
          ...marketplace,
          name: "life-sciences",
          source: "https://github.com.evil.test/anthropics/life-sciences",
        },
      ],
      plugins: [],
      loadErrors: [],
    };
    const props = {
      plugins: state({
        catalog,
        addMarketplace: async (source: string) => {
          added.push(source);
        },
      }),
      onClose: () => {
        closed++;
      },
      onAdded() {},
    };
    await render(createElement(AddMarketplaceDialog, props));
    await click(".directory-option:first-child");
    assert.equal(
      document.querySelector('[role="dialog"]')?.getAttribute("aria-label"),
      "Curated sources",
    );
    assert.equal(
      document.querySelector(".anthropic-sources-description")?.textContent,
      "Choose which curated sources to include.",
    );
    const marks = document.querySelectorAll(
      ".anthropic-sources-list > li > svg",
    );
    assert.equal(marks.length, 7);
    for (const mark of marks) {
      assert.equal(mark.getAttribute("viewBox"), "0 0 28 28");
      assert.equal(mark.getAttribute("width"), "20");
      assert.equal(
        mark.querySelector("path")?.getAttribute("d"),
        "M20 4h-4.3l7.7 19.5h4.2L20 4ZM7.6 4 0 23.5h4.3L6 19.4h8l1.6 4h4.3L12.1 4H7.7Zm-.4 11.8 2.6-6.9 2.7 6.9H7.3Z",
      );
    }
    assert.deepEqual(
      Array.from(
        document.querySelectorAll(".anthropic-source-summary > strong"),
        (row) => row.textContent,
      ),
      [
        "Directory",
        "Knowledge Work",
        "Life Sciences",
        "Financial Services",
        "Legal",
        "Claudex Tag",
        "Healthcare",
      ],
    );
    const directory = document.querySelector<HTMLButtonElement>(
      '[data-source="anthropic-plugin-directory"] button',
    )!;
    assert.equal(directory.textContent, "Add");
    assert.equal(directory.disabled, true);
    assert.equal(directory.getAttribute("aria-description"), notAvailable);
    const knowledge = document.querySelector<HTMLButtonElement>(
      '[data-source="knowledge-work-plugins"] button',
    )!;
    assert.equal(knowledge.textContent, "Added");
    assert.equal(knowledge.disabled, true);
    const life = document.querySelector<HTMLButtonElement>(
      '[data-source="life-sciences"] button',
    )!;
    assert.equal(life.textContent, "Add");
    assert.equal(life.disabled, false);
    await click('[data-source="life-sciences"] button');
    assert.deepEqual(added, ["anthropics/life-sciences"]);
    assert.equal(closed, 0);
    assert.equal(
      life.textContent,
      "Add",
      "a successful callback alone is not installed-catalog evidence",
    );
    await render(
      createElement(AddMarketplaceDialog, {
        ...props,
        plugins: state({
          catalog: {
            ...catalog,
            marketplaces: [
              ...catalog.marketplaces,
              {
                ...marketplace,
                name: "life",
                source: "anthropics/life-sciences",
              },
            ],
          },
        }),
      }),
    );
    assert.equal(
      document.querySelector('[data-source="life-sciences"] button')
        ?.textContent,
      "Added",
    );
    await click(".anthropic-sources-content .button-row .primary");
    assert.equal(closed, 1);
  });
});

test("all six public Anthropic sources use the existing marketplace API and stay open until Done", async () => {
  await dom(async ({ document, window, render, click }) => {
    const { AddMarketplaceDialog } =
      await import("../../src/plugins/AddMarketplaceDialog");
    const { usePlugins } = await import("../../src/plugins/usePlugins");
    const writes: string[] = [];
    let reads = 0;
    let closed = 0;
    let changed = 0;
    const catalog = {
      marketplaces: [] as Array<typeof marketplace>,
      plugins: [],
      loadErrors: [],
    };
    window.desktop = {
      ...window.desktop,
      listPlugins: async () => {
        reads++;
        return { ...catalog, marketplaces: [...catalog.marketplaces] };
      },
      addPluginMarketplace: async (source: string) => {
        writes.push(source);
        catalog.marketplaces.push({
          ...marketplace,
          name: source.split("/")[1],
          source: `https://github.com/${source}.git`,
        });
      },
    } as never;
    function ConnectedSources() {
      return createElement(AddMarketplaceDialog, {
        plugins: usePlugins(),
        onClose: () => {
          closed++;
        },
        onAdded: () => {
          changed++;
        },
      });
    }
    await render(createElement(ConnectedSources));
    await click(".directory-option:first-child");
    const sources = [
      "knowledge-work-plugins",
      "life-sciences",
      "financial-services",
      "claude-for-legal",
      "claude-tag-plugins",
      "healthcare",
    ];
    for (const source of sources) {
      await click(`[data-source="${source}"] button`);
      assert.equal(
        document.querySelector(`[data-source="${source}"] button`)?.textContent,
        "Added",
      );
      assert.equal(closed, 0);
    }
    assert.deepEqual(
      writes,
      sources.map((source) => `anthropics/${source}`),
    );
    assert.equal(changed, 6);
    assert.equal(reads, 7);
    assert.equal(
      document.querySelectorAll(".anthropic-sources-list > li").length,
      7,
    );
    await click(".anthropic-sources-content .button-row .primary");
    assert.equal(closed, 1);
  });
});

test("an actual blocked Data hero uses the shared blue plugin banner in both themes", async () => {
  await dom(async ({ document, window, render }) => {
    const { PluginsBody } = await import("../../src/plugins/PluginsBody");
    const { readFileSync } = await import("node:fs");
    const styles = document.createElement("style");
    styles.textContent = [
      "styles/00-foundation.css",
      "collections/customize/customize.css",
      "plugins/plugins.css",
    ]
      .map((path) =>
        readFileSync(new URL(`../../src/${path}`, import.meta.url), "utf8"),
      )
      .join("\n");
    document.head.append(styles);
    await render(
      createElement(PluginsBody, {
        customize: true,
        view: "discover",
        filter: {},
        plugins: state({
          catalog: {
            marketplaces: [marketplace],
            plugins: [
              entry("data", {
                id: "data@knowledge-work-plugins",
                marketplace: "knowledge-work-plugins",
                title: "Data",
                installable: false,
              }),
            ],
            loadErrors: [],
          },
        }),
        onOpen() {},
        onAddMarketplace() {},
        onDiscover() {},
        onError: fail,
      }),
    );
    const hero = document.querySelector<HTMLElement>(".plugin-discovery-hero")!;
    assert.ok(hero.matches(".customize-feature.plugin"));
    const dark = window.getComputedStyle(hero);
    assert.equal(dark.backgroundColor, "rgb(3, 32, 66)");
    assert.equal(dark.display, "flex");
    assert.equal(dark.padding, "24px");
    assert.equal(dark.minHeight, "176px");
    assert.equal(dark.borderRadius, "12px");
    assert.equal(Number.parseFloat(dark.borderTopWidth || "0"), 0);
    assert.ok(
      hero.querySelector(".customize-feature-art .customize-data-illustration"),
    );
    assert.equal(
      hero.querySelector<HTMLButtonElement>('[aria-label="Add Data"]')
        ?.disabled,
      true,
    );
    document.documentElement.dataset.theme = "light";
    assert.equal(
      window.getComputedStyle(hero).backgroundColor,
      "rgb(197, 211, 224)",
    );
    assert.equal(
      window.getComputedStyle(
        hero.querySelector(".plugin-discovery-hero-title")!,
      ).backgroundColor,
      "rgba(0, 0, 0, 0)",
    );
  });
});

test("plugin detail Update reinstalls when the marketplace offers a newer version than the installed one", async () => {
  await dom(async ({ document, render, click }) => {
    const { PluginDetailDialog } =
      await import("../../src/plugins/PluginDetailDialog");
    const installs: string[] = [];
    const show = async (installedVersion: string) => {
      const plugin = entry("Versioned", {
        installed: true,
        enabled: true,
        installedVersion,
        availableVersion: "1.3.0",
      });
      await render(
        createElement(PluginDetailDialog, {
          plugin,
          plugins: state({
            catalog: {
              marketplaces: [marketplace],
              plugins: [plugin],
              loadErrors: [],
            },
            install: async (id) => {
              installs.push(id);
              return [];
            },
          }),
          onClose() {},
          onError: fail,
        }),
      );
      return Array.from(
        document.querySelectorAll<HTMLButtonElement>(
          ".plugin-detail-actions button",
        ),
      ).find((button) => button.textContent === "Update")!;
    };
    const latest = await show("1.3.0");
    assert.equal(latest.disabled, true);
    assert.equal(latest.title, "On latest version");
    const older = await show("1.2.0");
    assert.equal(older.disabled, false);
    assert.equal(older.title, "Update to 1.3.0");
    assert.equal(older.className, "primary");
    await click(".plugin-detail-actions button.primary");
    assert.equal(installs.length, 1);
  });
});

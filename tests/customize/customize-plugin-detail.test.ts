import test from "node:test";
import assert from "node:assert/strict";
import { act, createElement as h } from "react";
import { PluginDetailDialog } from "../../src/plugins/PluginDetailDialog";
import { AppContext, type AppController } from "../../src/app/AppContext";
import { HostContext } from "../../src/host/HostContext";
import { desktopHost, webHost } from "../../shared/host";
import type { PluginEntry, PluginDetails } from "../../shared/collections-api";
import type { PluginsState } from "../../src/plugins/usePlugins";
import { routineDom } from "../support/routine-dom";
import { currentToasts } from "../../src/ui/toast-store";
const noop = () => {};
const entry = (
  id = "notes@personal",
  extra: Partial<PluginEntry> = {},
): PluginEntry => ({
  id,
  name: id.split("@")[0],
  title: "Actual notes",
  marketplace: "personal",
  marketplacePath: "/synthetic/personal.json",
  installed: true,
  enabled: true,
  installable: true,
  source: "local",
  personal: true,
  ...extra,
});
const details = (description = "Actual content"): PluginDetails => ({
  description,
  skills: [],
  apps: [],
  mcpServers: [],
  hooks: 0,
});
const state = (
  plugin: PluginEntry,
  extra: Partial<PluginsState> = {},
): PluginsState => ({
  catalog: {
    plugins: [plugin],
    marketplaces: [
      { name: "personal", path: "/synthetic/personal.json", plugins: 1 },
    ],
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
  ...extra,
});
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
async function fixture(bridge: Partial<Window["desktop"]> = {}) {
  const f = await routineDom(
    { readPlugin: async () => details(), ...bridge },
    { jsdom: true },
  );
  const globals = { innerWidth: 1440, innerHeight: 900 };
  const saved = new Map(
    Object.keys(globals).map((k) => [
      k,
      Object.getOwnPropertyDescriptor(globalThis, k),
    ]),
  );
  for (const [k, v] of Object.entries(globals))
    Object.defineProperty(globalThis, k, { value: v, configurable: true });
  let app = {
    accountId: "detail-owner",
    controllerScope: {},
    page: "customize",
    activeId: "chat",
    draftSession: "draft",
    mode: "chat",
    settingsOpen: false,
  } as AppController;
  app.currentController = { current: app };
  return {
    ...f,
    get app() {
      return app;
    },
    replace(patch: Partial<AppController>) {
      const next = { ...app, ...patch };
      app.currentController!.current = next;
      app = next;
    },
    render: (node: ReturnType<typeof h>, host = desktopHost) =>
      f.render(
        h(
          HostContext.Provider,
          { value: host },
          h(AppContext.Provider, { value: app }, node),
        ),
      ),
    query<T extends Element = HTMLElement>(selector: string) {
      const node = f.document.querySelector<T>(selector);
      assert.ok(node, selector);
      return node;
    },
    async until(check: () => boolean) {
      for (let i = 0; i < 50 && !check(); i++)
        await act(async () => {
          await new Promise((r) => setTimeout(r, 5));
        });
      assert.ok(check());
    },
    async clean() {
      await f.clean();
      for (const [k, v] of saved)
        if (v) Object.defineProperty(globalThis, k, v);
        else Reflect.deleteProperty(globalThis, k);
    },
  };
}
const props = { onClose: noop, onError: noop };
async function choose(f: Awaited<ReturnType<typeof fixture>>, label: string) {
  await f.click(".plugin-detail-more");
  const row = [...f.document.querySelectorAll('[role="menuitem"]')].find(
    (e) => e.textContent === label,
  );
  assert.ok(row, label);
  await f.event(row, "click");
}
async function removeDialog(f: Awaited<ReturnType<typeof fixture>>) {
  await choose(f, "Remove");
  await f.until(() => !!f.document.querySelector('[role="alertdialog"]'));
  return f.query('[role="alertdialog"]');
}

test("Remove uses the source reversible warning, Cancel performs no RPC, and confirmed removal uses the canonical ID", async () => {
  const f = await fixture();
  const plugin = entry(),
    removed: string[] = [];
  try {
    await f.render(
      h(PluginDetailDialog, {
        ...props,
        plugin,
        plugins: state(plugin, {
          uninstall: async (id) => {
            removed.push(id);
          },
        }),
      }),
    );
    let dialog = await removeDialog(f);
    assert.equal(
      dialog.closest(".overlay")!.parentElement,
      f.document.body,
      "confirmation must not inherit the underlying detail overlay blur",
    );
    assert.equal(removed.length, 0);
    assert.ok(dialog.textContent!.includes("Remove plugin?"));
    assert.ok(
      dialog.textContent!.includes(
        "This plugin’s commands and skills will no longer be available. You can add it back later.",
      ),
    );
    await f.event(dialog.querySelector(".secondary")!, "click");
    assert.equal(f.document.querySelector('[role="alertdialog"]'), null);
    assert.equal(removed.length, 0);
    dialog = await removeDialog(f);
    await f.event(dialog.querySelector(".primary")!, "click");
    assert.deepEqual(removed, [plugin.id]);
    assert.equal(f.document.querySelector('[role="alertdialog"]'), null);
  } finally {
    await f.clean();
  }
});
test("Remove blocks duplicate submits and Escape/Cancel while pending, then retries a genuine backend failure", async () => {
  const f = await fixture();
  const plugin = entry(),
    first = deferred<void>(),
    second = deferred<void>();
  let calls = 0;
  try {
    await f.render(
      h(PluginDetailDialog, {
        ...props,
        plugin,
        plugins: state(plugin, {
          uninstall: () => (++calls === 1 ? first.promise : second.promise),
        }),
      }),
    );
    const dialog = await removeDialog(f);
    await f.event(dialog.querySelector(".primary")!, "click");
    await f.event(dialog.querySelector(".primary")!, "click");
    assert.equal(calls, 1);
    assert.equal(
      (dialog.querySelector(".secondary") as HTMLButtonElement).disabled,
      true,
    );
    await f.event(f.document, "keydown", { key: "Escape" });
    assert.ok(f.document.querySelector('[role="alertdialog"]'));
    await act(async () => first.reject(Error("Backend refused uninstall")));
    assert.equal(
      f.query('[role="alertdialog"] [role="alert"]').textContent,
      "Backend refused uninstall",
    );
    await f.event(dialog.querySelector(".primary")!, "click");
    assert.equal(calls, 2);
    await act(async () => second.resolve());
    assert.equal(f.document.querySelector('[role="alertdialog"]'), null);
  } finally {
    await f.clean();
  }
});
for (const change of ["account", "bridge", "route", "plugin", "close"] as const)
  test(`${change} retirement hides a late remove failure and never closes a replacement detail`, async () => {
    const f = await fixture();
    const plugin = entry(),
      pending = deferred<void>();
    let closes = 0;
    try {
      const page = (selected = plugin) =>
        h(PluginDetailDialog, {
          ...props,
          plugin: selected,
          plugins: state(selected, { uninstall: () => pending.promise }),
          onClose: () => closes++,
        });
      await f.render(page());
      const dialog = await removeDialog(f);
      await f.event(dialog.querySelector(".primary")!, "click");
      if (change === "account") {
        f.replace({ accountId: "next", controllerScope: {} });
        await f.render(page());
      } else if (change === "bridge") {
        f.window.desktop = { ...f.window.desktop };
        await f.render(page());
      } else if (change === "route") {
        f.app.currentController!.current = {
          ...f.app,
          page: "home",
        } as AppController;
      } else if (change === "plugin")
        await f.render(
          page(entry("other@personal", { title: "Other plugin" })),
        );
      else await f.render(h("div"));
      await act(async () =>
        pending.reject(Error("Private retired uninstall failure")),
      );
      assert.equal(
        f.document.body.textContent!.includes(
          "Private retired uninstall failure",
        ),
        false,
      );
      assert.equal(closes, 0);
    } finally {
      await f.clean();
    }
  });
test("detail reads reject malformed contents without crashing and Retry reads the same actual plugin", async () => {
  let reads = 0;
  const f = await fixture({
    readPlugin: async () =>
      ++reads === 1
        ? ({ ...details(), skills: [null] } as never)
        : details("Recovered content"),
  });
  const plugin = entry();
  try {
    await f.render(
      h(PluginDetailDialog, { ...props, plugin, plugins: state(plugin) }),
    );
    await f.until(
      () => !!f.document.querySelector(".plugin-detail-read-failure"),
    );
    await f.click(".plugin-detail-read-failure button");
    assert.ok(f.document.body.textContent!.includes("Recovered content"));
    assert.equal(reads, 2);
  } finally {
    await f.clean();
  }
});
test("a route replacement before the read settles discards old content and read errors", async () => {
  const read = deferred<PluginDetails>();
  const f = await fixture({ readPlugin: () => read.promise });
  const plugin = entry();
  try {
    await f.render(
      h(PluginDetailDialog, { ...props, plugin, plugins: state(plugin) }),
    );
    f.app.currentController!.current = {
      ...f.app,
      page: "home",
    } as AppController;
    await act(async () => read.resolve(details("Private old route content")));
    assert.equal(
      f.document.body.textContent!.includes("Private old route content"),
      false,
    );
    assert.equal(f.document.querySelector(".plugin-detail-read-failure"), null);
  } finally {
    await f.clean();
  }
});
test("Try and Add refuse a retired route even before rendering and Share/Update do not appear without exposed protocols", async () => {
  const f = await fixture();
  const plugin = entry();
  let tries = 0,
    adds = 0;
  try {
    const plugins = state(plugin, {
      install: async () => {
        adds++;
        return [];
      },
    });
    await f.render(
      h(PluginDetailDialog, {
        ...props,
        plugin,
        plugins,
        onUsePlugin: () => tries++,
      }),
    );
    f.app.currentController!.current = {
      ...f.app,
      page: "home",
    } as AppController;
    await f.click(".plugin-detail-actions .primary");
    assert.equal(tries, 0);
    f.replace({ page: "customize" });
    const available = entry(undefined, { installed: false });
    await f.render(
      h(PluginDetailDialog, {
        ...props,
        plugin: available,
        plugins: state(available, {
          install: async () => {
            adds++;
            return [];
          },
        }),
      }),
    );
    f.app.currentController!.current = {
      ...f.app,
      page: "home",
    } as AppController;
    await f.click(".plugin-detail-actions .primary");
    assert.equal(adds, 0);
    assert.equal(
      [...f.document.querySelectorAll("button")].some(
        (b) => b.textContent === "Share" || b.textContent === "Update",
      ),
      false,
    );
  } finally {
    await f.clean();
  }
});
test("rename follows the actual returned ID and rereads its details; it never acts on the old input ID afterward", async () => {
  const reads: string[] = [],
    writes: string[] = [];
  const f = await fixture({
    readPlugin: async (id) => {
      reads.push(id);
      return details(id);
    },
  });
  const plugin = entry(),
    renamed = entry("renamed@personal", {
      name: "renamed",
      title: "Renamed notes",
    });
  const plugins = state(plugin, {
    rename: async (id) => {
      writes.push(id);
      plugins.catalog = { ...plugins.catalog!, plugins: [renamed] };
      return { id: renamed.id, appsNeedingAuth: [] };
    },
  });
  try {
    await f.render(h(PluginDetailDialog, { ...props, plugin, plugins }));
    await choose(f, "Rename");
    await f.until(
      () => !!f.document.querySelector('input[aria-label="New plugin name"]'),
    );
    await f.change('input[aria-label="New plugin name"]', "Renamed notes");
    await f.event(f.query("form"), "submit");
    assert.deepEqual(writes, [plugin.id]);
    await f.until(() => reads.includes(renamed.id));
    assert.equal(
      f.query('[role="dialog"]').getAttribute("aria-label"),
      "Renamed notes",
    );
    await choose(f, "Remove");
    await f.until(() => !!f.document.querySelector('[role="alertdialog"]'));
    assert.equal(f.document.body.textContent!.includes(renamed.id), true);
  } finally {
    await f.clean();
  }
});
for (const change of ["route", "plugin", "close"] as const)
  test(`${change} retirement cancels rename success UI and notices`, async () => {
    const f = await fixture();
    const plugin = entry(),
      pending = deferred<{ id: string; appsNeedingAuth: string[] }>();
    try {
      const page = (selected = plugin) =>
        h(PluginDetailDialog, {
          ...props,
          plugin: selected,
          plugins: state(selected, { rename: () => pending.promise }),
        });
      await f.render(page());
      await choose(f, "Rename");
      await f.until(
        () => !!f.document.querySelector('input[aria-label="New plugin name"]'),
      );
      await f.change('input[aria-label="New plugin name"]', "Renamed");
      await f.event(f.query("form"), "submit");
      if (change === "route")
        f.app.currentController!.current = {
          ...f.app,
          page: "home",
        } as AppController;
      else if (change === "plugin")
        await f.render(page(entry("other@personal", { title: "Other" })));
      else await f.render(h("div"));
      await act(async () =>
        pending.resolve({ id: "renamed@personal", appsNeedingAuth: [] }),
      );
      assert.equal(
        currentToasts().some((t) => t.message.includes("Renamed to")),
        false,
      );
    } finally {
      await f.clean();
    }
  });
test("Duplicate remains backed by local copy capability; the typed name goes to the actual source ID", async () => {
  const f = await fixture();
  const plugin = entry(),
    copied: unknown[] = [];
  try {
    await f.render(
      h(PluginDetailDialog, {
        ...props,
        plugin,
        plugins: state(plugin, {
          duplicate: async (...args) => {
            copied.push(args);
            return { id: "copy@personal", appsNeedingAuth: [] };
          },
        }),
      }),
    );
    await choose(f, "Duplicate");
    await f.until(
      () => !!f.document.querySelector('input[aria-label="New plugin name"]'),
    );
    await f.change('input[aria-label="New plugin name"]', "Research notes");
    await f.event(f.query("form"), "submit");
    assert.deepEqual(copied, [
      [plugin.id, { name: "research-notes", displayName: "Research notes" }],
    ]);
    assert.equal(
      f.document.body.textContent!.includes("Duplicate plugin"),
      false,
    );
  } finally {
    await f.clean();
  }
});
test("web and remote-file details keep actual Rename/Duplicate capability restrictions", async () => {
  const f = await fixture();
  const plugin = entry(undefined, { source: "git", personal: false });
  try {
    await f.render(
      h(PluginDetailDialog, {
        ...props,
        plugin,
        plugins: state(plugin, {
          duplicate: async () => {
            assert.fail("remote duplicate");
            return { id: "x", appsNeedingAuth: [] };
          },
          rename: async () => {
            assert.fail("remote rename");
            return { id: "x", appsNeedingAuth: [] };
          },
        }),
      }),
      webHost,
    );
    await f.click(".plugin-detail-more");
    assert.equal(
      [...f.document.querySelectorAll('[role="menuitem"]')].some(
        (e) => e.textContent === "Rename",
      ),
      false,
    );
    const duplicate = [
      ...f.document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
    ].find((e) => e.textContent === "Duplicate")!;
    assert.equal(duplicate.disabled, true);
    await f.event(duplicate, "click");
    assert.equal(
      f.document.querySelector('input[aria-label="New plugin name"]'),
      null,
    );
  } finally {
    await f.clean();
  }
});

for (const outcome of ["success", "failure"] as const)
  test(`a replaced plugin hides a late Add ${outcome} and its authentication details`, async () => {
    const f = await fixture();
    const pending = deferred<string[]>(),
      errors: unknown[] = [];
    const first = entry("first@market", { installed: false }),
      second = entry("second@market", {
        installed: false,
        title: "Second plugin",
      });
    try {
      const page = (plugin: PluginEntry) =>
        h(PluginDetailDialog, {
          ...props,
          plugin,
          plugins: state(plugin, { install: () => pending.promise }),
          onError: (e) => errors.push(e),
        });
      await f.render(page(first));
      await f.click(".plugin-detail-actions .primary");
      await f.render(page(second));
      await act(async () =>
        outcome === "success"
          ? pending.resolve(["Private old auth account"])
          : pending.reject(Error("Private old Add failure")),
      );
      assert.equal(f.document.body.textContent!.includes("Private old"), false);
      assert.deepEqual(errors, []);
    } finally {
      await f.clean();
    }
  });
for (const change of ["route", "plugin", "close"] as const)
  test(`${change} retirement discards duplicate completion notices`, async () => {
    const f = await fixture();
    const pending = deferred<{ id: string; appsNeedingAuth: string[] }>(),
      plugin = entry();
    try {
      const page = (selected = plugin) =>
        h(PluginDetailDialog, {
          ...props,
          plugin: selected,
          plugins: state(selected, { duplicate: () => pending.promise }),
        });
      await f.render(page());
      await choose(f, "Duplicate");
      await f.until(
        () => !!f.document.querySelector('input[aria-label="New plugin name"]'),
      );
      await f.change(
        'input[aria-label="New plugin name"]',
        "Private duplicate",
      );
      await f.event(f.query("form"), "submit");
      if (change === "route")
        f.app.currentController!.current = {
          ...f.app,
          page: "home",
        } as AppController;
      else if (change === "plugin")
        await f.render(page(entry("other@personal")));
      else await f.render(h("div"));
      await act(async () =>
        pending.resolve({ id: "copy@personal", appsNeedingAuth: [] }),
      );
      assert.equal(
        currentToasts().some((t) => t.message.includes("Duplicated as")),
        false,
      );
    } finally {
      await f.clean();
    }
  });

test("catalog refresh can remove the dialog before its RPC settles, and a later reinstall never reopens old confirmation", async () => {
  const f = await fixture();
  const pending = deferred<void>();
  let plugin = entry();
  const page = () =>
    h(PluginDetailDialog, {
      ...props,
      plugin,
      plugins: state(plugin, { uninstall: () => pending.promise }),
    });
  try {
    await f.render(page());
    const dialog = await removeDialog(f);
    await f.event(dialog.querySelector(".primary")!, "click");
    plugin = { ...plugin, installed: false };
    await f.render(page());
    assert.equal(f.document.querySelector('[role="alertdialog"]'), null);
    await act(async () => pending.resolve());
    plugin = { ...plugin, installed: true };
    await f.render(page());
    assert.equal(f.document.querySelector('[role="alertdialog"]'), null);
  } finally {
    await f.clean();
  }
});

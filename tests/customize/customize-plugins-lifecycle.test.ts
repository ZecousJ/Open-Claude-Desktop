import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { act, createElement as h } from "react";
import { EditorView } from "@codemirror/view";
import { AppContext, type AppController } from "../../src/app/AppContext";
import { HostContext } from "../../src/host/HostContext";
import type { PluginUploadCommand } from "../../shared/plugin-upload";
import { desktopHost } from "../../shared/host";
import type {
  PluginCatalog,
  PluginDetails,
  PluginEntry,
} from "../../shared/collections-api";
import { pluginAddMenu } from "../../src/plugins/plugin-menu";
import { CreatePluginDialog } from "../../src/plugins/CreatePluginDialog";
import { PluginsBody } from "../../src/plugins/PluginsBody";
import { PluginRows } from "../../src/plugins/PluginRows";
import { PluginDetailDialog } from "../../src/plugins/PluginDetailDialog";
import { ManageMarketplacesDialog } from "../../src/plugins/ManageMarketplacesDialog";
import { sendPluginArchive } from "../../src/plugins/plugin-archive";
import { usePlugins, type PluginsState } from "../../src/plugins/usePlugins";
import { PageMenu } from "../../src/collections/PageMenu";
import { routineDom } from "../support/routine-dom";

const plugin = (id = "notes@personal"): PluginEntry => ({
  id,
  name: id.split("@")[0],
  title: id,
  marketplace: "personal",
  marketplacePath: "/personal",
  installed: true,
  enabled: true,
  installable: true,
  source: "local",
  personal: true,
});
const details = (name: string): PluginDetails => ({
  description: name,
  skills: [],
  apps: [],
  mcpServers: [],
  hooks: 0,
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function state(
  catalog: PluginCatalog = { plugins: [], marketplaces: [], loadErrors: [] },
): PluginsState {
  return {
    catalog,
    loading: false,
    reload: async () => {},
    install: async () => [],
    uninstall: async () => {},
    addMarketplace: async () => {},
    addOfficial: async () => {},
    removeMarketplace: async () => {},
    upgradeMarketplaces: async () => {},
    setAutoSync: async () => {},
  };
}
async function dom(bridge: Partial<Window["desktop"]> = {}) {
  const env = await routineDom(bridge, { jsdom: true });
  const viewport = new Map(
    ["innerWidth", "innerHeight", "Window"].map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  Object.defineProperty(globalThis, "Window", {
    configurable: true,
    value: env.window.Window,
  });
  Object.defineProperty(globalThis, "innerWidth", {
    configurable: true,
    value: 1440,
  });
  Object.defineProperty(globalThis, "innerHeight", {
    configurable: true,
    value: 900,
  });
  const clean = async () => {
    await env.clean();
    for (const [key, value] of viewport) {
      if (value) Object.defineProperty(globalThis, key, value);
      else Reflect.deleteProperty(globalThis, key);
    }
  };
  const app = {
    accountId: "A",
    controllerScope: {},
    currentController: { current: undefined },
  } as unknown as AppController;
  const render = (child: ReturnType<typeof h>) => {
    app.currentController!.current = app;
    return env.render(
      h(
        HostContext.Provider,
        { value: desktopHost },
        h(AppContext.Provider, { value: app }, child),
      ),
    );
  };
  const query = <T extends Element = HTMLElement>(selector: string) => {
    const found = env.document.querySelector<T>(selector);
    assert.ok(found, selector);
    return found;
  };
  const until = async (selector: string) => {
    for (
      let attempt = 0;
      attempt < 40 && !env.document.querySelector(selector);
      attempt++
    )
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
      });
    return query(selector);
  };
  return { ...env, clean, app, render, query, until };
}

class FileReaderFixture {
  result = "";
  onload?: () => void;
  onerror?: () => void;
  readAsDataURL(blob: Blob) {
    void blob.arrayBuffer().then((data) => {
      this.result = `data:application/octet-stream;base64,${Buffer.from(data).toString("base64")}`;
      this.onload?.();
    });
  }
}
function reader(t: { after(fn: () => void): void }) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "FileReader");
  Object.defineProperty(globalThis, "FileReader", {
    configurable: true,
    writable: true,
    value: FileReaderFixture,
  });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, "FileReader", previous);
    else Reflect.deleteProperty(globalThis, "FileReader");
  });
}

test("Customize11: actual menu preserves source action order and omits unavailable callbacks", async (t) => {
  const env = await dom();
  t.after(env.clean);
  const selected: string[] = [];
  const entries = pluginAddMenu({
    onAddMarketplace: () => selected.push("add"),
    onManageMarketplaces: () => selected.push("manage"),
    onUpload: () => selected.push("upload"),
    onCreate: () => selected.push("create"),
    onCreateWithClaudex: () => selected.push("chat"),
  });
  const anchor = env.document.createElement("button");
  env.document.body.append(anchor);
  await env.render(
    h(PageMenu, {
      label: "Add plugin",
      entries,
      anchor: { current: anchor },
      width: 240,
      onClose() {},
    }),
  );
  assert.deepEqual(
    [...env.document.querySelectorAll('[role="menuitem"]')].map(
      (row) => row.lastElementChild?.textContent,
    ),
    [
      "Add marketplace",
      "Manage marketplaces",
      "Upload plugin",
      "Create a plugin",
      "Create with Claudex",
    ],
  );
  for (const row of env.document.querySelectorAll('[role="menuitem"]'))
    await env.event(row, "click");
  assert.deepEqual(selected, ["add", "manage", "upload", "create", "chat"]);
  assert.deepEqual(pluginAddMenu({}), []);
});

test("Customize12: create performs actual archive transfer and stays busy against duplicate submits/dismissal", async (t) => {
  reader(t);
  const finished = deferred<{ id: string; pluginId: string }>();
  const writes: string[] = [];
  let created = 0,
    closed = 0;
  const env = await dom({
    uploadPlugin: async (command) => {
      writes.push(command.action);
      return command.action === "finish" ? finished.promise : { id: "upload" };
    },
  });
  t.after(env.clean);
  await env.render(
    h(CreatePluginDialog, {
      onCreated: () => {
        created++;
      },
      onClose: () => {
        closed++;
      },
    }),
  );
  await env.change('input[maxlength="64"]', "Notes");
  await act(async () => {
    const editor = EditorView.findFromDOM(env.query(".cm-editor"));
    assert.ok(editor);
    editor.dispatch({
      changes: {
        from: 0,
        to: editor.state.doc.length,
        insert: "Follow the instructions",
      },
    });
  });
  await env.event(env.query("form"), "submit");
  for (let n = 0; n < 40 && !writes.includes("finish"); n++)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
  assert.deepEqual(writes, ["begin", "append", "finish"]);
  assert.equal(
    env.query<HTMLInputElement>('input[maxlength="64"]').disabled,
    true,
  );
  await env.event(env.query("form"), "submit");
  await env.event(env.document, "keydown", { key: "Escape" });
  assert.equal(closed, 0);
  assert.equal(writes.length, 3);
  await act(async () =>
    finished.resolve({ id: "upload", pluginId: "notes@personal" }),
  );
  assert.equal(created, 1);
  assert.equal(closed, 1);
});

for (const outcome of ["success", "failure"] as const)
  test(`Customize12: a ${outcome} from retired create cannot affect the replacement account`, async (t) => {
    reader(t);
    const finished = deferred<{ id: string; pluginId: string }>();
    let created = 0,
      closed = 0;
    const env = await dom({
      uploadPlugin: async (command) =>
        command.action === "finish" ? finished.promise : { id: "upload" },
    });
    t.after(env.clean);
    const view = () =>
      h(CreatePluginDialog, {
        onCreated: () => {
          created++;
        },
        onClose: () => {
          closed++;
        },
      });
    await env.render(view());
    await env.change('input[maxlength="64"]', "Private name");
    await env.event(env.query("form"), "submit");
    for (let n = 0; n < 20; n++)
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 3));
      });
    env.app.accountId = "B";
    await env.render(view());
    assert.equal(
      env.query<HTMLInputElement>('input[maxlength="64"]').value,
      "",
    );
    await act(async () => {
      outcome === "success"
        ? finished.resolve({ id: "upload", pluginId: "old@personal" })
        : finished.reject(new Error("Private failure"));
    });
    assert.equal(created, 0);
    assert.equal(closed, 0);
    assert.equal(env.document.querySelector('[role="alert"]'), null);
  });

test("Customize12: upload continuation and cancellation never cross an account/bridge replacement", async (t) => {
  reader(t);
  const started = deferred<{ id: string }>();
  const old: string[] = [],
    replacement: string[] = [];
  const env = await dom({
    uploadPlugin: async (command) => {
      old.push(command.action);
      return started.promise;
    },
  });
  t.after(env.clean);
  const bridge = (env.window as unknown as Window).desktop;
  let owned = true;
  const transfer = sendPluginArchive(
    new File(["zip"], "notes.plugin"),
    false,
    () => false,
    bridge,
    () => owned && (env.window as unknown as Window).desktop === bridge,
  );
  const rejected = assert.rejects(transfer, /no longer belongs/);
  owned = false;
  (env.window as unknown as Window).desktop = {
    uploadPlugin: async (command: PluginUploadCommand) => {
      replacement.push(command.action);
      return { id: "new" };
    },
  } as never;
  started.resolve({ id: "old-upload" });
  await rejected;
  assert.deepEqual(old, ["begin"]);
  assert.deepEqual(replacement, []);
});

test("Customize13: detail failure retries the real selected read and changing plugin retires old content", async (t) => {
  let reads = 0;
  const old = deferred<PluginDetails>();
  const env = await dom({
    readPlugin: async (id) => {
      reads++;
      if (id === "first@personal") return old.promise;
      if (reads === 2) throw new Error("Offline");
      return details("Current content");
    },
  });
  t.after(env.clean);
  const props = {
    plugins: state(),
    onClose() {},
    onError(error: unknown) {
      throw error;
    },
  };
  await env.render(
    h(PluginDetailDialog, { ...props, plugin: plugin("first@personal") }),
  );
  await env.render(
    h(PluginDetailDialog, { ...props, plugin: plugin("second@personal") }),
  );
  await env.until(".plugin-detail-read-failure button");
  await act(async () => old.resolve(details("Private previous content")));
  assert.doesNotMatch(
    env.document.body.textContent!,
    /Private previous content/,
  );
  await env.click(".plugin-detail-read-failure button");
  assert.match(env.document.body.textContent!, /Current content/);
  assert.equal(reads, 3);
});

test("Customize13/27: installed disabled plugin cannot Try and row Add-and-Try waits for actual install", async (t) => {
  const install = deferred<string[]>();
  const called: string[] = [];
  const env = await dom({ readPlugin: async () => details("Read") });
  t.after(env.clean);
  const plugins = {
    ...state(),
    install: async (id: string) => {
      called.push(id);
      return install.promise;
    },
  };
  await env.render(
    h(PluginDetailDialog, {
      plugin: { ...plugin(), enabled: false },
      plugins,
      onClose() {},
      onError() {},
      onTry: () => called.push("try"),
    }),
  );
  assert.equal(
    env.query<HTMLButtonElement>(".plugin-detail-actions .primary").disabled,
    true,
  );
  const entry = { ...plugin("new@public"), installed: false };
  await env.render(
    h(PluginRows, {
      entries: [entry],
      plugins,
      compactActions: true,
      onOpen() {},
      onError() {},
      onTry: () => called.push("try"),
    }),
  );
  const stylesheet = env.document.createElement("style");
  stylesheet.textContent = readFileSync(
    new URL("../../src/plugins/plugin-lifecycle.css", import.meta.url),
    "utf8",
  );
  env.document.head.append(stylesheet);
  const style = env.window.getComputedStyle(env.query(".plugin-row-try"));
  assert.equal(style.width, "60px");
  assert.equal(style.height, "28px");
  await env.click(".plugin-row-try");
  assert.deepEqual(called, [entry.id]);
  await act(async () => install.resolve([]));
  assert.deepEqual(called, [entry.id, "try"]);
});

test("Customize14: actual management empty state, populated sources, and Done remain functional", async (t) => {
  const env = await dom();
  t.after(env.clean);
  let closed = 0;
  const props = {
    onClose: () => {
      closed++;
    },
    onAdd() {},
    onError() {},
  };
  await env.render(h(ManageMarketplacesDialog, { ...props, plugins: state() }));
  assert.match(env.document.body.textContent!, /No marketplaces added yet/);
  await env.click(".button-row .primary");
  assert.equal(closed, 1);
  await env.render(
    h(ManageMarketplacesDialog, {
      ...props,
      plugins: state({
        plugins: [],
        loadErrors: [],
        marketplaces: [
          { name: "owned", path: "/owned", plugins: 0, source: "owner/repo" },
        ],
      }),
    }),
  );
  assert.match(env.document.body.textContent!, /owner\/repo/);
  await env.click(".button-row .primary");
  assert.equal(closed, 2);
});

test("plugin state never advertises rename/duplicate when the bridge does not implement them", async (t) => {
  const env = await dom({
    listPlugins: async () => ({
      plugins: [],
      marketplaces: [],
      loadErrors: [],
    }),
  });
  t.after(env.clean);
  let current!: PluginsState;
  function Probe() {
    current = usePlugins();
    return h("span", null, "Plugins");
  }
  await env.render(h(Probe));
  assert.equal(current.rename, undefined);
  assert.equal(current.duplicate, undefined);
});

for (const services of [[], ["GitHub"]])
  test(`Customize27: runtime ID Try ${services.length ? "waits for authentication" : "passes through PluginsBody after install"}`, async (t) => {
    const installation = deferred<string[]>();
    const used: string[] = [];
    const env = await dom();
    t.after(env.clean);
    const entry = {
      ...plugin("actual-id@runtime-market"),
      name: "unrelated-visible-name",
      installed: false,
    };
    const plugins = {
      ...state({
        plugins: [entry],
        marketplaces: [{ name: "runtime-market", path: "/market", plugins: 1 }],
        loadErrors: [],
      }),
      install: async () => installation.promise,
    };
    await env.render(
      h(PluginsBody, {
        customize: true,
        view: "discover",
        filter: {},
        plugins,
        onOpen() {},
        onAddMarketplace() {},
        onDiscover() {},
        onError(error: unknown) {
          throw error;
        },
        onUsePlugin: (id) => used.push(id),
      }),
    );
    await env.click(".customize-catalogue-try");
    assert.deepEqual(used, []);
    await act(async () => installation.resolve(services));
    assert.deepEqual(used, services.length ? [] : [entry.id]);
  });

test("Customize13: detail Try passes the installed runtime ID and does not fall back to the legacy name callback", async (t) => {
  const env = await dom({ readPlugin: async () => details("Actual details") });
  t.after(env.clean);
  const used: string[] = [],
    legacy: string[] = [];
  const entry = { ...plugin("runtime-id@market"), name: "visible-name" };
  await env.render(
    h(PluginDetailDialog, {
      plugin: entry,
      plugins: state(),
      onClose() {},
      onError() {},
      onUsePlugin: (id) => used.push(id),
      onTry: (value) => legacy.push(value.name),
    }),
  );
  await env.click(".plugin-detail-actions .primary");
  assert.deepEqual(used, [entry.id]);
  assert.deepEqual(legacy, []);
});

test("Customize12: missing final plugin identity never reports successful creation", async (t) => {
  reader(t);
  let created = 0,
    closed = 0;
  const env = await dom({ uploadPlugin: async () => ({ id: "unconfirmed" }) });
  t.after(env.clean);
  await env.render(
    h(CreatePluginDialog, {
      onCreated: () => {
        created++;
      },
      onClose: () => {
        closed++;
      },
    }),
  );
  await env.change('input[maxlength="64"]', "Notes");
  await env.event(env.query("form"), "submit");
  await env.until('[role="alert"]');
  assert.equal(created, 0);
  assert.equal(closed, 0);
  assert.match(env.document.body.textContent!, /No plugins were added/);
});

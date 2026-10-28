import assert from "node:assert/strict";
import test from "node:test";
import { act, createElement as h } from "react";
import {
  AppContext,
  type AppController,
  type NewChatDraft,
} from "../../src/app/AppContext";
import { HostContext } from "../../src/host/HostContext";
import { desktopHost, webHost } from "../../shared/host";
import type { PluginCatalog, PluginEntry } from "../../shared/collections-api";
import { defaultSettings } from "../../electron/store/store";
import { CustomizeRoute } from "../../src/app/CollectionPages";
import { PluginsTab } from "../../src/settings/tabs/Plugins";
import {
  useTryPluginChat,
  pluginChatPrompt,
} from "../../src/plugins/try-plugin-chat";
import { formatText } from "../../src/i18n";
import { routineDom } from "../support/routine-dom";

const plugin = (id = "notes@personal"): PluginEntry => ({
  id,
  name: id.split("@")[0],
  title: `Actual ${id}`,
  marketplace: "personal",
  marketplacePath: "/marketplace.json",
  installed: true,
  enabled: true,
  installable: true,
  source: "local",
  personal: true,
});
const catalog = (...plugins: PluginEntry[]): PluginCatalog => ({
  plugins,
  marketplaces: [],
  loadErrors: [],
});
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
async function setup(bridge: Partial<Window["desktop"]> = {}) {
  const sends: unknown[] = [],
    errors: unknown[] = [],
    starts: unknown[][] = [];
  const seeded: string[] = [],
    tokenWrites: unknown[] = [],
    attachmentWrites: unknown[] = [];
  const settingsWrites: boolean[] = [],
    receipts: ((created?: NewChatDraft) => void)[] = [];
  const env = await routineDom(
    {
      listPlugins: async () => catalog(plugin()),
      readPlugin: async () => ({
        description: "Actual runtime detail",
        skills: [],
        apps: [],
        mcpServers: [],
        hooks: 0,
      }),
      customizeSkills: async () => [],
      listApprovedDirectory: async () => [],
      mcpServers: async () => ({ servers: [] }),
      linearStatus: async () => ({ connected: false }),
      send: async (...args: unknown[]) => {
        sends.push(args);
        return undefined as never;
      },
      ...bridge,
    } as never,
    { jsdom: true },
  );
  const globals = {
    innerWidth: 1440,
    innerHeight: 900,
    addEventListener: env.window.addEventListener.bind(env.window),
    removeEventListener: env.window.removeEventListener.bind(env.window),
    location: env.window.location,
    history: env.window.history,
  };
  const saved = new Map(
    Object.keys(globals).map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, value });
  const config = { autoReceipt: true };
  const app = {
    accountId: "A",
    controllerScope: {},
    currentController: { current: undefined },
    page: "customize",
    draftSession: "old-draft",
    activeId: "old-chat",
    mode: "chat",
    settingsOpen: false,
    snapshot: { settings: defaultSettings, projects: [], conversations: [] },
    newChat: (...args: unknown[]) => {
      starts.push(args.slice(0, 3));
      const receipt = args[3] as (draft?: NewChatDraft) => void;
      receipts.push(receipt);
      if (config.autoReceipt)
        receipt({ draftSession: `created-${starts.length}`, mode: "chat" });
    },
    setText: (text: string) => seeded.push(text),
    setSkillTokens: (tokens: unknown) => tokenWrites.push(tokens),
    setAttachments: (attachments: unknown) =>
      attachmentWrites.push(attachments),
    setSettingsOpen: (open: boolean) => settingsWrites.push(open),
    report: (error: unknown) => errors.push(error),
    openSettingsTab() {},
    setConfirm() {},
  } as unknown as AppController;
  const render = (child: ReturnType<typeof h>, web = false) => {
    app.currentController!.current = app;
    return env.render(
      h(
        AppContext.Provider,
        { value: app },
        h(HostContext.Provider, { value: web ? webHost : desktopHost }, child),
      ),
    );
  };
  const query = <T extends Element = HTMLElement>(selector: string) => {
    const node = env.document.querySelector<T>(selector);
    assert.ok(node, selector);
    return node;
  };
  const until = async (selector: string) => {
    for (
      let attempt = 0;
      attempt < 100 && !env.document.querySelector(selector);
      attempt++
    )
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
      });
    return query(selector);
  };
  const clean = async () => {
    await env.clean();
    for (const [key, value] of saved) {
      if (value) Object.defineProperty(globalThis, key, value);
      else Reflect.deleteProperty(globalThis, key);
    }
  };
  return {
    ...env,
    clean,
    app,
    config,
    render,
    query,
    until,
    sends,
    errors,
    starts,
    seeded,
    tokenWrites,
    attachmentWrites,
    settingsWrites,
    receipts,
  };
}
function Probe({
  id = "notes@personal",
  routeKey,
}: {
  id?: string;
  routeKey?: string;
}) {
  const tryPlugin = useTryPluginChat({ routeKey });
  return h("button", { onClick: () => void tryPlugin?.(id) }, "Try plugin");
}

test("actual Customize route Try verifies the runtime and seeds only the generic new-chat draft", async (t) => {
  let reads = 0;
  const actual = { ...plugin(), title: "Settings {pluginName} <原稿>" };
  const env = await setup({
    listPlugins: async () => {
      reads++;
      return catalog(actual);
    },
  });
  t.after(env.clean);
  env.window.history.replaceState(
    null,
    "",
    `/customize/plugins/yours/id/${encodeURIComponent(actual.id)}`,
  );
  await env.render(h(CustomizeRoute), true);
  await env.until(".plugin-detail-actions .primary");
  assert.equal(
    env.query<HTMLButtonElement>(".plugin-detail-actions .primary").disabled,
    false,
  );
  const before = reads;
  await env.click(".plugin-detail-actions .primary");
  assert.ok(reads > before, "Try verifies a fresh listing");
  assert.deepEqual(env.starts, [["chat", undefined, false]]);
  assert.deepEqual(env.seeded, [
    formatText(pluginChatPrompt, { pluginName: actual.title }),
  ]);
  assert.deepEqual(env.tokenWrites, [[]]);
  assert.deepEqual(env.attachmentWrites, [[]]);
  assert.deepEqual(env.sends, []);
  assert.deepEqual(env.errors, []);
});

test("actual Settings plugin detail uses the same verified draft handoff and closes Settings", async (t) => {
  const env = await setup();
  t.after(env.clean);
  env.app.settingsOpen = true;
  await env.render(h(PluginsTab, { onError: env.app.report }));
  await env.click(".plugin-rows > li > button");
  await env.until(".plugin-detail-actions .primary");
  await env.click(".plugin-detail-actions .primary");
  assert.deepEqual(env.starts, [["chat", undefined, false]]);
  assert.deepEqual(env.seeded, [
    formatText(pluginChatPrompt, { pluginName: plugin().title }),
  ]);
  assert.deepEqual(env.settingsWrites, [false]);
  assert.deepEqual(env.sends, []);
  assert.deepEqual(env.errors, []);
});

for (const auth of [false, true])
  test(`actual Customize Add-and-try ${auth ? "waits for app authentication" : "installs before fresh enabled verification"}`, async (t) => {
    let installed = false;
    const calls: string[] = [];
    const data = {
      ...plugin("data@knowledge-work-plugins"),
      title: "Data",
      installed: false,
      marketplace: "knowledge-work-plugins",
      category: "data",
    };
    const env = await setup({
      listPlugins: async () => {
        calls.push(`list:${installed}`);
        return {
          ...catalog({ ...data, installed }),
          marketplaces: [
            { name: "knowledge-work-plugins", path: "/m", plugins: 1 },
          ],
        };
      },
      installPlugin: async (id: string) => {
        calls.push(`install:${id}`);
        installed = true;
        return { appsNeedingAuth: auth ? ["Sheets"] : [] };
      },
    });
    t.after(env.clean);
    env.window.history.replaceState(null, "", "/customize/skills/discover");
    await env.render(h(CustomizeRoute), true);
    // Data is Discover's feature; its category lists it as a row with Try.
    const category = [
      ...env.document.querySelectorAll(".plugin-discovery-categories button"),
    ].find((button) => button.textContent?.startsWith("Data"));
    assert.ok(category);
    await env.event(category, "click");
    await env.click('[aria-label="Add Data and try it in chat"]');
    assert.ok(calls.includes(`install:${data.id}`));
    if (auth) {
      // Added; the toast asks for the apps' sign-in before any chat.
      assert.deepEqual(env.starts, []);
      assert.deepEqual(env.errors, []);
    } else {
      assert.ok(
        calls.filter((call) => call === "list:true").length >= 2,
        "install refresh and Try verification both read runtime state",
      );
      assert.deepEqual(env.seeded, [
        formatText(pluginChatPrompt, { pluginName: "Data" }),
      ]);
    }
    assert.deepEqual(env.sends, []);
  });

for (const retired of [
  "account",
  "bridge",
  "controller",
  "cleared-controller",
  "page",
  "active-chat",
  "draft",
  "url",
  "unmount",
  "selection",
] as const)
  test(`pending Try cannot navigate or report across ${retired} retirement`, async (t) => {
    const pending = deferred<PluginCatalog>();
    const env = await setup({ listPlugins: () => pending.promise });
    t.after(env.clean);
    await env.render(h(Probe, { routeKey: "first" }));
    await env.click("button");
    if (retired === "account") env.app.accountId = "B";
    if (retired === "bridge") env.window.desktop = { ...env.window.desktop };
    if (retired === "controller") env.app.controllerScope = {};
    if (retired === "cleared-controller")
      env.app.currentController!.current = undefined;
    if (retired === "page") env.app.page = "projects";
    if (retired === "active-chat") env.app.activeId = "different";
    if (retired === "draft") env.app.draftSession = "different";
    if (retired === "url")
      env.window.history.replaceState(null, "", "/another-route");
    if (retired === "unmount") await env.render(h("div", null, "Replacement"));
    if (retired === "selection")
      await env.render(h(Probe, { routeKey: "second" }));
    await act(async () => pending.resolve(catalog(plugin())));
    assert.deepEqual(env.starts, []);
    assert.deepEqual(env.seeded, []);
    assert.deepEqual(env.errors, []);
    assert.deepEqual(env.sends, []);
  });

for (const unavailable of [
  "disabled",
  "uninstalled",
  "missing",
  "malformed",
  "rejected",
  "unsupported",
] as const)
  test(`unverified runtime ${unavailable} produces an honest refusal without starting Chat`, async (t) => {
    const env = await setup({
      listPlugins: async () => {
        if (unavailable === "rejected") throw new Error("Runtime offline");
        if (unavailable === "malformed") return {} as PluginCatalog;
        if (unavailable === "missing") return catalog();
        return catalog({
          ...plugin(),
          enabled: unavailable !== "disabled",
          installed: unavailable !== "uninstalled",
        });
      },
    });
    t.after(env.clean);
    if (unavailable === "unsupported")
      delete (env.window.desktop as Partial<Window["desktop"]>).listPlugins;
    await env.render(h(Probe));
    await env.click("button");
    assert.deepEqual(env.starts, []);
    assert.deepEqual(env.seeded, []);
    assert.equal(env.errors.length, 1);
    assert.deepEqual(env.sends, []);
  });

test("only the latest Try request may seed a new draft", async (t) => {
  const first = deferred<PluginCatalog>(),
    second = deferred<PluginCatalog>();
  let count = 0;
  const env = await setup({
    listPlugins: () => (++count === 1 ? first.promise : second.promise),
  });
  t.after(env.clean);
  await env.render(
    h(
      "div",
      null,
      h(Probe, { id: "first@personal" }),
      h(Probe, { id: "second@personal" }),
    ),
  );
  const buttons = env.document.querySelectorAll("button");
  await env.event(buttons[0], "click");
  await env.event(buttons[1], "click");
  await act(async () => first.resolve(catalog(plugin("first@personal"))));
  assert.deepEqual(env.starts, []);
  await act(async () => second.resolve(catalog(plugin("second@personal"))));
  assert.deepEqual(env.seeded, [
    formatText(pluginChatPrompt, { pluginName: "Actual second@personal" }),
  ]);
});

for (const retired of [
  "account",
  "controller",
  "bridge",
  "page",
  "unmount",
] as const)
  test(`a deferred newChat receipt cannot write a prompt after ${retired} retirement`, async (t) => {
    const env = await setup();
    t.after(env.clean);
    env.config.autoReceipt = false;
    await env.render(h(Probe));
    await env.click("button");
    assert.equal(env.receipts.length, 1);
    assert.deepEqual(env.seeded, []);
    if (retired === "account") env.app.accountId = "B";
    if (retired === "controller")
      env.app.currentController!.current = undefined;
    if (retired === "bridge") env.window.desktop = { ...env.window.desktop };
    if (retired === "page") env.app.page = "projects";
    if (retired === "unmount") {
      env.app.page = "projects";
      await env.render(h("div"));
    }
    await act(async () =>
      env.receipts[0]({ draftSession: "created", mode: "chat" }),
    );
    assert.deepEqual(env.seeded, []);
    assert.deepEqual(env.tokenWrites, []);
    assert.deepEqual(env.attachmentWrites, []);
  });

test("missing or Code receipts do not seed; a valid receipt is consumed only once", async (t) => {
  const env = await setup();
  t.after(env.clean);
  env.config.autoReceipt = false;
  await env.render(h(Probe));
  await env.click("button");
  const accept = env.receipts[0];
  await act(async () => {
    accept();
    accept({ draftSession: "code", mode: "code" });
    accept({ draftSession: "unknown-mode" } as NewChatDraft);
  });
  assert.deepEqual(env.seeded, []);
  await act(async () => {
    accept({ draftSession: "created", mode: "chat" });
    accept({ draftSession: "created", mode: "chat" });
  });
  assert.equal(env.seeded.length, 1);
  assert.deepEqual(env.sends, []);
});

test("returning to the same selection cannot revive its earlier pending Try", async (t) => {
  const pending = deferred<PluginCatalog>();
  const env = await setup({ listPlugins: () => pending.promise });
  t.after(env.clean);
  await env.render(h(Probe, { routeKey: "first" }));
  await env.click("button");
  await env.render(h(Probe, { routeKey: "second" }));
  await env.render(h(Probe, { routeKey: "first" }));
  await act(async () => pending.resolve(catalog(plugin())));
  assert.deepEqual(env.starts, []);
  assert.deepEqual(env.errors, []);
});

test("actual Settings detail close retires pending Try even if the same detail is reopened", async (t) => {
  const pending = deferred<PluginCatalog>();
  let verify = false;
  const env = await setup({
    listPlugins: async () => (verify ? pending.promise : catalog(plugin())),
  });
  t.after(env.clean);
  env.app.settingsOpen = true;
  await env.render(h(PluginsTab, { onError: env.app.report }));
  await env.click(".plugin-rows > li > button");
  await env.until(".plugin-detail-actions .primary");
  verify = true;
  await env.click(".plugin-detail-actions .primary");
  const dialog = env.query('[role="dialog"]');
  const close = dialog.querySelector('[aria-label="Close"]');
  assert.ok(close);
  await env.event(close, "click");
  await env.click(".plugin-rows > li > button");
  await env.until(".plugin-detail-actions .primary");
  await act(async () => pending.resolve(catalog(plugin())));
  assert.deepEqual(env.starts, []);
  assert.deepEqual(env.seeded, []);
  assert.deepEqual(env.errors, []);
});

test("an accepted newChat receipt survives its own leaf unmount and seeds only its exact new draft", async (t) => {
  const env = await setup();
  t.after(env.clean);
  env.config.autoReceipt = false;
  await env.render(h(Probe));
  await env.click("button");
  env.app.page = "chat";
  env.app.activeId = undefined;
  env.app.draftSession = "created-by-try";
  await env.render(h("div", null, "New chat composer"));
  await act(async () =>
    env.receipts[0]({ draftSession: "different-draft", mode: "chat" }),
  );
  assert.deepEqual(env.seeded, []);
  await act(async () =>
    env.receipts[0]({ draftSession: "created-by-try", mode: "chat" }),
  );
  assert.deepEqual(env.seeded, [
    formatText(pluginChatPrompt, { pluginName: plugin().title }),
  ]);
  assert.deepEqual(env.sends, []);
});

test("actual native Customize detail close during live verification cannot later start Chat", async (t) => {
  const pending = deferred<PluginCatalog>();
  let verify = false;
  const env = await setup({
    listPlugins: async () => (verify ? pending.promise : catalog(plugin())),
  });
  t.after(env.clean);
  await env.render(h(CustomizeRoute));
  const plugins = [
    ...env.document.querySelectorAll(".customize-nav button"),
  ].find((button) => button.textContent?.trim() === "Plugins");
  assert.ok(plugins);
  await env.event(plugins, "click");
  const yours = [...env.document.querySelectorAll('[role="radio"]')].find(
    (button) => button.textContent?.trim() === "Yours",
  );
  assert.ok(yours);
  await env.event(yours, "click");
  await env.until(".plugin-rows > li > button");
  await env.click(".plugin-rows > li > button");
  await env.until(".plugin-detail-actions .primary");
  verify = true;
  await env.click(".plugin-detail-actions .primary");
  const close = env.query('[role="dialog"] [aria-label="Close"]');
  await env.event(close, "click");
  await act(async () => pending.resolve(catalog(plugin())));
  assert.deepEqual(env.starts, []);
  assert.deepEqual(env.seeded, []);
  assert.deepEqual(env.errors, []);
});

test("a newer Try retires an older accepted navigation receipt", async (t) => {
  const env = await setup();
  t.after(env.clean);
  env.config.autoReceipt = false;
  await env.render(h(Probe));
  await env.click("button");
  await env.click("button");
  assert.equal(env.receipts.length, 2);
  await act(async () =>
    env.receipts[0]({ draftSession: "older", mode: "chat" }),
  );
  assert.deepEqual(env.seeded, []);
  await act(async () =>
    env.receipts[1]({ draftSession: "newer", mode: "cowork" }),
  );
  assert.equal(env.seeded.length, 1);
  assert.deepEqual(env.starts, [
    ["chat", undefined, false],
    ["chat", undefined, false],
  ]);
  assert.deepEqual(env.sends, []);
});

test("a runtime failure after caller selection retirement is not reported into the new selection", async (t) => {
  const pending = deferred<PluginCatalog>();
  const env = await setup({ listPlugins: () => pending.promise });
  t.after(env.clean);
  await env.render(h(Probe, { routeKey: "old" }));
  await env.click("button");
  await env.render(h(Probe, { routeKey: "new" }));
  await act(async () => pending.reject(new Error("Old runtime unavailable")));
  assert.deepEqual(env.errors, []);
  assert.deepEqual(env.starts, []);
});

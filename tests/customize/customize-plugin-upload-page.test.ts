import test from "node:test";
import assert from "node:assert/strict";
import { act, createElement as h, useEffect, useState } from "react";
import { routineDom } from "../support/routine-dom";
import { PluginUploadPage } from "../../src/plugins/PluginUploadPage";
import { PluginUploadDialog } from "../../src/plugins/PluginUploadDialog";
import { sendPluginArchive } from "../../src/plugins/plugin-archive";
import { CustomizePage } from "../../src/collections/customize/CustomizePage";
import { AppContext } from "../../src/app/AppContext";
import { defaultSettings } from "../../electron/store/store";
import {
  customizePath,
  parseCustomizePath,
} from "../../src/web/customize-route";
import { parseWebRoute, formatWebRoute } from "../../src/web/routes";
import type { PluginUploadCommand } from "../../shared/plugin-upload";
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
async function environment(api: object = {}) {
  const dom = await routineDom(
    {
      customizeSkills: async () => [],
      mcpServers: async () => ({ servers: [] }),
      listPlugins: async () => ({
        plugins: [],
        marketplaces: [],
        loadErrors: [],
      }),
      listApprovedDirectory: async () => [],
      linearStatus: async () => ({ connected: false }),
      ...api,
    } as never,
    { jsdom: true },
  );
  const values = {
    FileReader: class {
      result = "";
      onload?: () => void;
      onerror?: () => void;
      readAsDataURL(blob: Blob) {
        void blob.arrayBuffer().then((bytes) => {
          this.result = `data:application/octet-stream;base64,${Buffer.from(bytes).toString("base64")}`;
          this.onload?.();
        });
      }
    },
    innerWidth: 1280,
    innerHeight: 720,
  };
  const saved = new Map(
    Object.keys(values).map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  for (const [key, value] of Object.entries(values))
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value,
    });
  return {
    ...dom,
    async pick(files: File[]) {
      const input =
        dom.document.querySelector<HTMLInputElement>('input[type="file"]')!;
      Object.defineProperty(input, "files", {
        configurable: true,
        value: files,
      });
      await dom.event(input, "change");
    },
    async clean() {
      await dom.clean();
      for (const [key, value] of saved) {
        if (value) Object.defineProperty(globalThis, key, value);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}
test("typed upload address round-trips through the actual web route and rejects other upload shapes", () => {
  const address = "/customize/plugins/new/upload";
  const place = parseCustomizePath(address)!;
  assert.deepEqual(place, {
    section: "plugins",
    view: "yours",
    pluginPage: "upload",
  });
  assert.equal(customizePath(place), address);
  const route = parseWebRoute(address, "");
  assert.equal(route.kind, "page");
  assert.equal(formatWebRoute(route), address);
  for (const invalid of [
    "/customize/skills/new/upload",
    "/customize/connectors/new/upload",
    "/customize/plugins/new/upload/contents",
    "/customize/plugins/new/other",
  ])
    assert.equal(parseCustomizePath(invalid), undefined);
});
test("Customize Upload menu navigates to a page; deep-link Back and Cancel return to the real Plugins address", async () => {
  const env = await environment();
  const changes: ReturnType<typeof parseCustomizePath>[] = [];
  const props = {
    settings: defaultSettings,
    onUseSkill() {},
    onOpenSettings() {},
    onConfirmRemove() {},
    onError(error: unknown) {
      throw error;
    },
    onRouteChange: (
      place: NonNullable<ReturnType<typeof parseCustomizePath>>,
    ) => changes.push(place),
  };
  try {
    await env.render(
      h(CustomizePage, {
        ...props,
        route: { section: "plugins", view: "discover" },
      }),
    );
    await env.click('[aria-label="Add plugin"]');
    const upload = [...env.document.querySelectorAll('[role="menuitem"]')].find(
      (el) => el.lastElementChild?.textContent?.trim() === "Upload plugin",
    )!;
    assert.ok(
      upload,
      [...env.document.querySelectorAll('[role="menuitem"]')]
        .map((el) => JSON.stringify(el.textContent))
        .join(" / "),
    );
    await env.event(upload, "click");
    assert.equal(
      customizePath(changes.at(-1)!),
      "/customize/plugins/new/upload",
    );
    await env.render(
      h(CustomizePage, {
        ...props,
        route: parseCustomizePath("/customize/plugins/new/upload"),
      }),
    );
    assert.ok(env.document.querySelector(".plugin-upload-page"));
    assert.equal(
      env.document.querySelector(".plugin-upload-label h3")?.textContent,
      "Plugin file",
    );
    assert.equal(env.document.querySelector('[role="dialog"]'), null);
    assert.equal(
      env.document.querySelector(".plugin-upload-back")?.getAttribute("href"),
      "/customize/plugins",
    );
    await env.click(".plugin-upload-back");
    assert.equal(customizePath(changes.at(-1)!), "/customize/plugins");
    await env.render(h(CustomizePage, { ...props, route: changes.at(-1)! }));
    assert.equal(env.document.querySelector(".plugin-upload-page"), null);
    await env.render(
      h(CustomizePage, {
        ...props,
        route: parseCustomizePath("/customize/plugins/new/upload"),
      }),
    );
    await env.click(".plugin-upload-page .button-row .secondary");
    assert.equal(customizePath(changes.at(-1)!), "/customize/plugins");
  } finally {
    await env.clean();
  }
});
test("the page only displays manifest guidance; rejected archives show the actual limit while Settings retains its dialog rules", async () => {
  const env = await environment();
  try {
    await env.render(h(PluginUploadPage, { onBack() {}, onUploaded() {} }));
    assert.match(
      env.document.body.textContent!,
      /\.claude-plugin\/plugin.json manifest/,
    );
    assert.doesNotMatch(env.document.body.textContent!, /200 MB|Security scan/);
    assert.ok(
      env.document.querySelector('.plugin-upload-warning[role="note"]'),
    );
    assert.equal(env.document.querySelector('[role="alert"]'), null);
    assert.equal(
      env.document.querySelector<HTMLInputElement>('input[type="file"]')
        ?.multiple,
      true,
    );
    await env.pick([new File(["text"], "wrong.txt")]);
    assert.match(
      env.document.querySelector('[role="alert"]')?.textContent ?? "",
      /Only .zip or .plugin files under 200 MB/,
    );
    await env.render(h(PluginUploadDialog, { onClose() {}, onUploaded() {} }));
    assert.ok(env.document.querySelector('[role="dialog"]'));
    assert.match(
      env.document.body.textContent!,
      /Only .zip or .plugin files under 200 MB/,
    );
  } finally {
    await env.clean();
  }
});
test("mounted multi-file transfer retries real failed staging and only closes after every receipt", async () => {
  const calls: PluginUploadCommand[] = [];
  let attempts = 0,
    closed = 0,
    uploaded = 0;
  const env = await environment({
    uploadPlugin: async (command: PluginUploadCommand) => {
      calls.push(command);
      if (command.action === "begin") return { id: `upload-${++attempts}` };
      if (command.action === "finish" && attempts === 2)
        throw Error("Synthetic upload failure");
      return command.action === "finish"
        ? { id: command.id, pluginId: `notes-${attempts}@personal` }
        : { id: "staging" };
    },
  });
  try {
    await env.render(
      h(PluginUploadPage, {
        onBack: () => {
          closed++;
        },
        onUploaded: () => {
          uploaded++;
        },
      }),
    );
    await env.pick([
      new File(["first"], "first.zip"),
      new File(["second"], "second.plugin"),
    ]);
    assert.equal(
      env.document.querySelector("h2")?.textContent,
      "Upload plugins",
    );
    await env.click(".button-row .primary");
    assert.equal(closed, 0);
    assert.equal(uploaded, 1);
    assert.match(env.document.body.textContent!, /Synthetic upload failure/);
    assert.equal(calls.filter((row) => row.action === "cancel").length, 1);
    await env.click(".button-row .primary");
    assert.equal(closed, 1);
    assert.equal(uploaded, 2);
    assert.equal(calls.filter((row) => row.action === "begin").length, 3);
    assert.equal(calls.filter((row) => row.action === "append").length, 3);
  } finally {
    await env.clean();
  }
});
test("Back retires a pending begin, cancels its own staging session and never appends afterwards", async () => {
  const begin = deferred<{ id: string }>();
  const entered = deferred<void>();
  const cancelled = deferred<void>();
  const calls: string[] = [];
  const env = await environment({
    uploadPlugin: async (command: PluginUploadCommand) => {
      calls.push(command.action);
      if (command.action === "begin") {
        entered.resolve();
        return begin.promise;
      }
      if (command.action === "cancel") cancelled.resolve();
      return { id: "old" };
    },
  });
  try {
    let back = false;
    const render = () =>
      env.render(
        back
          ? h("p", null, "Plugins")
          : h(PluginUploadPage, {
              onBack: () => {
                back = true;
              },
              onUploaded() {
                throw Error("Retired upload cannot publish");
              },
            }),
      );
    await render();
    await env.pick([new File(["archive"], "notes.zip")]);
    await env.click(".button-row .primary");
    await entered.promise;
    await env.click(".plugin-upload-back");
    await render();
    await act(async () => begin.resolve({ id: "old" }));
    await cancelled.promise;
    assert.deepEqual(calls, ["begin", "cancel"]);
  } finally {
    await env.clean();
  }
});
for (const outcome of ["success", "failure"] as const)
  test(`late ${outcome} cannot publish or cancel through another account`, async () => {
    const finish = deferred<{ id: string; pluginId: string }>();
    const entered = deferred<void>();
    const old: string[] = [],
      replacement: string[] = [];
    let uploaded = 0,
      back = 0;
    const env = await environment({
      uploadPlugin: async (command: PluginUploadCommand) => {
        old.push(command.action);
        if (command.action === "finish") {
          entered.resolve();
          return finish.promise;
        }
        return { id: "old" };
      },
    });
    let accountId = "a";
    const controller = { current: { accountId, controllerScope: {} } };
    const render = () =>
      env.render(
        h(
          AppContext.Provider,
          {
            value: {
              accountId,
              controllerScope: controller.current.controllerScope,
              currentController: controller,
            } as never,
          },
          h(PluginUploadPage, {
            onBack: () => {
              back++;
            },
            onUploaded: () => {
              uploaded++;
            },
          }),
        ),
      );
    try {
      await render();
      await env.pick([new File(["archive"], "notes.zip")]);
      await env.click(".button-row .primary");
      await entered.promise;
      accountId = "b";
      controller.current = { accountId, controllerScope: {} };
      env.window.desktop = {
        ...env.window.desktop,
        uploadPlugin: async (command: PluginUploadCommand) => {
          replacement.push(command.action);
          return { id: "new" };
        },
      } as never;
      await render();
      await act(async () => {
        outcome === "success"
          ? finish.resolve({ id: "old", pluginId: "notes@personal" })
          : finish.reject(Error("Private retired error"));
      });
      assert.equal(uploaded, 0);
      assert.equal(back, 0);
      assert.equal(env.document.querySelector('[role="alert"]'), null);
      assert.deepEqual(replacement, []);
      assert.deepEqual(old, ["begin", "append", "finish"]);
      assert.equal(env.document.querySelector(".plugin-upload-files"), null);
    } finally {
      await env.clean();
    }
  });

test("a same-owner finish receipt stays authoritative when Back wins the response race", async () => {
  const finish = deferred<{ id: string; pluginId: string }>(),
    entered = deferred<void>();
  const commands: string[] = [];
  let stopped = false;
  const env = await environment({
    uploadPlugin: async (command: PluginUploadCommand) => {
      commands.push(command.action);
      if (command.action === "finish") {
        entered.resolve();
        return finish.promise;
      }
      return { id: "staging" };
    },
  });
  try {
    const result = sendPluginArchive(
      new File(["zip"], "notes.zip"),
      false,
      () => stopped,
      env.window.desktop,
    );
    await entered.promise;
    stopped = true;
    finish.resolve({ id: "staging", pluginId: "notes@personal" });
    assert.equal((await result).pluginId, "notes@personal");
    assert.deepEqual(commands, ["begin", "append", "finish"]);
  } finally {
    await env.clean();
  }
});
test("browser history restores the actual upload deep link after Back and retires it again on Cancel", async () => {
  const env = await environment();
  env.window.history.replaceState({}, "", "/customize/plugins/new/upload");
  function Routed() {
    const [route, setRoute] = useState(() =>
      parseCustomizePath(env.window.location.pathname)!,
    );
    useEffect(() => {
      const read = () =>
        setRoute(parseCustomizePath(env.window.location.pathname)!);
      env.window.addEventListener("popstate", read);
      return () => env.window.removeEventListener("popstate", read);
    }, []);
    return h(CustomizePage, {
      settings: defaultSettings,
      route,
      onUseSkill() {},
      onOpenSettings() {},
      onConfirmRemove() {},
      onError(error) {
        throw error;
      },
      onRouteChange(next) {
        env.window.history.pushState({}, "", customizePath(next));
        setRoute(next);
      },
    });
  }
  try {
    await env.render(h(Routed));
    assert.ok(env.document.querySelector(".plugin-upload-page"));
    await env.click(".plugin-upload-back");
    assert.equal(env.window.location.pathname, "/customize/plugins/yours");
    assert.equal(env.document.querySelector(".plugin-upload-page"), null);
    await act(async () => {
      const changed = new Promise<void>((resolve) =>
        env.window.addEventListener("popstate", () => resolve(), {
          once: true,
        }),
      );
      env.window.history.back();
      await changed;
    });
    assert.equal(env.window.location.pathname, "/customize/plugins/new/upload");
    assert.ok(env.document.querySelector(".plugin-upload-page"));
    await env.click(".plugin-upload-page .button-row .secondary");
    assert.equal(env.window.location.pathname, "/customize/plugins/yours");
    assert.equal(env.document.querySelector(".plugin-upload-page"), null);
  } finally {
    await env.clean();
  }
});

test("upload opened from Yours preserves its real list return context and label", async () => {
  const env = await environment();
  let place = { section: "plugins", view: "yours" } as NonNullable<
    ReturnType<typeof parseCustomizePath>
  >;
  const render = () =>
    env.render(
      h(CustomizePage, {
        settings: defaultSettings,
        route: place,
        onRouteChange(next) {
          place = next;
        },
        onUseSkill() {},
        onOpenSettings() {},
        onConfirmRemove() {},
        onError(error) {
          throw error;
        },
      }),
    );
  try {
    await render();
    await env.click('[aria-label="Add plugin"]');
    const upload = [...env.document.querySelectorAll('[role="menuitem"]')].find(
      (el) => el.lastElementChild?.textContent?.trim() === "Upload plugin",
    )!;
    await env.event(upload, "click");
    await render();
    assert.equal(
      env.document.querySelector(".plugin-upload-back")?.textContent,
      "Your plugins",
    );
    assert.equal(
      env.document.querySelector(".plugin-upload-back")?.getAttribute("href"),
      "/customize/plugins/yours",
    );
    await env.click(".plugin-upload-back");
    assert.equal(customizePath(place), "/customize/plugins/yours");
  } finally {
    await env.clean();
  }
});

test("a late confirmed page commit refreshes its surviving account-owned list without navigating", async () => {
  const finish = deferred<{ id: string; pluginId: string }>(),
    entered = deferred<void>(),
    refreshed = deferred<void>();
  const calls: string[] = [];
  let closed = false,
    refreshes = 0;
  const env = await environment({
    uploadPlugin: async (command: PluginUploadCommand) => {
      calls.push(command.action);
      if (command.action === "finish") {
        entered.resolve();
        return finish.promise;
      }
      return { id: "staging" };
    },
  });
  const render = () =>
    env.render(
      closed
        ? h("p", null, "Your plugins")
        : h(PluginUploadPage, {
            onBack() {
              closed = true;
            },
            onUploaded() {
              refreshes++;
              refreshed.resolve();
            },
          }),
    );
  try {
    await render();
    await env.pick([new File(["archive"], "notes.zip")]);
    await env.click(".button-row .primary");
    await entered.promise;
    await env.click(".plugin-upload-back");
    await render();
    await act(async () =>
      finish.resolve({ id: "staging", pluginId: "notes@personal" }),
    );
    await refreshed.promise;
    assert.equal(refreshes, 1);
    assert.equal(env.document.body.textContent, "Your plugins");
    assert.deepEqual(calls, ["begin", "append", "finish"]);
  } finally {
    await env.clean();
  }
});

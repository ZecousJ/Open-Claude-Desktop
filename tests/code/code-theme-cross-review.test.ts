import test from "node:test";
import assert from "node:assert/strict";
import {
  act,
  createElement,
  StrictMode,
  useLayoutEffect,
  useState,
  type ReactNode,
} from "react";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import ts from "typescript";
import { parseHTML } from "linkedom";
import { createFixtureDesktop } from "../../scripts/preview/app-fixture";
import { Store, defaultSettings } from "../../electron/store/store";
import {
  publicPreferences,
  withoutPreferences,
} from "../../electron/store/settings-preferences";
import { preferenceFields } from "../../shared/settings-extras-schema";
import type { Settings, DesktopAPI } from "../../shared/types";
import { webHost } from "../../shared/host";
import { HostContext } from "../../src/host/HostContext";
import { Settings as SettingsDialog } from "../../src/settings/SettingsDialog";
import { useAppearance } from "../../src/settings/useAppearance";
import { codeColorRoles } from "../../src/settings/code-theme-palettes";
import { readSource } from "../support/read-source";

const source = (file: string) =>
  readFileSync(new URL(`../../${file}`, import.meta.url), "utf8");

const deferred = <T>() => {
  let resolve!: (value: T) => void, reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};

async function environment() {
  const { window, document } = parseHTML(
    "<html><head><meta name=theme-color></head><body><main></main></body></html>",
  );
  const bridge = createFixtureDesktop({}, new URLSearchParams("fonts=system"));
  let systemDark = true;
  const themeListeners = new Set<() => void>();
  const globals = {
    window,
    document,
    Node: window.Node,
    HTMLElement: window.HTMLElement,
    MutationObserver: window.MutationObserver,
    navigator: { userAgent: "node-test", language: "en-US" },
    innerWidth: 1440,
    innerHeight: 900,
    matchMedia: (query: string) => {
      const scheme = query === "(prefers-color-scheme: dark)";
      return {
        get matches() {
          return scheme && systemDark;
        },
        addEventListener(_event: string, listener: () => void) {
          if (scheme) themeListeners.add(listener);
        },
        removeEventListener(_event: string, listener: () => void) {
          if (scheme) themeListeners.delete(listener);
        },
      };
    },
    addEventListener: window.addEventListener.bind(window),
    removeEventListener: window.removeEventListener.bind(window),
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
  window.desktop = bridge;
  window.HTMLElement.prototype.scrollIntoView = function () {};
  document.documentElement.dataset.motion = "reduced";
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.querySelector("main")!);
  const flush = async () => {
    for (let attempt = 0; attempt < 20; attempt++)
      await act(
        async () => new Promise<void>((resolve) => setImmediate(resolve)),
      );
  };
  return {
    window,
    document,
    bridge,
    themeListeners,
    async render(node: ReactNode) {
      await act(async () => root.render(node));
      await flush();
    },
    flush,
    async system(next: boolean) {
      await act(async () => {
        systemDark = next;
        for (const listener of [...themeListeners]) listener();
      });
    },
    async click(element: Element) {
      await act(async () =>
        element.dispatchEvent(new window.Event("click", { bubbles: true })),
      );
    },
    async tab(label: string) {
      const button = Array.from(
        document.querySelectorAll(
          '[role="dialog"][aria-label="Settings"] .settings-nav-group > button',
        ),
      ).find((entry) => entry.textContent?.endsWith(label));
      assert.ok(button, label);
      await this.click(button);
      await flush();
    },
    async choose(label: string, name: string) {
      const trigger = document.querySelector<HTMLButtonElement>(
        `[role="dialog"][aria-label="Settings"] button[aria-label="${label}"]`,
      );
      assert.ok(trigger, label);
      await act(async () =>
        trigger.dispatchEvent(new window.Event("click", { bubbles: true })),
      );
      const option = Array.from(
        document.querySelectorAll('[role="option"]'),
      ).find((entry) => entry.textContent === name);
      assert.ok(option, name);
      await act(async () =>
        option.dispatchEvent(new window.Event("click", { bubbles: true })),
      );
    },
    async close() {
      await act(async () => root.unmount());
      for (const [key, descriptor] of saved) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}

function AccountSettings({
  initial,
  errors,
  onSaved,
  open = true,
}: {
  initial: Settings;
  errors: unknown[];
  onSaved: (value: Settings) => void;
  open?: boolean;
}) {
  const [settings, setSettings] = useState(initial);
  useAppearance(settings);
  return createElement(
    HostContext.Provider,
    { value: webHost },
    open
      ? createElement(SettingsDialog, {
          settings,
          platform: "darwin",
          engine: { state: "ready" },
          initialTab: "code",
          onSave: (value) => {
            onSaved(value);
            setSettings(value);
          },
          onError: (error) => errors.push(error),
          onClose() {},
        })
      : createElement(
          "pre",
          { className: "app-code-without-settings" },
          "const answer = 42;",
        ),
  );
}

function controlledSaves(bridge: DesktopAPI) {
  const original = bridge.saveSettings.bind(bridge);
  const requests: {
    settings: Settings;
    gate: ReturnType<typeof deferred<Settings>>;
  }[] = [];
  bridge.saveSettings = async (settings) => {
    const gate = deferred<Settings>();
    requests.push({ settings: structuredClone(settings), gate });
    return gate.promise;
  };
  return {
    requests,
    async success(index: number) {
      const entry = requests[index];
      assert.ok(entry, `request ${index} was actually sent`);
      await act(async () => entry.gate.resolve(await original(entry.settings)));
    },
    async fail(index: number) {
      const entry = requests[index];
      assert.ok(entry, `request ${index} was actually sent`);
      await act(async () =>
        entry.gate.reject(new Error(`request ${index} failed`)),
      );
    },
    async settle() {
      for (const entry of requests)
        await act(async () => entry.gate.resolve(entry.settings));
    },
  };
}

for (const failedHead of [false, true])
  test(`real Settings serializes a palette and General preference and rebases after ${failedHead ? "failure" : "success"}`, async () => {
    const env = await environment();
    const saves = controlledSaves(env.bridge);
    const errors: unknown[] = [],
      accepted: Settings[] = [];
    try {
      const initial = {
        ...(await env.bridge.snapshot()).settings,
        theme: "dark" as const,
      };
      await env.render(
        createElement(AccountSettings, {
          initial,
          errors,
          onSaved: (value) => accepted.push(value),
        }),
      );
      await env.choose("Dark code theme", "GitHub Dark");
      await env.tab("General");
      await env.choose("Chat font", "Sans");
      assert.equal(
        saves.requests.length,
        1,
        "only the queue head can send a whole-settings snapshot",
      );
      assert.equal(saves.requests[0].settings.chatFont, initial.chatFont);
      if (failedHead) await saves.fail(0);
      else await saves.success(0);
      await env.flush();
      assert.equal(saves.requests.length, 2);
      assert.equal(saves.requests[1].settings.chatFont, "sans");
      assert.equal(
        saves.requests[1].settings.codeDarkTheme,
        failedHead ? initial.codeDarkTheme : "github-dark",
        "queued General patch must rebase on the last committed snapshot",
      );
      await saves.success(1);
      const persisted = (await env.bridge.snapshot()).settings;
      assert.equal(persisted.chatFont, "sans");
      assert.equal(
        persisted.codeDarkTheme,
        failedHead ? initial.codeDarkTheme : "github-dark",
      );
      assert.equal(errors.length, Number(failedHead));
      assert.equal(accepted.length, failedHead ? 1 : 2);
      assert.equal(
        env.document.documentElement.dataset.codeTheme,
        failedHead ? "claudex-dark" : "github-dark",
      );
    } finally {
      await saves.settle();
      await env.close();
    }
  });

test("ordinary Settings close keeps authorized queued changes and updates the still-mounted App", async () => {
  const env = await environment();
  const saves = controlledSaves(env.bridge);
  const errors: unknown[] = [],
    accepted: Settings[] = [];
  const props = {
    initial: (await env.bridge.snapshot()).settings,
    errors,
    onSaved: (value: Settings) => accepted.push(value),
  };
  try {
    await env.render(createElement(AccountSettings, props));
    await env.choose("Dark code theme", "GitHub Dark");
    await env.tab("General");
    await env.choose("Chat font", "Sans");
    assert.equal(saves.requests.length, 1);
    await env.render(createElement(AccountSettings, { ...props, open: false }));
    await saves.success(0);
    await env.flush();
    assert.equal(
      saves.requests.length,
      2,
      "an ordinary close must not cancel a previously authorized patch",
    );
    await saves.success(1);
    await env.flush();
    assert.equal(accepted.length, 2);
    assert.equal(errors.length, 0);
    assert.equal(env.document.documentElement.dataset.codeTheme, "github-dark");
    const persisted = (await env.bridge.snapshot()).settings;
    assert.equal(persisted.codeDarkTheme, "github-dark");
    assert.equal(persisted.chatFont, "sans");
    await env.render(createElement(AccountSettings, props));
    assert.match(
      env.document.querySelector('button[aria-label="Dark code theme"]')
        ?.textContent ?? "",
      /GitHub Dark/,
    );
  } finally {
    await saves.settle();
    await env.close();
  }
});

for (const failedOldRequest of [false, true])
  test(`account rekey cancels unsent patches and ignores an old account's late ${failedOldRequest ? "error" : "success"}`, async () => {
    const env = await environment();
    const oldSaves = controlledSaves(env.bridge);
    const oldErrors: unknown[] = [],
      oldAccepted: Settings[] = [];
    const nextBridge = createFixtureDesktop(
      {},
      new URLSearchParams("fonts=system"),
    );
    const nextSaves = controlledSaves(nextBridge);
    const nextErrors: unknown[] = [],
      nextAccepted: Settings[] = [];
    try {
      const initial = (await env.bridge.snapshot()).settings;
      await env.render(
        createElement(AccountSettings, {
          key: "account-A",
          initial,
          errors: oldErrors,
          onSaved: (value) => oldAccepted.push(value),
        }),
      );
      await env.choose("Dark code theme", "GitHub Dark");
      await env.tab("General");
      await env.choose("Chat font", "Sans");
      assert.equal(oldSaves.requests.length, 1);
      env.window.desktop = nextBridge;
      await env.render(
        createElement(AccountSettings, {
          key: "account-B",
          initial: (await nextBridge.snapshot()).settings,
          errors: nextErrors,
          onSaved: (value) => nextAccepted.push(value),
        }),
      );
      if (failedOldRequest) await oldSaves.fail(0);
      else await oldSaves.success(0);
      await env.flush();
      assert.equal(
        oldSaves.requests.length,
        1,
        "the old account's unsent General patch must be cancelled",
      );
      assert.equal(
        nextSaves.requests.length,
        0,
        "an old queue must not dispatch through the newly signed-in bridge",
      );
      assert.equal(oldErrors.length, 0);
      assert.equal(
        oldAccepted.length,
        0,
        "late account-A snapshots must not reach a now-obsolete App callback",
      );
      assert.equal(nextAccepted.length, 0);
      assert.equal(nextErrors.length, 0);
      assert.equal(
        env.document.documentElement.dataset.codeTheme,
        "claudex-dark",
      );
      assert.equal((await nextBridge.snapshot()).settings.chatFont, undefined);
      await env.choose("Dark code theme", "GitHub Dark");
      assert.equal(nextSaves.requests.length, 1);
      await nextSaves.success(0);
      assert.equal(nextAccepted.length, 1);
      assert.equal(
        env.document.documentElement.dataset.codeTheme,
        "github-dark",
      );
    } finally {
      await oldSaves.settle();
      await nextSaves.settle();
      await env.close();
    }
  });

for (const reopenTab of [false, true])
  test(`real Settings does not persist a failed palette choice through the other mode's save${reopenTab ? " after tab remount" : ""}`, async () => {
    const env = await environment();
    const requests: {
      settings: Settings;
      gate: ReturnType<typeof deferred<Settings>>;
    }[] = [];
    const errors: unknown[] = [],
      accepted: Settings[] = [];
    const originalSave: DesktopAPI["saveSettings"] =
      env.bridge.saveSettings.bind(env.bridge);
    env.bridge.saveSettings = async (settings) => {
      const gate = deferred<Settings>();
      requests.push({ settings: structuredClone(settings), gate });
      return gate.promise;
    };
    try {
      const initial = {
        ...(await env.bridge.snapshot()).settings,
        theme: "dark" as const,
      };
      await env.render(
        createElement(AccountSettings, {
          initial,
          errors,
          onSaved: (value) => accepted.push(value),
        }),
      );
      await env.choose("Dark code theme", "GitHub Dark");
      if (reopenTab) {
        await env.tab("General");
        assert.equal(
          Boolean(
            env.document.querySelector('button[aria-label="Light code theme"]'),
          ),
          false,
        );
        await env.tab("Claudex Code");
      }
      const lightButton = env.document.querySelector<HTMLButtonElement>(
        'button[aria-label="Light code theme"]',
      )!;
      // A safe implementation may serialize the pair. If the other control is
      // offered while one is pending, exercise its real selection too.
      const selectedWhilePending = !lightButton.disabled;
      if (selectedWhilePending)
        await env.choose("Light code theme", "GitHub Light");
      await act(async () =>
        requests[0].gate.reject(new Error("first theme save failed")),
      );
      if (!selectedWhilePending)
        await env.choose("Light code theme", "GitHub Light");
      await env.flush();
      assert.equal(requests.length, 2);
      await act(async () =>
        requests[1].gate.resolve(await originalSave(requests[1].settings)),
      );
      const persisted = (await env.bridge.snapshot()).settings;
      assert.equal(errors.length, 1);
      assert.equal(accepted.length, 1);
      assert.equal(persisted.codeLightTheme, "github-light");
      assert.equal(
        persisted.codeDarkTheme,
        initial.codeDarkTheme,
        "the failed dark choice must not be copied into the other mode's persisted full snapshot",
      );
    } finally {
      for (const request of requests) request.gate.resolve(request.settings);
      await env.close();
    }
  });

test("production App keeps the actual appearance hook outside the lazy Settings lifetime", () => {
  const ast = ts.createSourceFile(
    "App.tsx",
    readSource("src/app/App.tsx"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  let found = false;
  const walk = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "useAppearance"
    ) {
      assert.ok(ts.isExpressionStatement(node.parent));
      assert.ok(ts.isBlock(node.parent.parent));
      const owner = node.parent.parent.parent;
      // App itself, or useAppState, which App calls on every render.
      assert.ok(
        ts.isFunctionDeclaration(owner) &&
          ["App", "useAppState"].includes(owner.name?.text ?? ""),
      );
      assert.equal(node.arguments[0]?.getText(ast), "snapshot?.settings");
      found = true;
    }
    ts.forEachChild(node, walk);
  };
  walk(ast);
  assert.equal(found, true);
});

test("actual layout effect survives strict replay, pending snapshot, account rekey and system changes without Settings", async () => {
  const env = await environment();
  const root = env.document.documentElement;
  const observations: { id?: string; keyword: string; count: number }[] = [];
  function Appearance({ settings }: { settings?: Settings }) {
    useAppearance(settings);
    useLayoutEffect(() => {
      observations.push({
        id: root.dataset.codeTheme,
        keyword: root.style.getPropertyValue("--code-keyword") ?? "",
        count: codeColorRoles.filter((role) =>
          Boolean(root.style.getPropertyValue(`--code-${role}`)),
        ).length,
      });
    });
    return createElement(
      "pre",
      { className: "hljs" },
      "plain application code",
    );
  }
  const render = (settings?: Settings, account = "A") =>
    env.render(
      createElement(
        StrictMode,
        null,
        createElement(Appearance, { key: account, settings }),
      ),
    );
  try {
    root.style.setProperty("--other-owner", "kept");
    await render({
      ...defaultSettings,
      theme: "system",
      codeLightTheme: "github-light",
      codeDarkTheme: "github-dark",
    });
    assert.deepEqual(observations.at(-1), {
      id: "github-dark",
      keyword: "#ff7b72",
      count: 17,
    });
    assert.equal(
      env.themeListeners.size,
      1,
      "strict replay must remove the obsolete media listener",
    );
    await env.system(false);
    assert.equal(root.dataset.codeTheme, "github-light");
    assert.equal(root.style.getPropertyValue("--code-background"), "#ffffff");
    await render(undefined, "B");
    assert.equal(root.dataset.codeTheme, undefined);
    assert.equal(env.themeListeners.size, 0);
    assert.ok(
      codeColorRoles.every(
        (role) => !root.style.getPropertyValue(`--code-${role}`),
      ),
    );
    await render(
      { ...defaultSettings, theme: "system", codeDarkTheme: "github-dark" },
      "B",
    );
    assert.deepEqual(observations.at(-1), {
      id: "claudex-light",
      keyword: "",
      count: 0,
    });
    await env.system(true);
    assert.equal(root.dataset.codeTheme, "github-dark");
    await render(
      { ...defaultSettings, theme: "light", codeDarkTheme: "github-dark" },
      "B",
    );
    await env.system(true);
    assert.equal(
      root.dataset.theme,
      "light",
      "an explicit UI theme ignores later system changes",
    );
    assert.equal(root.dataset.codeTheme, "claudex-light");
    assert.equal(root.style.getPropertyValue("--other-owner"), "kept");
    await env.render(null);
    assert.equal(env.themeListeners.size, 0);
  } finally {
    await env.close();
  }
});

test("actual Settings close/reopen and default selection keep the committed App palette then clear every role", async () => {
  const env = await environment();
  const root = env.document.documentElement;
  const initial = {
    ...(await env.bridge.snapshot()).settings,
    theme: "dark" as const,
    codeDarkTheme: "github-dark" as const,
  };
  const errors: unknown[] = [],
    accepted: Settings[] = [];
  const props = {
    initial,
    errors,
    onSaved: (value: Settings) => accepted.push(value),
  };
  try {
    await env.render(createElement(AccountSettings, props));
    assert.equal(root.dataset.codeTheme, "github-dark");
    await env.render(createElement(AccountSettings, { ...props, open: false }));
    assert.equal(
      Boolean(
        env.document.querySelector('[role="dialog"][aria-label="Settings"]'),
      ),
      false,
    );
    assert.equal(root.style.getPropertyValue("--code-constant"), "#79c0ff");
    assert.equal(
      env.themeListeners.size,
      1,
      "closing only Settings must not unmount App appearance",
    );
    await env.render(createElement(AccountSettings, props));
    await env.choose("Dark code theme", "Claudex Dark");
    await env.flush();
    assert.equal(root.dataset.codeTheme, "claudex-dark");
    assert.ok(
      codeColorRoles.every(
        (role) => !root.style.getPropertyValue(`--code-${role}`),
      ),
    );
    assert.equal(accepted.length, 1);
    assert.equal(
      (await env.bridge.snapshot()).settings.codeDarkTheme,
      "claudex-dark",
    );
    assert.equal(errors.length, 0);
  } finally {
    await env.close();
  }
});

test("real stored unknown palette values cannot inject CSS or retain the previous account palette", async () => {
  const env = await environment();
  const directory = mkdtempSync(
    path.join(os.tmpdir(), "claudex-r4-theme-cross-"),
  );
  const root = env.document.documentElement;
  function Appearance({ settings }: { settings: Settings }) {
    useAppearance(settings);
    return createElement("code", null, "storage safety probe");
  }
  try {
    for (const injected of [
      "github-dark;--other-owner:changed",
      "url(https://palette.invalid/probe)",
      "__proto__",
      { background: "url(https://palette.invalid/probe)" },
      ["github-dark"],
      null,
    ]) {
      assert.equal(
        preferenceFields.codeDarkTheme.safeParse(injected).success,
        false,
      );
      await env.render(
        createElement(Appearance, {
          settings: { ...defaultSettings, codeDarkTheme: "github-dark" },
        }),
      );
      root.style.setProperty("--other-owner", "kept");
      writeFileSync(
        path.join(directory, "settings.json"),
        JSON.stringify({ ...defaultSettings, codeDarkTheme: injected }),
      );
      const restarted = new Store(directory);
      await env.render(
        createElement(Appearance, { settings: restarted.settings }),
      );
      assert.equal(root.dataset.codeTheme, "claudex-dark");
      assert.ok(
        codeColorRoles.every(
          (role) => !root.style.getPropertyValue(`--code-${role}`),
        ),
      );
      assert.equal(root.style.getPropertyValue("--other-owner"), "kept");
      assert.doesNotMatch(
        root.getAttribute("style") ?? "",
        /palette\.invalid|changed/,
      );
      assert.equal(
        Boolean(
          env.document.querySelector('link[href*="palette.invalid"],style'),
        ),
        false,
      );
    }
  } finally {
    await env.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("only palette preferences cross the real public-settings boundary and disk restart without agent settings", () => {
  const directory = mkdtempSync(
    path.join(os.tmpdir(), "claudex-r4-theme-cross-persist-"),
  );
  try {
    const store = new Store(directory);
    store.settings = {
      ...store.settings,
      codeLightTheme: "github-light",
      codeDarkTheme: "github-dark",
    };
    store.flush();
    const restarted = new Store(directory);
    assert.deepEqual(publicPreferences(restarted.settings), {
      codeLightTheme: "github-light",
      codeDarkTheme: "github-dark",
    });
    assert.deepEqual(
      withoutPreferences(restarted.settings),
      withoutPreferences(defaultSettings),
    );
    delete restarted.settings.codeLightTheme;
    delete restarted.settings.codeDarkTheme;
    restarted.flush();
    assert.equal(new Store(directory).settings.codeLightTheme, undefined);
    assert.equal(new Store(directory).settings.codeDarkTheme, undefined);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

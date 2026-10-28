import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { act, createElement as h, StrictMode, useState } from "react";
import type { AppController } from "../../src/app/AppContext";
import { AppContext } from "../../src/app/AppContext";
import { SettingsOverlay } from "../../src/app/SettingsHost";
import {
  requestSettingsSkillsView,
  useSettingsSkillsNavigation,
} from "../../src/settings/skills-navigation";
import { defaultSettings } from "../../electron/store/store";
import { routineDom } from "../support/routine-dom";

async function environment() {
  const env = await routineDom({
    listSkills: async () => [],
    customizeSkills: async () => [],
    trustedCoworkFolders: async () => [],
    saveSettings: () =>
      assert.fail("opening a Skills view must not write preferences"),
    openExternal: async () => {},
    onEvent: () => () => {},
  });
  env.window.innerWidth = 1440;
  env.window.innerHeight = 900;
  env.window.matchMedia = (() => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  })) as never;
  const globals = {
    HTMLElement: env.window.HTMLElement,
    getComputedStyle: () => ({
      overflow: "visible",
      overflowX: "visible",
      getPropertyValue: () => "0ms",
    }),
    addEventListener: env.window.addEventListener.bind(env.window),
    removeEventListener: env.window.removeEventListener.bind(env.window),
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
  const proto = env.window.HTMLElement.prototype;
  const scroll = Object.getOwnPropertyDescriptor(proto, "scrollIntoView");
  proto.scrollIntoView = () => {};
  let app!: AppController;
  function Harness({ account = "owner" }: { account?: string }) {
    const [settingsOpen, setSettingsOpen] = useState(false),
      [settingsTab, setSettingsTab] = useState("skills");
    app = {
      accountId: account,
      settingsOpen,
      settingsTab,
      setSettingsOpen,
      snapshot: {
        settings: defaultSettings,
        platform: "darwin",
        engine: { state: "ready" },
      },
      openSettingsTab(tab: string) {
        setSettingsTab(tab);
        setSettingsOpen(true);
      },
      report(error: unknown) {
        throw error;
      },
      page: "chat",
      activeId: "unchanged-background-chat",
      setPage: () =>
        assert.fail("Skills footer must not navigate to a full page"),
    } as unknown as AppController;
    return h(AppContext.Provider, { value: app }, h(SettingsOverlay));
  }
  return {
    ...env,
    Harness,
    app: () => app,
    async open(view?: "yours" | "discover") {
      await act(async () => {
        if (view)
          requestSettingsSkillsView(app.accountId, view, env.window.desktop);
        app.openSettingsTab("skills");
      });
    },
    async settle(check: () => boolean) {
      for (let attempt = 0; attempt < 150 && !check(); attempt++)
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 5));
        });
      assert.ok(check(), "expected lazy Settings/Skills content");
    },
    selected() {
      return env.document.querySelector(
        '[aria-label="Skills view"] [aria-checked="true"]',
      )?.textContent;
    },
    async clean() {
      await env.clean();
      if (scroll) Object.defineProperty(proto, "scrollIntoView", scroll);
      else Reflect.deleteProperty(proto, "scrollIntoView");
      for (const [key, previous] of saved)
        if (previous) Object.defineProperty(globalThis, key, previous);
        else Reflect.deleteProperty(globalThis, key);
    },
  };
}

test("closing before actual Settings or Skills chunks commit cannot retain a Discover target", async () => {
  const key = "__claudexSettingsSkillsChunkGate";
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  let releaseSkills!: () => void;
  const skillsWait = new Promise<void>((resolve) => {
    releaseSkills = resolve;
  });
  const gate = { wait, loaded: false, skillsWait, skillsLoaded: false };
  (globalThis as unknown as Record<string, unknown>)[key] = gate;
  const actual = new URL(
    "../../src/settings/SettingsDialog.tsx",
    import.meta.url,
  ).href;
  const delayed =
    "data:text/javascript," +
    encodeURIComponent(
      `export { Settings } from ${JSON.stringify(actual)}; await globalThis[${JSON.stringify(key)}].wait; globalThis[${JSON.stringify(key)}].loaded=true;`,
    );
  const actualSkills = new URL(
    "../../src/settings/tabs/Skills.tsx",
    import.meta.url,
  ).href;
  const delayedSkills =
    "data:text/javascript," +
    encodeURIComponent(
      `export { SkillsTab } from ${JSON.stringify(actualSkills)}; await globalThis[${JSON.stringify(key)}].skillsWait; globalThis[${JSON.stringify(key)}].skillsLoaded=true;`,
    );
  let requested = 0;
  let skillsRequested = 0;
  const hooks = registerHooks({
    resolve(specifier, context, next) {
      if (
        specifier.includes("settings/SettingsDialog") &&
        context.parentURL?.includes("/src/app/SettingsHost")
      ) {
        requested++;
        return { shortCircuit: true, url: delayed };
      }
      if (
        specifier.includes("tabs/Skills") &&
        context.parentURL?.includes("/src/settings/SettingsDialog")
      ) {
        skillsRequested++;
        return { shortCircuit: true, url: delayedSkills };
      }
      return next(specifier, context);
    },
  });
  const env = await environment();
  try {
    await env.render(h(env.Harness));
    await env.open("discover");
    assert.equal(
      requested,
      1,
      "the real SettingsOverlay requested its blocked chunk",
    );
    assert.equal(env.document.querySelector('[role="dialog"]'), null);
    await act(async () => env.app().setSettingsOpen(false));
    await act(async () => {
      release();
    });
    await env.settle(() => gate.loaded);
    assert.equal(env.document.querySelector('[role="dialog"]'), null);
    await env.open();
    await env.settle(() => skillsRequested === 1);
    assert.ok(
      env.document.querySelector('[role="dialog"][aria-label="Settings"]'),
    );
    assert.equal(
      env.selected(),
      undefined,
      "the actual Skills chunk is still blocked",
    );
    await env.click(".settings-close");
    await act(async () => {
      releaseSkills();
    });
    await env.settle(() => gate.skillsLoaded);
    assert.equal(env.document.querySelector('[role="dialog"]'), null);
    await env.open();
    await env.settle(() => Boolean(env.selected()));
    assert.equal(env.selected(), "Yours");
    assert.equal(env.app().page, "chat");
    assert.equal(env.app().activeId, "unchanged-background-chat");
  } finally {
    release();
    releaseSkills();
    hooks.deregister();
    delete (globalThis as unknown as Record<string, unknown>)[key];
    await env.clean();
  }
});

test("real already-open Skills dialog switches Yours/Discover, and a later generic opening starts Yours", async () => {
  const env = await environment();
  try {
    await env.render(h(env.Harness));
    await env.open("yours");
    await env.settle(() => Boolean(env.selected()));
    const dialog = env.document.querySelector(
      '[role="dialog"][aria-label="Settings"]',
    );
    assert.ok(dialog);
    assert.equal(env.selected(), "Yours");
    await env.open("discover");
    await env.settle(() => env.selected() === "Discover");
    assert.equal(env.document.querySelector('[role="dialog"]'), dialog);
    await env.open("yours");
    assert.equal(env.selected(), "Yours");
    await env.click(".settings-close");
    await env.open();
    await env.settle(() => Boolean(env.selected()));
    assert.equal(env.selected(), "Yours");
  } finally {
    await env.clean();
  }
});

test("StrictMode consumes a request after commit without dropping its lazy Skills view", async () => {
  const env = await environment();
  try {
    await env.render(h(StrictMode, null, h(env.Harness)));
    await env.open("discover");
    await env.settle(() => env.selected() === "Discover");
    assert.equal(
      env.document.querySelectorAll('[role="dialog"][aria-label="Settings"]')
        .length,
      1,
    );
    await env.click(".settings-close");
    await env.open();
    await env.settle(() => Boolean(env.selected()));
    assert.equal(env.selected(), "Yours");
  } finally {
    await env.clean();
  }
});

test("account and bridge replacement synchronously discard the previous Settings target", async () => {
  const env = await environment();
  let value!: ReturnType<typeof useSettingsSkillsNavigation>;
  function Probe({
    account,
    open = true,
  }: {
    account: string;
    open?: boolean;
  }) {
    value = useSettingsSkillsNavigation(account, open);
    return h("output", null, value.view);
  }
  const firstBridge = env.window.desktop;
  try {
    requestSettingsSkillsView("first", "discover", firstBridge);
    await env.render(h(StrictMode, null, h(Probe, { account: "first" })));
    assert.equal(value.view, "discover");
    await env.render(h(StrictMode, null, h(Probe, { account: "second" })));
    assert.equal(value.view, "yours");
    const oldChange = value.onViewChange;
    env.window.desktop = { ...firstBridge };
    await env.render(h(StrictMode, null, h(Probe, { account: "second" })));
    await act(async () => oldChange("discover"));
    assert.equal(value.view, "yours");
    requestSettingsSkillsView("second", "discover", firstBridge);
    await env.render(h(StrictMode, null, h(Probe, { account: "second" })));
    assert.equal(
      value.view,
      "yours",
      "an old bridge request is never accepted by a new bridge",
    );
    requestSettingsSkillsView("first", "discover", env.window.desktop);
    await env.render(h(StrictMode, null, h(Probe, { account: "first" })));
    assert.equal(
      value.view,
      "yours",
      "a superseded account cannot queue a later target",
    );
    await env.render(h("p", null, "Other account"));
    env.window.desktop = firstBridge;
    await env.render(h(StrictMode, null, h(Probe, { account: "first" })));
    assert.equal(value.view, "yours");
    await env.render(h(StrictMode, null, h(Probe, { account: "second" })));
    assert.equal(
      value.view,
      "yours",
      "returning to a former bridge does not revive a stale request",
    );
  } finally {
    await env.clean();
  }
});

test("manual Skills segment changes remain usable after a footer request", async () => {
  const env = await environment();
  try {
    await env.render(h(env.Harness));
    await env.open("discover");
    await env.settle(() => env.selected() === "Discover");
    const yours = [
      ...env.document.querySelectorAll<HTMLButtonElement>(
        '[aria-label="Skills view"] button',
      ),
    ].find((button) => button.textContent === "Yours")!;
    await env.event(yours, "click");
    assert.equal(env.selected(), "Yours");
    await env.open("discover");
    assert.equal(env.selected(), "Discover");
    assert.equal(env.app().page, "chat");
  } finally {
    await env.clean();
  }
});

test("a footer request changes an already-open different Settings tab into the requested Skills view", async () => {
  const env = await environment();
  try {
    await env.render(h(env.Harness));
    await act(async () => env.app().openSettingsTab("general"));
    await env.settle(() =>
      Boolean(env.document.querySelector('[aria-current="page"]')),
    );
    assert.equal(
      env.document.querySelector('[aria-current="page"]')?.textContent,
      "General",
    );
    await env.open("discover");
    await env.settle(() => env.selected() === "Discover");
    assert.equal(
      // A page's icon-font glyph is part of the button's text.
      env.document
        .querySelector('[aria-current="page"]')
        ?.textContent?.replace(/[\uE000-\uF8FF]/g, ""),
      "Skills",
    );
    assert.equal(env.app().activeId, "unchanged-background-chat");
  } finally {
    await env.clean();
  }
});

test("a real Skills dialog cannot carry its view into another account or replacement bridge", async () => {
  const env = await environment();
  try {
    await env.render(h(env.Harness, { account: "first" }));
    await env.open("discover");
    await env.settle(() => env.selected() === "Discover");
    await env.render(h(env.Harness, { account: "second" }));
    await env.settle(() => env.selected() === "Yours");
    await env.open("discover");
    assert.equal(env.selected(), "Discover");
    env.window.desktop = { ...env.window.desktop };
    await env.render(h(env.Harness, { account: "second" }));
    await env.settle(() => env.selected() === "Yours");
    await env.render(h(env.Harness, { account: "first" }));
    assert.equal(env.selected(), "Yours");
  } finally {
    await env.clean();
  }
});

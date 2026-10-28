import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { act, createElement, useState } from "react";
import { parseHTML } from "linkedom";
import {
  createFixtureDesktop,
  fixtureSnapshot,
} from "../../scripts/preview/app-fixture";
import { desktopHost, webHost, type HostInfo } from "../../shared/host";
import { AppContext, type AppController } from "../../src/app/AppContext";
import { HostContext } from "../../src/host/HostContext";
import {
  availableNavGroups,
  openableTab,
  tabAvailable,
} from "../../src/settings/nav";

registerHooks({
  load(url, context, next) {
    if (url.includes("?url"))
      return {
        format: "module",
        source: `export default ${JSON.stringify(url)};`,
        shortCircuit: true,
      };
    return next(url, context);
  },
});
const { AppSidebar } = await import("../../src/app/AppSidebar");
const { SettingsOverlay } = await import("../../src/app/SettingsHost");
const noop = () => {};

test("Usage resolution and visible navigation require a plan or actual desktop local Code capability", () => {
  const withoutLocal: HostInfo = {
    ...desktopHost,
    capabilities: { ...desktopHost.capabilities, localCode: false },
  };
  const webWithReportedLocal: HostInfo = {
    ...webHost,
    capabilities: { ...webHost.capabilities, localCode: true },
  };
  for (const [host, plan, available] of [
    [desktopHost, false, true],
    [withoutLocal, false, false],
    [webHost, false, false],
    [webWithReportedLocal, false, false],
    [webHost, true, true],
    [withoutLocal, true, true],
  ] as [HostInfo, boolean, boolean][]) {
    assert.equal(tabAvailable("usage", host, plan), available);
    assert.equal(
      openableTab("usage", host, plan),
      available ? "usage" : "general",
    );
    assert.equal(
      availableNavGroups(host, plan).some((group) =>
        group.tabs.some((tab) => tab.id === "usage"),
      ),
      available,
    );
  }
});

async function environment(
  host: HostInfo,
  remoteAccount = false,
  mode: "chat" | "code" = "code",
  initialTab = "general",
) {
  const { window, document } = parseHTML(
    '<html><body><div class="app"><main></main><div class="app-chrome-layer"></div></div></body></html>',
  );
  document.documentElement.dataset.motion = "reduced";
  const bridge = createFixtureDesktop(
    { history: "empty" },
    new URLSearchParams("fonts=system&weekly=none"),
  );
  let dashboards = 0;
  bridge.planUsage = async () => null;
  bridge.codeUsageDashboard = async () => {
    dashboards++;
    return null;
  };
  bridge.billingCheckout = async () => null;
  Object.assign(window, {
    desktop: bridge,
    innerWidth: 1440,
    innerHeight: 900,
    matchMedia: () => ({
      matches: false,
      addEventListener: noop,
      removeEventListener: noop,
    }),
  });
  Object.defineProperty(window, "location", {
    configurable: true,
    value: new URL("http://fixture.invalid/code"),
  });
  const prototype = window.HTMLElement.prototype;
  const focus = Object.getOwnPropertyDescriptor(prototype, "focus"),
    bounds = Object.getOwnPropertyDescriptor(
      prototype,
      "getBoundingClientRect",
    ),
    scroll = Object.getOwnPropertyDescriptor(prototype, "scrollIntoView");
  let focused: Element = document.body;
  prototype.focus = function () {
    focused = this;
  };
  prototype.scrollIntoView = noop;
  prototype.getBoundingClientRect = () => ({
    x: 8,
    y: 800,
    left: 8,
    top: 800,
    right: 250,
    bottom: 832,
    width: 242,
    height: 32,
    toJSON: noop,
  });
  Object.defineProperty(document, "activeElement", {
    configurable: true,
    get: () => focused,
  });
  const globals = {
    window,
    document,
    HTMLElement: window.HTMLElement,
    Element: window.Element,
    Node: window.Node,
    innerWidth: 1440,
    innerHeight: 900,
    navigator: { userAgent: "fixture", language: "en-US" },
    getComputedStyle: () => ({
      display: "block",
      visibility: "visible",
      overflowX: "visible",
      getPropertyValue: () => "",
    }),
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    addEventListener: window.addEventListener.bind(window),
    removeEventListener: window.removeEventListener.bind(window),
    requestAnimationFrame: (callback: FrameRequestCallback) =>
      setTimeout(() => callback(0), 0),
    cancelAnimationFrame: clearTimeout,
    ResizeObserver: class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
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
  const snapshot = fixtureSnapshot({ history: "empty" });
  const actions: string[] = [],
    errors: unknown[] = [];
  function Harness() {
    const [settingsOpen, setSettingsOpen] = useState(false),
      [settingsTab, setSettingsTab] = useState(initialTab);
    const app = {
      accountId: "synthetic-local",
      snapshot,
      remoteAccount,
      settingsOpen,
      settingsTab,
      setSettingsOpen,
      openSettingsTab(tab: string) {
        actions.push(`settings:${tab}`);
        setSettingsTab(tab);
        setSettingsOpen(true);
      },
      sidebarView: {
        open: true,
        phone: false,
        narrow: false,
        toggle: noop,
        show: noop,
        peekChanged: noop,
      },
      navigation: { back: noop, forward: noop },
      incognitoShown: false,
      listed: [],
      approvalIds: new Set(),
      mode,
      page: "chat",
      policy: { planLabel: null },
      composerDraft: { draftAdditionalFolders: [] },
      newChat(mode: string) {
        actions.push(`new:${mode}`);
      },
      setPage: noop,
      setPanel: noop,
      setSidebarWidthPreview: noop,
      updatePreference: async () => {},
      setSnapshot: noop,
      setEditSidebar: noop,
      setSearchEntrypoint: noop,
      setSearch: noop,
      patchConversation: async () => {},
      openConversation: noop,
      confirmDelete: noop,
      openReleaseNotes: noop,
      report: (error: unknown) => errors.push(error),
      onSignOut: async () => {},
    } as unknown as AppController;
    return createElement(
      HostContext.Provider,
      { value: host },
      createElement(
        AppContext.Provider,
        { value: app },
        createElement(AppSidebar),
        createElement(SettingsOverlay),
      ),
    );
  }
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.querySelector("main")!);
  const settle = async () => {
    for (let n = 0; n < 8; n++)
      await act(async () => {
        await new Promise((done) => setTimeout(done, 10));
      });
  };
  await act(async () => root.render(createElement(Harness)));
  return {
    document,
    actions,
    errors,
    dashboards: () => dashboards,
    settle,
    async click(target: Element) {
      await act(async () => (target as HTMLElement).click());
      await settle();
    },
    async clean() {
      await act(async () => root.unmount());
      for (const [name, descriptor] of [
        ["focus", focus],
        ["getBoundingClientRect", bounds],
        ["scrollIntoView", scroll],
      ] as const) {
        if (descriptor) Object.defineProperty(prototype, name, descriptor);
        else Reflect.deleteProperty(prototype, name);
      }
      for (const [key, descriptor] of saved) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}

test("actual local account Usage action opens Settings Usage and the real statistics without resetting its Code draft", async () => {
  const page = await environment(desktopHost);
  try {
    await page.settle();
    await page.click(page.document.querySelector("button.profile")!);
    const usage = [...page.document.querySelectorAll('[role="menuitem"]')].find(
      (element) =>
        element.querySelector("span:not([data-icon])")?.textContent?.trim() ===
        "Usage",
    )!;
    assert.ok(usage, "the actual account menu exposes Usage");
    await page.click(usage);
    assert.deepEqual(page.actions, ["settings:usage"]);
    assert.ok(
      page.document
        .querySelector('.settings-dialog [aria-current="page"]')
        ?.textContent?.includes("Usage"),
    );
    assert.ok(
      page.document.querySelector(".usage-overview"),
      "the actual lazy Usage page mounts its retained local statistics",
    );
    assert.ok(page.dashboards() > 0);
    assert.deepEqual(page.errors, []);
  } finally {
    await page.clean();
  }
});

test("actual web service-plan Usage action keeps the service page without local Code statistics", async () => {
  const page = await environment(webHost, true);
  try {
    await page.settle();
    await page.click(page.document.querySelector("button.profile")!);
    const usage = [...page.document.querySelectorAll('[role="menuitem"]')].find(
      (element) =>
        element.querySelector("span:not([data-icon])")?.textContent?.trim() ===
        "Usage",
    )!;
    await page.click(usage);
    assert.deepEqual(page.actions, ["settings:usage"]);
    assert.ok(
      page.document
        .querySelector('.settings-dialog [aria-current="page"]')
        ?.textContent?.includes("Usage"),
    );
    assert.equal(page.document.querySelector(".usage-overview"), null);
    assert.equal(page.dashboards(), 0);
    assert.deepEqual(page.errors, []);
  } finally {
    await page.clean();
  }
});

for (const [surfaceName, host] of [
  ["web", webHost],
  ["desktop", desktopHost],
] as const)
  for (const mode of ["chat", "code"] as const)
    test(`${surfaceName} ${mode} account Settings uses the actual context without creating a conversation`, async () => {
      const page = await environment(host, false, mode, "privacy");
      try {
        await page.settle();
        await page.click(page.document.querySelector("button.profile")!);
        const settings = [
          ...page.document.querySelectorAll('[role="menuitem"]'),
        ].find(
          (element) =>
            element
              .querySelector("span:not([data-icon])")
              ?.textContent?.trim() === "Settings",
        )!;
        assert.ok(settings);
        await page.click(settings);
        const selected = page.document.querySelector(
          '.settings-dialog [aria-current="page"]',
        )?.textContent;
        assert.match(
          selected ?? "",
          mode === "code" ? /Claudex Code/ : /General/,
        );
        assert.deepEqual(page.actions, [
          mode === "code" ? "settings:code" : "settings:general",
        ]);
        assert.deepEqual(page.errors, []);
      } finally {
        await page.clean();
      }
    });

test("a web account without measurable usage hides Usage and never starts a Code draft", async () => {
  const page = await environment(webHost, false);
  try {
    await page.settle();
    await page.click(page.document.querySelector("button.profile")!);
    assert.equal(
      [...page.document.querySelectorAll('[role="menuitem"]')].some(
        (element) =>
          element
            .querySelector("span:not([data-icon])")
            ?.textContent?.trim() === "Usage",
      ),
      false,
    );
    assert.deepEqual(page.actions, []);
  } finally {
    await page.clean();
  }
});

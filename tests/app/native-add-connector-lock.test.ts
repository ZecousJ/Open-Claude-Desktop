import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  act,
  createElement,
  type ComponentType,
  type ComponentProps,
} from "react";
import { parseHTML } from "linkedom";
import ts from "typescript";
import { ComposerAddMenu } from "../../src/composer/ComposerAddMenu";
import { AppContext, type AppController } from "../../src/app/AppContext";
import { fixtureSettings } from "../../scripts/preview/app-fixture";
import type { Conversation } from "../../shared/types";

type Props = ComponentProps<typeof ComposerAddMenu>;
const noop = () => {};
const reason = "Cannot modify connectors while message is processing";

async function mountedMenu(
  Menu: ComponentType<Props>,
  active: boolean,
  presentation: Props["presentation"],
) {
  const { window, document } = parseHTML(
    "<html><body><main></main></body></html>",
  );
  window.HTMLElement.prototype.getBoundingClientRect = () => ({
    x: 10,
    y: 10,
    left: 10,
    top: 10,
    right: 238,
    bottom: 330,
    width: 228,
    height: 320,
    toJSON: () => ({}),
  });
  Object.defineProperty(window, "location", {
    value: new URL("http://127.0.0.1/native-connector-lock"),
    configurable: true,
  });
  window.desktop = {
    customizeSkills: async () => [],
    listDesignSystems: async () => [],
    mcpServers: async () => ({
      servers: [
        {
          name: "synthetic_connector",
          state: "ready",
          tools: 1,
          toolList: [
            { name: "read", description: "Synthetic tool", enabled: true },
          ],
        },
      ],
    }),
    onEvent: () => () => {},
  } as never;
  Object.assign(window, { innerWidth: 1280, innerHeight: 720 });
  const globals = {
    window,
    document,
    innerWidth: 1280,
    innerHeight: 720,
    Element: window.Element,
    HTMLElement: window.HTMLElement,
    HTMLInputElement: window.HTMLInputElement,
    getComputedStyle: () => ({
      overflow: "visible",
      overflowX: "visible",
      getPropertyValue: () => "0",
    }),
    requestAnimationFrame: () => 1,
    cancelAnimationFrame: noop,
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
      value,
      configurable: true,
      writable: true,
    });
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.querySelector("main")!);
  const calls: { patch: unknown[]; draft: unknown[] } = {
    patch: [],
    draft: [],
  };
  const app = {
    running: false,
    sending: false,
    active: active
      ? ({
          id: "native-connector-session",
          mode: "cowork",
          connectorOverrides: {},
        } as Conversation)
      : undefined,
    snapshot: {
      settings: {
        ...fixtureSettings(),
        mcpServers: {
          synthetic_connector: {
            command: "synthetic-test-only",
            enabled: true,
          },
        },
      },
    },
    composerDraft: {
      draftConnectors: {},
      setDraftConnectors(next: unknown) {
        calls.draft.push(next);
      },
      setDraftToolSearchMode(mode: unknown) {
        calls.draft.push({ toolSearchMode: mode });
      },
    },
    patchConversation: async (_conversation: Conversation, patch: unknown) => {
      calls.patch.push(patch);
    },
    report(error: unknown) {
      throw error;
    },
  } as unknown as AppController;
  let processing = false;
  const render = async () => {
    const props: Props = {
      presentation,
      processing,
      platform: "darwin",
      projects: [],
      webSearch: false,
      webSearchAvailable: true,
      onWebSearch: noop,
      onClose: noop,
      onFiles: noop,
      onProject: noop,
      onCreateProject: noop,
      onSettings: noop,
      onUnavailable: noop,
    };
    await act(async () => {
      root.render(
        createElement(
          AppContext.Provider,
          { value: app },
          createElement(Menu, props),
        ),
      );
    });
  };
  const click = async (selector: string) => {
    const node = document.querySelector<HTMLButtonElement>(selector);
    assert.ok(node, selector);
    await act(async () => {
      node.click();
      await Promise.resolve();
    });
  };
  await render();
  await click('[data-add-branch="connectors"]');
  const selector =
    '[data-add-panel="connectors"] button[role="menuitemcheckbox"]';
  return {
    app,
    calls,
    document,
    selector,
    click,
    button: () => document.querySelector<HTMLButtonElement>(selector)!,
    async busy(flag: "running" | "sending" | "prop", value: boolean) {
      if (flag === "prop") processing = value;
      else app[flag] = value;
      await render();
    },
    async dispose() {
      await act(async () => root.unmount());
      for (const [key, descriptor] of saved) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}

test("an already-open native connector menu locks on running/sending, leaves both mutation routes untouched, and unlocks when processing ends", async () => {
  for (const active of [true, false])
    for (const flag of ["running", "sending", "prop"] as const) {
      const env = await mountedMenu(ComposerAddMenu, active, "native-chat");
      try {
        assert.equal(env.button().disabled, false);
        await env.busy(flag, true);
        assert.equal(
          env.document
            .querySelector('[data-add-branch="connectors"]')
            ?.getAttribute("aria-expanded"),
          "true",
        );
        assert.equal(env.button().disabled, true);
        assert.equal(env.button().title, reason);
        await env.click(env.selector);
        assert.deepEqual(env.calls, { patch: [], draft: [] });
        await env.busy(flag, false);
        assert.equal(env.button().disabled, false);
        await env.click(env.selector);
        assert.equal(env.calls.patch.length, active ? 1 : 0);
        assert.equal(env.calls.draft.length, active ? 0 : 1);
      } finally {
        await env.dispose();
      }
    }
});

// Negative controls load this same production component in memory, changing
// only the DOM disabled attribute, then optionally removing the entry guard.
// This exercises the real callback without relying on React's disabled-event
// filtering or private Fiber fields. No source file is changed by the test.
async function withoutDomLock(removeCallbackGuard: boolean) {
  const url = new URL(
    "../../src/composer/ComposerAddMenu.tsx",
    import.meta.url,
  );
  let source = readFileSync(url, "utf8");
  assert.equal(
    source.split("disabled={connectorProcessing || connectorSaving}").length,
    2,
  );
  source = source.replace(
    "disabled={connectorProcessing || connectorSaving}",
    "disabled={false}",
  );
  if (removeCallbackGuard) {
    assert.ok(source.includes("connectorLock.current ||"));
    assert.ok(source.includes("!connectorLock.current,"));
    source = source
      .replace("connectorLock.current ||", "false ||")
      .replace("!connectorLock.current,", "true,");
  }
  const output = ts
    .transpileModule(source, {
      fileName: "ComposerAddMenu.tsx",
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
        jsx: ts.JsxEmit.ReactJSX,
      },
    })
    .outputText.replace(
      /((?:from\s*|import\s*\(\s*|import\s*)["'])([^"']+)(["'])/g,
      (_all, start: string, specifier: string, end: string) =>
        start +
        (specifier.startsWith(".")
          ? new URL(specifier, url).href
          : /^[a-z]+:/i.test(specifier)
            ? specifier
            : import.meta.resolve(specifier)) +
        end,
    );
  return (await import("data:text/javascript," + encodeURIComponent(output)))
    .ComposerAddMenu as ComponentType<Props>;
}

test("the actual native callback also rejects a stale/open action when DOM disabling is removed; removing the callback guard exposes the mutation", async () => {
  for (const active of [true, false])
    for (const removeGuard of [false, true]) {
      const Menu = await withoutDomLock(removeGuard);
      const env = await mountedMenu(Menu, active, "native-chat");
      try {
        await env.busy("running", true);
        assert.equal(
          env.button().disabled,
          false,
          "deliberate DOM-lock negative control",
        );
        await env.click(env.selector);
        assert.equal(
          env.calls.patch.length + env.calls.draft.length,
          removeGuard ? 1 : 0,
        );
      } finally {
        await env.dispose();
      }
    }
});

test("web and independent legacy projections keep their existing connector behavior while processing", async () => {
  for (const presentation of ["web-chat", "legacy"] as const) {
    const env = await mountedMenu(ComposerAddMenu, true, presentation);
    try {
      await env.busy("sending", true);
      await env.busy("prop", true);
      assert.equal(env.button().disabled, false);
      assert.equal(env.button().title, "");
      await env.click(env.selector);
      assert.equal(env.calls.patch.length, 1);
    } finally {
      await env.dispose();
    }
  }
});

test("Connectors → Tool access sets this conversation's choice, or the new chat's, and locks while processing", async () => {
  for (const active of [true, false]) {
    const menu = await mountedMenu(ComposerAddMenu, active, "native-chat");
    try {
      const trigger = Array.from(
        menu.document.querySelectorAll<HTMLButtonElement>(
          '[data-add-panel="connectors"] button[aria-haspopup="menu"]',
        ),
      ).find((button) => button.textContent?.includes("Tool access"))!;
      assert.ok(trigger);
      assert.equal(trigger.disabled, false);
      await act(async () => trigger.click());
      const choices = Array.from(
        menu.document.querySelectorAll<HTMLButtonElement>(
          '[aria-label="Tool access"] button[role="menuitemcheckbox"]',
        ),
      );
      assert.deepEqual(
        choices.map((choice) => [
          choice.querySelector("span > span")?.textContent,
          choice.getAttribute("aria-checked"),
        ]),
        [
          ["Load tools when needed", "true"],
          ["Tools already loaded", "false"],
        ],
      );
      await act(async () => choices[1].click());
      if (active)
        assert.deepEqual(menu.calls.patch, [{ toolSearchMode: "off" }]);
      else assert.deepEqual(menu.calls.draft, [{ toolSearchMode: "off" }]);
      await menu.busy("running", true);
      await act(async () => trigger.click());
      for (const choice of menu.document.querySelectorAll<HTMLButtonElement>(
        '[aria-label="Tool access"] button[role="menuitemcheckbox"]',
      ))
        assert.equal(choice.disabled, true);
    } finally {
      await menu.dispose();
    }
  }
});

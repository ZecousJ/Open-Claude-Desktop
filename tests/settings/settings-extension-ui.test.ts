import test from "node:test";
import assert from "node:assert/strict";
import { act, createElement as h } from "react";
import { routineDom } from "../support/routine-dom";
import InstalledExtensions from "../../src/settings/tabs/InstalledExtensions";
import { AppContext } from "../../src/app/AppContext";
import type { DesktopExtensionDetails } from "../../shared/desktop-extensions-api";

const details: DesktopExtensionDetails = {
  id: "demo",
  name: "Real extension",
  description: "Package description",
  version: "1.0",
  author: "Author",
  enabled: true,
  owned: true,
  configurable: true,
  uninstallable: true,
  revision: "a".repeat(64),
  tools: [],
  prompts: [],
  fields: [
    {
      key: "label",
      title: "Label",
      type: "string",
      required: true,
      sensitive: false,
    },
    {
      key: "token",
      title: "Token",
      type: "string",
      required: true,
      sensitive: true,
    },
  ],
  values: { label: "Existing" },
  savedSecrets: ["token"],
};
const button = (env: Awaited<ReturnType<typeof routineDom>>, name: string) =>
  [...env.document.querySelectorAll("button")].find(
    (value) => value.textContent?.trim() === name,
  )!;
async function environment(overrides: object = {}) {
  const env = await routineDom(
    {
      desktopExtensions: async () => [details],
      desktopExtension: async () => details,
      saveDesktopExtension: async () => details,
      uninstallDesktopExtension: async () => {},
      ...overrides,
    } as never,
    { jsdom: true },
  );
  const globals = {
    innerWidth: 1440,
    innerHeight: 900,
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
    Object.defineProperty(globalThis, key, { configurable: true, value });
  return {
    ...env,
    async clean() {
      await env.clean();
      for (const [key, descriptor] of saved) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}

const render = (
  env: Awaited<ReturnType<typeof routineDom>>,
  onError: (error: unknown) => void = (error) => {
    throw error;
  },
) => env.render(h(InstalledExtensions, { names: ["demo"], onError }));

test("mounted metadata and configuration preserve hidden secret and use actual revision API", async () => {
  const calls: unknown[] = [];
  const env = await environment({
    saveDesktopExtension: async (input: unknown) => {
      calls.push(input);
      return details;
    },
  });
  try {
    await render(env);
    assert.match(env.document.body.textContent!, /Real extension/);
    await env.event(button(env, "Configure"), "click");
    assert.match(env.document.body.textContent!, /Author/);
    const secret = env.document.querySelector<HTMLInputElement>(
      '[aria-label="Token"]',
    )!;
    assert.equal(secret.type, "password");
    assert.equal(secret.value, "");
    assert.equal(secret.placeholder, "Saved value");
    await env.change('[aria-label="Label"]', "Changed label");
    await env.event(env.document.querySelector("form")!, "submit");
    assert.deepEqual(calls, [
      {
        id: "demo",
        revision: details.revision,
        enabled: true,
        values: { label: "Changed label" },
      },
    ]);
  } finally {
    await env.clean();
  }
});

test("mounted uninstall asks before calling and removes through actual lifecycle API", async () => {
  const removed: unknown[] = [];
  const env = await environment({
    uninstallDesktopExtension: async (input: unknown) => {
      removed.push(input);
    },
  });
  try {
    await render(env);
    await env.event(
      env.document.querySelector(
        '[aria-label="More options for Real extension"]',
      )!,
      "click",
    );
    await env.event(button(env, "Details"), "click");
    await env.event(button(env, "Uninstall"), "click");
    assert.equal(removed.length, 0);
    assert.match(env.document.body.textContent!, /This removes the extension/);
    await env.event(button(env, "Cancel"), "click");
    assert.equal(removed.length, 0);
    await env.event(button(env, "Uninstall"), "click");
    await env.event(button(env, "Uninstall"), "click");
    assert.deepEqual(removed, [{ id: "demo", revision: details.revision }]);
    assert.equal(env.document.querySelector('[role="dialog"]'), null);
  } finally {
    await env.clean();
  }
});

test("read-only capability exposes details without Configure or Uninstall, and old bridge does not query", async () => {
  let queries = 0;
  const readonly = {
    ...details,
    configurable: false,
    uninstallable: false,
    blockedReason: "Extensions are disabled by your administrator.",
    configurationUnavailable:
      "Extension configuration is unavailable on this host.",
  };
  const env = await environment({
    desktopExtensions: async () => {
      queries++;
      return [readonly];
    },
    desktopExtension: async () => readonly,
  });
  try {
    await render(env);
    assert.equal(button(env, "Configure"), undefined);
    assert.match(env.document.body.textContent!, /Disabled/);
    await env.event(
      env.document.querySelector(
        '[aria-label="More options for Real extension"]',
      )!,
      "click",
    );
    await env.event(button(env, "Details"), "click");
    assert.equal(button(env, "Uninstall"), undefined);
    assert.match(
      env.document.body.textContent!,
      /configuration is unavailable/,
    );
    await env.render(h("div"));
    delete (env.window.desktop as any).saveDesktopExtension;
    await render(env);
    assert.equal(queries, 1);
    assert.equal(env.document.body.textContent!.trim(), "demo");
  } finally {
    await env.clean();
  }
});

test("late detail results from an old account do not render or enable mutations", async () => {
  let resolve!: (value: DesktopExtensionDetails) => void;
  let detailsReads = 0;
  const env = await environment({
    desktopExtension: () => {
      detailsReads++;
      return new Promise((done) => {
        resolve = done;
      });
    },
  });
  const controller = {
    accountId: "a",
    controllerScope: {},
    currentController: undefined,
  };
  const ref = { current: controller };
  Object.assign(controller, { currentController: ref });
  const show = () =>
    env.render(
      h(
        AppContext.Provider,
        { value: controller as never },
        h(InstalledExtensions, {
          names: ["demo"],
          onError: (error: unknown) => {
            throw error;
          },
        }),
      ),
    );
  try {
    await show();
    await env.event(
      env.document.querySelector(
        '[aria-label="More options for Real extension"]',
      )!,
      "click",
    );
    await env.event(button(env, "Details"), "click");
    ref.current = { ...controller, accountId: "b", controllerScope: {} };
    await act(async () => {
      resolve({ ...details, name: "Private old account" });
    });
    assert.equal(detailsReads, 1);
    assert.doesNotMatch(env.document.body.textContent!, /Private old account/);
    assert.equal(button(env, "Save"), undefined);
  } finally {
    await env.clean();
  }
});

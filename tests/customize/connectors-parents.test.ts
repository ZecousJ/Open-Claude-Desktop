import test from "node:test";
import assert from "node:assert/strict";
import { act, StrictMode, createElement as h, type ReactElement } from "react";
import { ConnectorsTab } from "../../src/settings/tabs/Connectors";
import { ServiceDirectory } from "../../src/collections/customize/ServiceDirectory";
import { AppContext, type AppController } from "../../src/app/AppContext";
import { HostContext } from "../../src/host/HostContext";
import { hostFor } from "../../shared/host";
import { defaultSettings } from "../../electron/store/store";
import type { Settings } from "../../shared/types";
import type { McpServerState } from "../../shared/settings-desktop-api";
import { routineDom } from "../support/routine-dom";
const url = "https://fixture.invalid/mcp";
const runtime: McpServerState = {
  name: "fixture",
  displayName: "Fixture",
  url,
  state: "failed",
  authStatus: "notLoggedIn",
  tools: 0,
};
const entry = {
  id: "fixture",
  name: "Fixture",
  description: "Synthetic parent directory",
  kind: "mcp" as const,
  added: "2026-10-19",
  url,
};
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
async function fixture(bridge: Partial<Window["desktop"]> = {}) {
  const errors: unknown[] = [],
    calls: unknown[] = [],
    listeners = new Set<Parameters<Window["desktop"]["onEvent"]>[0]>();
  let configured: McpServerState[] = [];
  const env = await routineDom(
    {
      linearStatus: async () => ({ connected: false }),
      listApprovedDirectory: async () => [entry],
      mcpServers: async () => ({ servers: configured, configPath: "" }),
      probeConnector: async () => ({ authRequired: true }),
      addCustomConnector: async (input) => {
        configured = [{ ...runtime, name: input.name, url: input.url }];
        return { servers: configured, configPath: "" };
      },
      connectConnector: async (...args) => {
        calls.push(args);
      },
      onEvent: (listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      ...bridge,
    },
    { jsdom: true },
  );
  const saved = new Map(
    ["innerWidth", "innerHeight", "sessionStorage", "location"].map((name) => [
      name,
      Object.getOwnPropertyDescriptor(globalThis, name),
    ]),
  );
  for (const [name, value] of Object.entries({
    innerWidth: 1280,
    innerHeight: 800,
    sessionStorage: env.window.sessionStorage,
    location: env.window.location,
  }))
    Object.defineProperty(globalThis, name, {
      configurable: true,
      writable: true,
      value,
    });
  const current: { current?: AppController } = {};
  const actor = (id: string) =>
    ({
      accountId: id,
      controllerScope: {},
      currentController: current,
      listed: [],
    }) as unknown as AppController;
  let app = actor("a");
  current.current = app;
  let child: ReactElement;
  const render = async (next: ReactElement) => {
    child = next;
    await env.render(
      h(
        StrictMode,
        null,
        h(
          AppContext.Provider,
          { value: app },
          h(HostContext.Provider, { value: hostFor("desktop") }, next),
        ),
      ),
    );
  };
  const button = (label: string) =>
    [...env.document.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.replace(/\s+/g, " ").trim() === label,
    )!;
  const cleanup = env.clean;
  return {
    ...env,
    render,
    button,
    errors,
    calls,
    listeners,
    async switchAccount() {
      app = actor("b");
      current.current = app;
      await render(child);
    },
    async clean() {
      await cleanup();
      for (const [name, descriptor] of saved) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    },
    setConfigured(servers: McpServerState[]) {
      configured = servers;
    },
  };
}
function connectors(
  f: Awaited<ReturnType<typeof fixture>>,
  settings: Settings = { ...defaultSettings, mcpServers: {} },
) {
  return h(ConnectorsTab, {
    settings,
    save() {},
    goTo() {},
    onError: (error) => f.errors.push(error),
  });
}
async function openWizard(
  f: Awaited<ReturnType<typeof fixture>>,
  parent: "settings" | "directory",
) {
  if (parent === "settings") {
    assert.ok(
      f.document.querySelector(".desktop-add-button"),
      f.document.body.textContent!.slice(0, 1800),
    );
    await f.event(f.document.querySelector(".desktop-add-button")!, "click");
    await f.event(f.button("Add custom connector"), "click");
  } else {
    assert.ok(
      f.document.querySelector(".customize-unavailable button"),
      f.document.body.textContent!.slice(0, 1800),
    );
    await f.event(
      f.document.querySelector(".customize-unavailable button")!,
      "click",
    );
  }
  await act(async () => {
    await import("../../src/settings/tabs/AddConnectorDialog");
  });
  const name = f.document.querySelector<HTMLInputElement>("#connector-name")!;
  if (name.value !== "fixture") await f.change("#connector-name", "fixture");
  const field = f.document.querySelector<HTMLInputElement>("#connector-url")!;
  if (field.value !== url) await f.change("#connector-url", url);
  await f.event(f.document.querySelector("form")!, "submit");
  assert.match(f.document.body.textContent!, /Step 2 of 2/);
}

test("both real parent Add callbacks transfer ownership before closing the wizard and continue OAuth", async () => {
  for (const parent of ["settings", "directory"] as const) {
    const pending = deferred<void>(),
      calls: unknown[] = [];
    const f = await fixture({
      connectConnector: (...args) => {
        calls.push(args);
        return pending.promise;
      },
    });
    try {
      await f.render(
        parent === "settings"
          ? connectors(f)
          : h(ServiceDirectory, {
              kind: "mcp",
              onError: (error) => f.errors.push(error),
            }),
      );
      await openWizard(f, parent);
      await f.event(f.document.querySelector("form")!, "submit");
      assert.equal(f.document.querySelector(".connector-wizard"), null);
      assert.equal(calls.length, 1);
      assert.equal((calls[0] as unknown[])[0], "fixture");
      await act(async () => pending.resolve());
      const action =
        parent === "settings"
          ? f.document.querySelector<HTMLButtonElement>(
              ".desktop-connector-buttons > button",
            )
          : f.document.querySelector<HTMLButtonElement>(
              ".customize-unavailable button",
            );
      assert.ok(action);
      assert.equal(
        action.disabled,
        false,
        "parent completes after child unmount",
      );
      assert.equal(f.errors.length, 0);
    } finally {
      await f.clean();
    }
  }
});

test("parent-owned handoffs suppress late OAuth errors after account replacement without clearing the new queue", async () => {
  for (const parent of ["settings", "directory"] as const) {
    const pending = deferred<void>(),
      calls: unknown[] = [];
    const f = await fixture({
      connectConnector: (...args) => {
        calls.push(args);
        return pending.promise;
      },
    });
    try {
      await f.render(
        parent === "settings"
          ? connectors(f)
          : h(ServiceDirectory, {
              kind: "mcp",
              onError: (error) => f.errors.push(error),
            }),
      );
      await openWizard(f, parent);
      await f.event(f.document.querySelector("form")!, "submit");
      assert.equal(calls.length, 1);
      await f.switchAccount();
      f.window.sessionStorage.setItem(
        "claudex:connector-reconnect",
        "replacement-account-queue",
      );
      await act(async () =>
        pending.reject(Error("retired parent private failure")),
      );
      assert.equal(f.errors.length, 0);
      assert.equal(
        f.window.sessionStorage.getItem("claudex:connector-reconnect"),
        "replacement-account-queue",
      );
      assert.doesNotMatch(
        f.document.body.textContent!,
        /retired parent private failure/,
      );
    } finally {
      await f.clean();
    }
  }
});

test("ServiceDirectory retires delayed configured-server reads and old catalogue errors", async () => {
  for (const phase of ["configured", "catalogue"] as const) {
    const pending = deferred<{
      servers: McpServerState[];
      configPath: string;
    }>();
    const catalogue = deferred<(typeof entry)[]>();
    let original = true;
    const f = await fixture({
      mcpServers: () => pending.promise,
      listApprovedDirectory: () =>
        !original
          ? Promise.resolve([])
          : phase === "catalogue"
            ? catalogue.promise
            : Promise.resolve([entry]),
    });
    try {
      await f.render(
        h(ServiceDirectory, {
          kind: "mcp",
          onError: (error) => f.errors.push(error),
        }),
      );
      if (phase === "configured")
        await f.event(
          f.document.querySelector(".customize-unavailable button")!,
          "click",
        );
      original = false;
      await f.switchAccount();
      await act(async () => {
        if (phase === "configured")
          pending.resolve({ servers: [runtime], configPath: "" });
        else catalogue.reject(Error("retired directory failure"));
      });
      assert.equal(f.document.querySelector(".connector-wizard"), null);
      assert.equal(f.errors.length, 0);
      assert.doesNotMatch(
        f.document.body.textContent!,
        /retired directory failure/,
      );
    } finally {
      await f.clean();
    }
  }
});

test("current directory failures recover through the real Retry action", async () => {
  let fail = true;
  const f = await fixture({
    listApprovedDirectory: async () => {
      if (fail) throw Error("synthetic catalogue failure");
      return [entry];
    },
  });
  try {
    await f.render(
      h(ServiceDirectory, {
        kind: "mcp",
        onError: (error) => f.errors.push(error),
      }),
    );
    assert.match(f.document.body.textContent!, /Couldn’t load connectors/);
    fail = false;
    await f.event(f.button("Try again"), "click");
    assert.match(f.document.body.textContent!, /Synthetic parent directory/);
    assert.equal(f.errors.length, 1);
  } finally {
    await f.clean();
  }
});

test("Connectors detail continues via a parent lease and drops delayed failure on target replacement", async () => {
  const pending = deferred<void>(),
    calls: unknown[] = [];
  const f = await fixture({
    connectConnector: (...args) => {
      calls.push(args);
      return pending.promise;
    },
  });
  f.setConfigured([runtime]);
  let settings: Settings = {
    ...defaultSettings,
    mcpServers: { fixture: { url } },
  };
  try {
    const customize = {
      section: "connectors" as const,
      view: "yours" as const,
      detailId: "installed:fixture",
      onOpen() {},
      onBack() {},
      renderBrowse: () => null,
    };
    await f.render(
      h(ConnectorsTab, {
        settings,
        save() {},
        goTo() {},
        onError: (error) => f.errors.push(error),
        customize,
      }),
    );
    await act(async () => {
      await import("../../src/settings/tabs/ConnectorDetail");
    });
    await f.event(f.button("Connect to Claudex"), "click");
    assert.equal(calls.length, 1);
    settings = {
      ...settings,
      mcpServers: {
        fixture: { url: "https://replacement.fixture.invalid/mcp" },
      },
    };
    await f.render(
      h(ConnectorsTab, {
        settings,
        save() {},
        goTo() {},
        onError: (error) => f.errors.push(error),
        customize,
      }),
    );
    await act(async () => pending.reject(Error("retired target failure")));
    assert.equal(f.errors.length, 0);
  } finally {
    await f.clean();
  }
});

test("the mounted parent retains actual MCP rows after failed refresh and reports one current outage", async () => {
  let fail = false;
  const f = await fixture({
    mcpServers: async () => {
      if (fail) throw Error("synthetic refresh failure");
      return { servers: [runtime], configPath: "" };
    },
  });
  try {
    await f.render(
      connectors(f, { ...defaultSettings, mcpServers: { fixture: { url } } }),
    );
    assert.match(f.document.body.textContent!, /Fixture/);
    fail = true;
    for (let count = 0; count < 2; count++)
      await act(async () => {
        for (const listener of f.listeners)
          listener({ type: "engine", engine: { state: "ready" } });
      });
    assert.match(f.document.body.textContent!, /Fixture/);
    assert.ok(f.document.querySelector(".desktop-connector-buttons"));
    assert.equal(f.errors.length, 1);
  } finally {
    await f.clean();
  }
});

test("a parent handoff retires when settings replace the target without locking new directory actions", async () => {
  const pending = deferred<void>();
  const f = await fixture({ connectConnector: () => pending.promise });
  try {
    await f.render(
      h(ServiceDirectory, {
        kind: "mcp",
        onError: (error) => f.errors.push(error),
      }),
    );
    await openWizard(f, "directory");
    await f.event(f.document.querySelector("form")!, "submit");
    assert.equal(
      f.document.querySelector<HTMLButtonElement>(
        ".customize-unavailable button",
      )!.disabled,
      true,
    );
    await act(async () => {
      for (const listener of f.listeners)
        listener({
          type: "settings",
          settings: {
            ...defaultSettings,
            mcpServers: {
              fixture: { url: "https://replacement.fixture.invalid/mcp" },
            },
          },
        });
    });
    assert.equal(
      f.document.querySelector<HTMLButtonElement>(
        ".customize-unavailable button",
      )!.disabled,
      false,
    );
    await act(async () => pending.reject(Error("stale target private error")));
    assert.equal(f.errors.length, 0);
  } finally {
    await f.clean();
  }
});

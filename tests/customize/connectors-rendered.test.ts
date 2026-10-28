import test from "node:test";
import assert from "node:assert/strict";
import { act, createElement as h, StrictMode, type ReactElement } from "react";
import AddConnectorDialog from "../../src/settings/tabs/AddConnectorDialog";
import ConnectorDetail from "../../src/settings/tabs/ConnectorDetail";
import { ConnectorReconnectRows } from "../../src/composer/ConnectorReconnectRows";
import { AppContext, type AppController } from "../../src/app/AppContext";
import type { McpServerState } from "../../shared/settings-desktop-api";
import { routineDom } from "../support/routine-dom";
const configured = { fixture: { url: "https://fixture.invalid/mcp" } };
const runtime: McpServerState = {
  name: "fixture",
  url: configured.fixture.url,
  state: "failed",
  authStatus: "notLoggedIn",
  tools: 0,
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
  const listeners = new Set<Parameters<Window["desktop"]["onEvent"]>[0]>();
  const env = await routineDom(
    {
      onEvent: (listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      probeConnector: async () => ({ authRequired: true }),
      addCustomConnector: async () => ({ servers: [runtime], configPath: "" }),
      mcpServers: async () => ({ servers: [runtime], configPath: "" }),
      connectConnector: async () => {},
      ...bridge,
    },
    { jsdom: true },
  );
  const current: { current?: AppController } = {};
  const actor = (id: string) =>
    ({
      accountId: id,
      controllerScope: {},
      currentController: current,
    }) as unknown as AppController;
  let app = actor("a");
  current.current = app;
  let element: ReactElement;
  const render = (child: ReactElement) => {
    element = child;
    return env.render(
      h(StrictMode, null, h(AppContext.Provider, { value: app }, child)),
    );
  };
  const button = (label: string) =>
    [...env.document.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.trim() === label,
    )!;
  return {
    ...env,
    render,
    button,
    listeners,
    async switchAccount() {
      app = actor("b");
      current.current = app;
      await render(element);
    },
    async emit(type: "service-changed" | "signed-out") {
      await act(async () => {
        for (const listener of listeners)
          listener(
            type === "signed-out"
              ? {
                  type,
                  reason: "session-expired",
                  message: "Synthetic sign-out",
                }
              : { type },
          );
      });
    },
  };
}
const wizardProps = {
  existingNames: [],
  existingIds: [],
  onClose() {},
  onAdded() {},
};
async function fillWizard(f: Awaited<ReturnType<typeof fixture>>) {
  await f.change("#connector-name", "Synthetic connector");
  await f.change("#connector-url", configured.fixture.url);
}

test("actual wizard probes, advances only on a valid result, freezes pending fields and retries create without losing input", async () => {
  const probe = deferred<{ authRequired: boolean }>(),
    create = deferred<{ servers: McpServerState[]; configPath: string }>();
  const calls: unknown[] = [],
    added: unknown[] = [];
  let creates = 0;
  const f = await fixture({
    probeConnector: (...args) => {
      calls.push(args);
      return probe.promise;
    },
    addCustomConnector: (input) => {
      calls.push(input);
      return ++creates === 1
        ? Promise.reject(Error("fixture create failed"))
        : create.promise;
    },
  });
  try {
    await f.render(
      h(AddConnectorDialog, {
        ...wizardProps,
        onAdded: (...args) => added.push(args),
      }),
    );
    await fillWizard(f);
    await f.event(f.document.querySelector("form")!, "submit");
    assert.equal(
      f.document.querySelector<HTMLInputElement>("#connector-url")!.disabled,
      true,
    );
    assert.equal(calls.length, 1);
    await act(async () => probe.resolve({ authRequired: true }));
    assert.match(f.document.body.textContent!, /Step 2 of 2/);
    assert.match(f.document.body.textContent!, /Sign in now/);
    await f.event(f.document.querySelector("form")!, "submit");
    assert.match(f.document.body.textContent!, /fixture create failed/);
    assert.match(f.document.body.textContent!, /Synthetic connector/);
    assert.equal(added.length, 0);
    await f.event(f.document.querySelector("form")!, "submit");
    await act(async () =>
      create.resolve({ servers: [runtime], configPath: "" }),
    );
    assert.equal(added.length, 1);
    assert.equal((added[0] as unknown[])[1], "Synthetic-connector");
  } finally {
    await f.clean();
  }
});

test("wizard account changes clear credentials and late probe/create success and errors cannot escape", async () => {
  for (const phase of ["probe", "create"] as const)
    for (const failure of [false, true]) {
      const pending = deferred<
          { authRequired: boolean } | { servers: McpServerState[] }
        >(),
        added: unknown[] = [];
      let begun = false;
      const f = await fixture({
        ...(phase === "probe"
          ? {
              probeConnector: () => {
                begun = true;
                return pending.promise as Promise<{ authRequired: boolean }>;
              },
            }
          : {
              addCustomConnector: () => {
                begun = true;
                return pending.promise as Promise<{
                  servers: McpServerState[];
                  configPath: string;
                }>;
              },
            }),
      });
      try {
        await f.render(
          h(AddConnectorDialog, {
            ...wizardProps,
            onAdded: (value) => added.push(value),
          }),
        );
        await fillWizard(f);
        await f.event(f.document.querySelector("form")!, "submit");
        if (phase === "create") {
          assert.match(f.document.body.textContent!, /Step 2 of 2/);
          await f.event(
            f.document.querySelector(".desktop-connector-advanced")!,
            "click",
          );
          await f.change(
            'input[aria-label="OAuth client ID (optional)"]',
            "synthetic-client",
          );
          await f.change('input[type="password"]', "synthetic-secret");
          await f.event(f.document.querySelector("form")!, "submit");
        }
        assert.equal(begun, true);
        await f.switchAccount();
        assert.equal(
          f.document.querySelector<HTMLInputElement>("#connector-name")!.value,
          "",
        );
        assert.doesNotMatch(f.document.body.textContent!, /Sign in now/);
        await act(async () => {
          if (failure) pending.reject(Error("retired private error"));
          else
            pending.resolve(
              phase === "probe"
                ? { authRequired: true }
                : { servers: [runtime] },
            );
        });
        assert.equal(added.length, 0);
        assert.doesNotMatch(
          f.document.body.textContent!,
          /retired private error|Step 2 of 2/,
        );
      } finally {
        await f.clean();
      }
    }
});

test("malformed probe responses remain an error on step one", async () => {
  const f = await fixture({
    probeConnector: async () => ({ authRequired: "yes" }) as never,
  });
  try {
    await f.render(h(AddConnectorDialog, wizardProps));
    await fillWizard(f);
    await f.event(f.document.querySelector("form")!, "submit");
    assert.match(f.document.body.textContent!, /invalid authentication result/);
    assert.match(f.document.body.textContent!, /Step 1 of 2/);
  } finally {
    await f.clean();
  }
});

test("composer reconnect uses actual auth status, not process failure; failure preserves the existing status and offers retry", async () => {
  const pending = deferred<void>();
  const toggles: unknown[] = [],
    calls: unknown[] = [];
  let reads = 0,
    failRead = false;
  const f = await fixture({
    mcpServers: async () => {
      reads++;
      if (failRead) throw Error("fixture status failed");
      return {
        servers: [
          runtime,
          {
            ...runtime,
            name: "failed",
            url: "https://failed.invalid/mcp",
            authStatus: undefined,
          },
        ],
        configPath: "",
      };
    },
    connectConnector: (...args) => {
      calls.push(args);
      return pending.promise;
    },
  });
  try {
    await f.render(
      h(ConnectorReconnectRows, {
        servers: {
          ...configured,
          failed: { url: "https://failed.invalid/mcp" },
        },
        onToggle: (...args) => toggles.push(args),
      }),
    );
    const rows = [...f.document.querySelectorAll<HTMLButtonElement>("button")];
    assert.equal(
      rows.filter(
        (row) => row.getAttribute("aria-label") === "Reconnect fixture",
      ).length,
      1,
    );
    assert.equal(
      rows
        .find((row) => row.textContent?.includes("failed"))!
        .getAttribute("role"),
      "menuitemcheckbox",
    );
    await f.event(
      f.document.querySelector('[aria-label="Reconnect fixture"]')!,
      "click",
    );
    assert.equal(calls.length, 1);
    assert.match(f.document.body.textContent!, /Connecting…/);
    await act(async () => pending.reject(Error("fixture reconnect failed")));
    assert.match(f.document.body.textContent!, /Failed to connect/);
    assert.doesNotMatch(
      f.document.body.textContent!,
      /fixture reconnect failed/,
    );
    assert.ok(f.document.querySelector('[aria-label="Reconnect fixture"]'));
    failRead = true;
    await f.event(f.button("Try again"), "click");
    assert.match(f.document.body.textContent!, /Couldn’t load connectors/);
    assert.doesNotMatch(f.document.body.textContent!, /fixture status failed/);
    assert.ok(f.document.querySelector('[aria-label="Reconnect fixture"]'));
    assert.equal(toggles.length, 0);
  } finally {
    await f.clean();
  }
});

test("composer late status and reconnect errors are retired; a new owner can act while the old request is pending", async () => {
  const old = deferred<void>();
  const errors: unknown[] = [];
  let calls = 0;
  const f = await fixture({
    connectConnector: () => (++calls === 1 ? old.promise : Promise.resolve()),
  });
  try {
    await f.render(
      h(ConnectorReconnectRows, {
        servers: configured,
        onToggle() {},
        onError: (error) => errors.push(error),
      }),
    );
    await f.event(
      f.document.querySelector('[aria-label="Reconnect fixture"]')!,
      "click",
    );
    await f.switchAccount();
    await f.event(
      f.document.querySelector('[aria-label="Reconnect fixture"]')!,
      "click",
    );
    assert.equal(calls, 2);
    await act(async () => old.reject(Error("old private reconnect failure")));
    assert.equal(errors.length, 0);
    assert.doesNotMatch(f.document.body.textContent!, /old private/);
  } finally {
    await f.clean();
  }
});

test("settings and Customize detail suppress retired connection errors", async () => {
  for (const presentation of ["settings", "customize"] as const) {
    const pending = deferred<void>(),
      errors: unknown[] = [];
    const f = await fixture();
    try {
      await f.render(
        h(ConnectorDetail, {
          server: runtime,
          editable: true,
          presentation,
          onBack() {},
          onSet() {},
          onConnect: () => pending.promise,
          onError: (error) => errors.push(error),
        }),
      );
      const connect =
        presentation === "settings"
          ? f.button("Reconnect")
          : f.button("Connect to Claudex");
      await f.event(connect, "click");
      await f.switchAccount();
      await act(async () => pending.reject(Error("retired detail failure")));
      assert.deepEqual(errors, []);
    } finally {
      await f.clean();
    }
  }
});

test("a retired status read cannot add a reconnect action to the replacement account", async () => {
  const pending = deferred<{ servers: McpServerState[]; configPath: string }>();
  let original = true;
  const f = await fixture({
    mcpServers: () =>
      original
        ? pending.promise
        : Promise.resolve({ servers: [], configPath: "" }),
  });
  try {
    await f.render(
      h(ConnectorReconnectRows, { servers: configured, onToggle() {} }),
    );
    assert.equal(
      f.document.querySelector('[aria-label="Reconnect fixture"]'),
      null,
    );
    original = false;
    await f.switchAccount();
    await act(async () =>
      pending.resolve({ servers: [runtime], configPath: "" }),
    );
    assert.equal(
      f.document.querySelector('[aria-label="Reconnect fixture"]'),
      null,
    );
  } finally {
    await f.clean();
  }
});

test("malformed create responses do not become success or erase the wizard input", async () => {
  let malformed = true;
  const added: unknown[] = [];
  const f = await fixture({
    addCustomConnector: async () =>
      malformed
        ? ({ servers: [null] } as never)
        : { servers: [runtime], configPath: "" },
  });
  try {
    await f.render(
      h(AddConnectorDialog, {
        ...wizardProps,
        onAdded: (data) => added.push(data),
      }),
    );
    await fillWizard(f);
    await f.event(f.document.querySelector("form")!, "submit");
    await f.event(f.document.querySelector("form")!, "submit");
    assert.match(f.document.body.textContent!, /invalid server list/);
    assert.equal(added.length, 0);
    assert.match(f.document.body.textContent!, /Step 2 of 2/);
    malformed = false;
    await f.event(f.document.querySelector("form")!, "submit");
    assert.equal(added.length, 1);
  } finally {
    await f.clean();
  }
});

test("malformed status retries preserve the last actual authentication result", async () => {
  let malformed = false;
  const f = await fixture({
    mcpServers: async () =>
      malformed
        ? ({ servers: [null] } as never)
        : { servers: [runtime], configPath: "" },
    connectConnector: async () => {
      throw Error("fixture auth failed");
    },
  });
  try {
    await f.render(
      h(ConnectorReconnectRows, { servers: configured, onToggle() {} }),
    );
    await f.event(
      f.document.querySelector('[aria-label="Reconnect fixture"]')!,
      "click",
    );
    malformed = true;
    await f.event(f.button("Try again"), "click");
    assert.match(f.document.body.textContent!, /Couldn’t load connectors/);
    assert.doesNotMatch(f.document.body.textContent!, /invalid server list/);
    assert.ok(f.document.querySelector('[aria-label="Reconnect fixture"]'));
  } finally {
    await f.clean();
  }
});

test("engine readiness re-reads actual OAuth status and disabled conversation overrides remain switches", async () => {
  let authenticated = false;
  const f = await fixture({
    mcpServers: async () => ({
      servers: [
        {
          ...runtime,
          state: "ready",
          authStatus: authenticated ? "oAuth" : "notLoggedIn",
        },
      ],
      configPath: "",
    }),
  });
  try {
    await f.render(
      h(ConnectorReconnectRows, {
        servers: configured,
        enabledOverrides: { fixture: false },
        onToggle() {},
      }),
    );
    assert.equal(
      f.document.querySelector('[aria-label="Reconnect fixture"]'),
      null,
    );
    assert.equal(
      f.document
        .querySelector('[role="menuitemcheckbox"]')
        ?.getAttribute("aria-checked"),
      "false",
    );
    await f.render(
      h(ConnectorReconnectRows, { servers: configured, onToggle() {} }),
    );
    assert.ok(f.document.querySelector('[aria-label="Reconnect fixture"]'));
    authenticated = true;
    await act(async () => {
      for (const listener of f.listeners)
        listener({ type: "engine", engine: { state: "ready" } });
    });
    assert.equal(
      f.document.querySelector('[aria-label="Reconnect fixture"]'),
      null,
    );
    assert.equal(
      f.document
        .querySelector('[role="menuitemcheckbox"]')
        ?.getAttribute("aria-checked"),
      "true",
    );
  } finally {
    await f.clean();
  }
});

import test from "node:test";
import assert from "node:assert/strict";
import { captureConnectorContext } from "../../electron/connectors/connector-owner";
import { canReconnectConnector } from "../../src/composer/connector-auth";
import { connectCustomConnector } from "../../src/settings/tabs/connector-login";
import type { McpServerState } from "../../shared/settings-desktop-api";
import type { ConnectorOperation } from "../../src/settings/connector-owner";
import { routineDom } from "../support/routine-dom";

test("server-owned connector context rejects account, store, engine, remote, generation and resource retirement", () => {
  const initial = {
    accountId: "a",
    store: {},
    engine: {},
    remote: {},
    generation: 1,
    operation: 1,
    configuration: {},
    origin: "https://service.fixture.invalid",
    resource: "fixture:https://fixture.invalid/mcp",
  };
  for (const change of [
    { accountId: "b" },
    { store: {} },
    { engine: {} },
    { remote: {} },
    { generation: 2 },
    { operation: 2 },
    { configuration: {} },
    { origin: "https://other-service.fixture.invalid" },
    { resource: "fixture:https://other.invalid/mcp" },
  ]) {
    let current = { ...initial };
    const scope = captureConnectorContext(() => current);
    assert.equal(scope.current(), true);
    current = { ...current, ...change };
    assert.equal(scope.current(), false);
    assert.throws(scope.assertCurrent, /retired/);
  }
  assert.equal(
    captureConnectorContext(() => ({
      ...initial,
      accountId: undefined,
    })).current(),
    false,
  );
});

test("reconnect eligibility requires explicit notLoggedIn on the same supported OAuth URL", () => {
  const configured = { url: "https://fixture.invalid/mcp" };
  const actual = {
    name: "fixture",
    url: configured.url,
    state: "failed",
    authStatus: "notLoggedIn",
    tools: 0,
  } as McpServerState;
  assert.equal(canReconnectConnector(actual, configured, true), true);
  for (const authStatus of [
    undefined,
    "unsupported",
    "oAuth",
    "bearerToken",
  ] as const)
    assert.equal(
      canReconnectConnector({ ...actual, authStatus }, configured, true),
      false,
    );
  assert.equal(canReconnectConnector(actual, configured, false), false);
  assert.equal(
    canReconnectConnector(actual, { url: "https://other.invalid/mcp" }, true),
    false,
  );
  assert.equal(
    canReconnectConnector({ ...actual, state: "disabled" }, configured, true),
    false,
  );
  assert.equal(
    canReconnectConnector(actual, { ...configured, enabled: false }, true),
    false,
  );
  assert.equal(
    canReconnectConnector(
      { ...actual, url: "https://user:secret@fixture.invalid/mcp" },
      { url: "https://user:secret@fixture.invalid/mcp" },
      true,
    ),
    false,
  );
});

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
test("OAuth handoff uses the captured bridge and validates returned destinations; retired results and errors cannot navigate", async () => {
  const calls: unknown[] = [],
    navigations: string[] = [];
  let address = "https://auth.fixture.invalid/authorize";
  const env = await routineDom(
    {
      connectConnector: async (...args) => {
        calls.push(args);
        return address;
      },
    },
    { jsdom: true },
  );
  try {
    let active = true;
    const operation: ConnectorOperation = {
      bridge: env.window.desktop,
      current: () => active,
      assertCurrent() {
        assert.equal(active, true);
      },
    };
    await connectCustomConnector("fixture", false, operation, (url) =>
      navigations.push(url),
    );
    assert.deepEqual(calls[0], [
      "fixture",
      "http://localhost/?cowork_connector=1&connector=installed%3Afixture",
    ]);
    assert.deepEqual(navigations, [address]);
    for (const invalid of [
      "javascript:alert(1)",
      "file:///tmp/private",
      "https://user:secret@auth.fixture.invalid/",
      "http://remote.invalid/",
    ]) {
      address = invalid;
      await assert.rejects(
        connectCustomConnector("fixture", false, operation, (url) =>
          navigations.push(url),
        ),
        /supported sign-in page/,
      );
    }
    const pending = deferred<string>();
    env.window.desktop.connectConnector = () => pending.promise;
    const late = connectCustomConnector("fixture", false, operation, (url) =>
      navigations.push(url),
    );
    active = false;
    pending.resolve("https://auth.fixture.invalid/late");
    await late;
    assert.equal(navigations.length, 1);
    active = true;
    const failed = deferred<never>();
    env.window.desktop.connectConnector = () => failed.promise;
    const oldFailure = connectCustomConnector(
      "fixture",
      false,
      operation,
      (url) => navigations.push(url),
    );
    active = false;
    failed.reject(Error("private retired error"));
    await oldFailure;
  } finally {
    await env.clean();
  }
});

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { Store } from "../../electron/store/store";
import { McpConfigFile } from "../../electron/connectors/mcp-config-file";
import { ConnectorClients } from "../../electron/connectors/connector-clients";
import { openPolicy, lockedPolicy } from "../../shared/client-policy";
import { useElectronShim } from "../runner/runner-core-support.test.ts";
useElectronShim();
const { registerSettingsDesktopHandlers } =
  await import("../../electron/ipc/settings-desktop");
const { desktopConnectorLogin } =
  await import("../../electron/connectors/connector-auth");
const { webCallScope } = await import("../../runner/src/electron-shim");
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const input = {
  name: "fixture",
  displayName: "Fixture",
  url: "https://fixture.invalid/mcp",
  clientId: "synthetic-client",
  clientSecret: "synthetic-secret",
};
function fixture(t: test.TestContext) {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "connectors-b34-ipc-")),
  );
  const stores = [
    new Store(path.join(root, "a")),
    new Store(path.join(root, "b")),
  ];
  for (const store of stores) {
    store.flush = () => {};
    store.settings.mcpServers = {};
  }
  const configs = stores.map(
    (store) =>
      new McpConfigFile(
        store.root,
        () => store.settings.mcpServers,
        (servers) => {
          store.settings.mcpServers = servers;
        },
      ),
  );
  let store = stores[0],
    config = configs[0],
    accountId = "a",
    policy = openPolicy;
  let engine = {
    state: { state: "stopped" },
    rpc: undefined as
      { call(method: string, params: unknown): Promise<any> } | undefined,
    mcpStartup: new Map(),
  };
  let remote = { accounts: { baseUrl: "https://service.fixture.invalid" } };
  const tokenCalls: unknown[] = [],
    deactivations: (() => unknown)[] = [];
  let connectors: any = {
    assertUrl: async () => {},
    setToken: (...args: unknown[]) => tokenCalls.push(args),
  };
  const ctx = {
    get store() {
      return store;
    },
    get engine() {
      return engine;
    },
    get remote() {
      return remote;
    },
    get activeAccount() {
      return { id: accountId };
    },
    get mcpConfig() {
      return config;
    },
    get connectors() {
      return connectors;
    },
    policy: () => policy,
    dataRoot: root,
    callerWindow: () => undefined,
    onAccountActivated() {
      return () => {};
    },
    onAccountDeactivating: (callback: () => unknown) => {
      deactivations.push(callback);
      return () => {};
    },
  };
  const handlers = new Map<string, (...args: any[]) => any>();
  registerSettingsDesktopHandlers(
    (name, action) => handlers.set(name, action),
    ctx as never,
  );
  const deactivate = async () => {
    for (const callback of deactivations) await callback();
  };
  t.after(async () => {
    await deactivate();
    for (const config of configs) config.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return {
    ctx,
    root,
    stores,
    configs,
    tokenCalls,
    deactivate,
    call: (name: string, ...args: unknown[]) => handlers.get(name)!(...args),
    setGuard: (guard: (url: string) => Promise<void>) => {
      connectors.assertUrl = guard;
    },
    setConnectors(value: any) {
      connectors = value;
    },
    setPolicy(value: typeof openPolicy) {
      policy = value;
    },
    setRpc(call: (method: string, params: unknown) => Promise<any>) {
      engine = { ...engine, state: { state: "ready" }, rpc: { call } };
    },
    async switchAccount() {
      await deactivate();
      store = stores[1];
      config = configs[1];
      accountId = "b";
      engine = {
        state: { state: "stopped" },
        rpc: undefined,
        mcpStartup: new Map(),
      };
      remote = { accounts: { baseUrl: "https://service.fixture.invalid" } };
      connectors = {
        assertUrl: async () => {},
        setToken: (...args: unknown[]) => tokenCalls.push(args),
      };
    },
  };
}

test("actual add IPC rejects delayed account switch before credentials, config or tokens are written", async (t) => {
  const f = fixture(t),
    pending = deferred<void>();
  f.setGuard(() => pending.promise);
  const request = f.call("addCustomConnector", {
    ...input,
    bearerToken: "synthetic-bearer",
  });
  await f.switchAccount();
  pending.resolve();
  await assert.rejects(request, /retired/);
  for (const store of f.stores) {
    assert.deepEqual(store.settings.mcpServers, {});
    assert.equal(
      fs.existsSync(path.join(store.root, "connector-clients.json")),
      false,
    );
    assert.equal(
      fs.existsSync(path.join(store.root, "mcp-config.json")),
      false,
    );
  }
  assert.deepEqual(f.tokenCalls, []);
});

test("actual add IPC permits same-owner commit with private clients and real persisted config", async (t) => {
  const f = fixture(t);
  const result = await f.call("addCustomConnector", input);
  assert.equal(result.servers[0].name, input.name);
  assert.equal(
    new ConnectorClients(f.stores[0].root).get(input.name, input.url)
      ?.clientSecret,
    "synthetic-secret",
  );
  const config = fs.readFileSync(f.configs[0].path, "utf8");
  assert.match(config, /fixture.invalid/);
  assert.doesNotMatch(config, /synthetic-secret|synthetic-client/);
  assert.deepEqual(f.stores[1].settings.mcpServers, {});
});

test("actual add IPC detects same-profile ABA deactivation and late private rejection", async (t) => {
  for (const reject of [false, true]) {
    const f = fixture(t),
      pending = deferred<void>();
    f.setGuard(() => pending.promise);
    const result = f.call("addCustomConnector", input);
    await f.deactivate();
    if (reject) pending.reject(Error("private retired request failure"));
    else pending.resolve();
    await assert.rejects(result, /retired/);
    assert.deepEqual(f.stores[0].settings.mcpServers, {});
  }
});

test("actual add IPC rechecks current policy and cannot overwrite a concurrent configuration edit", async (t) => {
  for (const reason of ["policy", "configuration"] as const) {
    const f = fixture(t),
      pending = deferred<void>();
    f.setGuard(() => pending.promise);
    const result = f.call("addCustomConnector", input);
    if (reason === "policy") f.setPolicy(lockedPolicy);
    else
      f.configs[0].update({
        other: { url: "https://other.fixture.invalid/mcp" },
      });
    pending.resolve();
    await assert.rejects(
      result,
      reason === "policy"
        ? /administrator|managed|allow|policy|disabled/i
        : /configuration changed/,
    );
    assert.equal(f.stores[0].settings.mcpServers.fixture, undefined);
    assert.equal(
      fs.existsSync(path.join(f.stores[0].root, "connector-clients.json")),
      false,
    );
  }
});

test("a newer create operation supersedes an older same-target request without duplicate writes", async (t) => {
  const f = fixture(t),
    first = deferred<void>();
  let guards = 0;
  f.setGuard(() => (++guards === 1 ? first.promise : Promise.resolve()));
  const old = f.call("addCustomConnector", input);
  await f.call("addCustomConnector", {
    ...input,
    clientSecret: "newer-synthetic-secret",
  });
  first.resolve();
  await assert.rejects(old, /retired/);
  assert.equal(
    new ConnectorClients(f.stores[0].root).get(input.name, input.url)
      ?.clientSecret,
    "newer-synthetic-secret",
  );
});

test("runner OAuth begin and completion reject a retired owner before history or result publication", async (t) => {
  for (const phase of ["begin", "complete"] as const) {
    const f = fixture(t),
      pending = deferred<string>();
    f.stores[0].settings.mcpServers = { fixture: { url: input.url } };
    f.setConnectors({
      assertUrl: async () => {},
      setToken() {},
      beginLogin: () => pending.promise,
      completeLogin: () => pending.promise,
    });
    const request =
      phase === "begin"
        ? f.call(
            "connectConnector",
            "fixture",
            "https://app.fixture.invalid/settings",
          )
        : f.call("completeConnectorLogin", "synthetic-state", "synthetic-code");
    await f.switchAccount();
    pending.resolve(
      phase === "begin" ? "https://auth.fixture.invalid/" : "fixture",
    );
    await assert.rejects(request, /retired/);
    for (const store of f.stores)
      assert.equal(
        fs.existsSync(path.join(store.root, "connector-history.json")),
        false,
      );
  }
});

test("runner OAuth same-owner completion persists actual connection history", async (t) => {
  const f = fixture(t);
  f.stores[0].settings.mcpServers = { fixture: { url: input.url } };
  f.setConnectors({
    assertUrl: async () => {},
    setToken() {},
    completeLogin: async () => "fixture",
  });
  assert.equal(
    await f.call("completeConnectorLogin", "state", "code"),
    "fixture",
  );
  assert.equal(
    fs.existsSync(path.join(f.stores[0].root, "connector-history.json")),
    true,
  );
});

test("RPC OAuth URL cannot open after account retirement or target replacement", async (t) => {
  for (const reason of ["account", "target", "rpc"] as const) {
    const f = fixture(t),
      pending = deferred<{ authorizationUrl: string }>();
    f.stores[0].settings.mcpServers = { fixture: { url: input.url } };
    f.setConnectors(undefined);
    f.setRpc(async (method) => {
      assert.equal(method, "mcpServer/oauth/login");
      return pending.promise;
    });
    const opened: string[] = [];
    const request = webCallScope.run(
      { userId: 1, openUrl: (url) => opened.push(url) },
      () => f.call("connectConnector", "fixture"),
    );
    if (reason === "account") await f.switchAccount();
    else if (reason === "rpc")
      f.ctx.engine.rpc = { call: async () => ({ data: [] }) };
    else
      f.stores[0].settings.mcpServers = {
        fixture: { url: "https://replacement.fixture.invalid/mcp" },
      };
    pending.resolve({ authorizationUrl: "https://auth.fixture.invalid/" });
    await assert.rejects(request, /retired|configuration changed/);
    assert.deepEqual(opened, []);
  }
});

test("desktop helper refuses a delayed session startup before reading replacement credentials or starting OAuth", async (t) => {
  const f = fixture(t),
    entered = deferred<void>(),
    release = deferred<void>();
  f.stores[0].settings.mcpServers = { fixture: { url: input.url } };
  const listen = http.Server.prototype.listen;
  t.mock.method(
    http.Server.prototype,
    "listen",
    function (this: http.Server, ...args: any[]) {
      const callback = args.pop() as () => void;
      return Reflect.apply(listen, this, [
        ...args,
        () => {
          entered.resolve();
          void release.promise.then(callback);
        },
      ]);
    },
  );
  const request = desktopConnectorLogin(f.ctx as never, "fixture", input.url);
  await entered.promise;
  await f.switchAccount();
  release.resolve();
  await assert.rejects(request, /retired/);
  assert.equal(
    fs.existsSync(path.join(f.stores[1].root, "connector-clients.json")),
    false,
  );
});

test("immediate desktop session retirement rejects pending startup and closes its listener", async (t) => {
  const f = fixture(t);
  f.stores[0].settings.mcpServers = { fixture: { url: input.url } };
  const request = desktopConnectorLogin(f.ctx as never, "fixture", input.url);
  await f.switchAccount();
  await assert.rejects(request, /retired/);
});

test("actual RPC OAuth handler validates external handoffs before opening any browser", async (t) => {
  for (const address of [
    "javascript:alert(1)",
    "http://remote.fixture.invalid/",
    "https://user:secret@auth.fixture.invalid/",
  ]) {
    const f = fixture(t);
    f.stores[0].settings.mcpServers = { fixture: { url: input.url } };
    f.setConnectors(undefined);
    f.setRpc(async () => ({ authorizationUrl: address }));
    const opened: string[] = [];
    await assert.rejects(
      webCallScope.run({ userId: 1, openUrl: (url) => opened.push(url) }, () =>
        f.call("connectConnector", "fixture"),
      ),
      /sign-in page/,
    );
    assert.deepEqual(opened, []);
  }
});

test("actual status IPC propagates runtime failure and rejects late results, late errors and RPC replacement", async (t) => {
  for (const outcome of [
    "failure",
    "late-result",
    "late-error",
    "rpc",
  ] as const) {
    const f = fixture(t),
      pending = deferred<{ data: unknown[] }>();
    f.stores[0].settings.mcpServers = { fixture: { url: input.url } };
    f.setRpc(() => pending.promise);
    const request = f.call("mcpServers");
    if (outcome === "late-result" || outcome === "late-error")
      await f.switchAccount();
    if (outcome === "rpc")
      f.ctx.engine.rpc = { call: async () => ({ data: [] }) };
    if (outcome === "failure" || outcome === "late-error")
      pending.reject(Error("synthetic runtime failure"));
    else
      pending.resolve({
        data: [{ name: "fixture", authStatus: "notLoggedIn" }],
      });
    await assert.rejects(
      request,
      outcome === "failure" ? /synthetic runtime failure/ : /retired/,
    );
  }
});

test("actual status IPC returns genuine authentication metadata and never fabricates success for malformed data", async (t) => {
  const f = fixture(t);
  f.stores[0].settings.mcpServers = { fixture: { url: input.url } };
  f.setRpc(async () => ({
    data: [{ name: "fixture", authStatus: "notLoggedIn", tools: {} }],
  }));
  assert.equal(
    (await f.call("mcpServers")).servers[0].authStatus,
    "notLoggedIn",
  );
  for (const data of [undefined, {}, [null]]) {
    f.setRpc(async () => ({ data }));
    await assert.rejects(f.call("mcpServers"), /invalid server list/);
  }
});

test("actual probe IPC cannot publish a delayed authentication challenge to a replacement account", async (t) => {
  const f = fixture(t),
    response = deferred<Response>();
  f.setConnectors({
    assertUrl: async () => {},
    setToken() {},
    fetch: () => response.promise,
  });
  const result = f.call(
    "probeConnector",
    input.url,
    "fixture",
    "streamable-http",
  );
  await f.switchAccount();
  response.resolve(
    new Response("", {
      status: 401,
      headers: { "WWW-Authenticate": "Bearer" },
    }),
  );
  await assert.rejects(result, /retired/);
});

/**
 * Settings → Capabilities → Allow network egress on this computer (settings
 * 25): Chat's code reaches the listed domains through a Codex permission
 * profile, all domains through the sandbox's network, nothing when off.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import TOML from "@iarna/toml";
import { Engine } from "../../electron/engine/engine";
import { Store } from "../../electron/store/store";
import { openPolicy } from "../../shared/client-policy";
import {
  egressProfileConfig,
  egressProfileId,
  localEgress,
} from "../../shared/local-egress";

test("the settings become a domain profile, all domains, or nothing", () => {
  assert.deepEqual(localEgress({ networkEgress: false }), { kind: "off" });
  assert.deepEqual(
    localEgress({ networkEgress: true, egressAllowlist: "all" }),
    { kind: "all" },
  );
  const none = localEgress({
    networkEgress: true,
    egressAllowlist: "none",
    egressDomains: ["Example.com", "*.example.org"],
  });
  assert.deepEqual(none, {
    kind: "profile",
    domains: { "*.example.org": "allow", "example.com": "allow" },
  });
  // Package managers: the name and its subdomains (Codex matches `*.name`
  // for subdomains only).
  const packages = localEgress({});
  assert.equal(packages.kind, "profile");
  if (packages.kind === "profile") {
    assert.equal(packages.domains["pypi.org"], "allow");
    assert.equal(packages.domains["*.pypi.org"], "allow");
    assert.equal(packages.domains["example.com"], undefined);
  }
  assert.deepEqual(egressProfileConfig({ kind: "all" }), {});
  assert.deepEqual(egressProfileConfig(none), {
    default_permissions: ":workspace",
    features: { network_proxy: true },
    permissions: {
      [egressProfileId]: {
        extends: ":workspace",
        network: {
          enabled: true,
          domains: { "*.example.org": "allow", "example.com": "allow" },
        },
      },
    },
  });
});

function setup() {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "claudex-local-egress-")),
  );
  const profile = path.join(root, "profile");
  fs.mkdirSync(profile);
  const work = path.join(root, "work");
  fs.mkdirSync(work);
  const store = new Store(profile);
  store.settings = {
    ...store.settings,
    sandbox: "workspace-write",
    chatExecution: true,
  };
  const engine = new Engine(
    store,
    "unused",
    () => "",
    () => {},
  );
  engine.policy = () => openPolicy;
  engine.localEgress = true;
  (engine as any).startedEgressProfile = true;
  engine.ensure = async () => {};
  const turns: any[] = [];
  let threads = 0;
  engine.rpc = {
    async call(method: string, params: any) {
      if (method === "turn/start") turns.push(structuredClone(params));
      if (method === "thread/start" || method === "thread/fork")
        return { thread: { id: `thread-${++threads}` } };
      if (method === "turn/start")
        return { turn: { id: `turn-${turns.length}` } };
      return {};
    },
    respond() {},
    reject() {},
  } as any;
  (engine as any).windowsSandbox = { assertReady() {}, async ensureReady() {} };
  return {
    engine,
    store,
    work,
    turns,
    send: (mode: "chat" | "code" = "chat") =>
      engine.send({
        text: "Hello",
        mode,
        cwd: work,
        attachments: [],
        providerId: "default",
        model: "m",
      }),
    close() {
      store.flush();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

const originalPlatform = process.platform;
test.before(() =>
  Object.defineProperty(process, "platform", { value: "linux" }),
);
test.after(() =>
  Object.defineProperty(process, "platform", { value: originalPlatform }),
);

test("a Chat turn on this computer uses the egress profile for a domain list", async () => {
  const env = setup();
  try {
    await env.send();
    const turn = env.turns.at(-1);
    assert.equal(turn.permissions, egressProfileId);
    assert.equal(turn.sandboxPolicy, undefined);
    assert.equal(
      turn.runtimeWorkspaceRoots[0],
      turn.cwd ?? turn.runtimeWorkspaceRoots[0],
    );
    assert.ok(turn.runtimeWorkspaceRoots.length >= 1);
  } finally {
    env.close();
  }
});

test("All domains opens the sandbox's network; off and a not-yet-restarted agent keep it closed", async () => {
  const env = setup();
  try {
    env.store.settings = { ...env.store.settings, egressAllowlist: "all" };
    await env.send();
    assert.equal(env.turns.at(-1).permissions, undefined);
    assert.equal(env.turns.at(-1).sandboxPolicy.networkAccess, true);
    env.store.settings = { ...env.store.settings, networkEgress: false };
    await env.send();
    assert.equal(env.turns.at(-1).permissions, undefined);
    assert.equal(env.turns.at(-1).sandboxPolicy.networkAccess, false);
    env.store.settings = {
      ...env.store.settings,
      networkEgress: true,
      egressAllowlist: "packages",
    };
    (env.engine as any).startedEgressProfile = false;
    await env.send();
    assert.equal(env.turns.at(-1).permissions, undefined);
    assert.equal(env.turns.at(-1).sandboxPolicy.networkAccess, false);
  } finally {
    env.close();
  }
});

test("Code turns and engines without local egress (the web runner) are unchanged", async () => {
  const env = setup();
  try {
    env.store.settings = {
      ...env.store.settings,
      codeSandbox: "workspace-write",
      codePlanMode: false,
    };
    await env.send("code");
    assert.equal(env.turns.at(-1).permissions, undefined);
    env.engine.localEgress = false;
    await env.send();
    assert.equal(env.turns.at(-1).permissions, undefined);
  } finally {
    env.close();
  }
});

// The real Codex reads the profile and its proxy lets through only the list.
const codex = spawnSync("codex", ["--version"], { encoding: "utf8" });
test(
  "the installed Codex accepts the written profile",
  { skip: codex.status !== 0 },
  () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-egress-home-"));
    try {
      const config = egressProfileConfig(
        localEgress({
          networkEgress: true,
          egressAllowlist: "none",
          egressDomains: ["example.com"],
        }),
      );
      fs.writeFileSync(
        path.join(home, "config.toml"),
        TOML.stringify(config as any),
      );
      const result = spawnSync("codex", ["features", "list"], {
        encoding: "utf8",
        env: { ...process.env, CODEX_HOME: home },
      });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /network_proxy\s+\S+\s+true/);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  },
);

test("Windows keeps Chat's code offline until its sandbox's proxy is verified", async () => {
  const env = setup();
  try {
    Object.defineProperty(process, "platform", { value: "win32" });
    await env.send();
    assert.equal(env.turns.at(-1).permissions, undefined);
    assert.equal(env.turns.at(-1).sandboxPolicy.networkAccess, false);
  } finally {
    Object.defineProperty(process, "platform", { value: "linux" });
    env.close();
  }
});

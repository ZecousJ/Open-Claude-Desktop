/**
 * Package C2: the administrator's policy from a Claudex service (bootstrap,
 * then `GET /claudex/policy` with ETag), its cache on disk, the offline
 * policy, and Bypass permissions staying the user's own choice throughout.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RemoteAccounts } from "../../electron/sub2api/identity";
import { RemoteBackend, type KeyStore } from "../../electron/sub2api/backend";
import { RemoteHost } from "../../electron/remote/host";
import { createPolicyHost } from "../../electron/remote/host-wiring";
import { ServerPolicySource } from "../../electron/account/client-policy";
import {
  PolicyCache,
  policyCacheFileName,
} from "../../electron/account/policy-cache";
import type { AppContext } from "../../electron/app/app-context";
import { Store } from "../../electron/store/store";
import {
  modeAllowed,
  permissionModeOf,
  type ClientPolicy,
} from "../../shared/client-policy";
import type { AppEvent } from "../../shared/types";
import { servicePolicyWire } from "../../scripts/preview/fixtures/policy-data";
import {
  MockSub2Api,
  fakeCipher,
  type MockOptions,
} from "../support/sub2api-mock";

const user = { id: 3, email: "bob@example.test", password: "bob-password" };
const pro = {
  id: 4,
  name: "claudex-pro",
  platform: "openai",
  subscription_type: "subscription",
  status: "active",
};

function keys(): KeyStore {
  const stored: Record<string, string> = {};
  return {
    canPersist: true,
    has: (id) => !!stored[id],
    async setKeys(patch) {
      Object.assign(stored, patch);
      return {};
    },
    async remote(provider, route) {
      const response = await fetch(`${provider.baseUrl}/${route}`, {
        headers: { Authorization: `Bearer ${stored[provider.id] ?? ""}` },
      });
      const body = await response.text();
      return route === "models" && response.ok
        ? {
            ok: true,
            status: 200,
            models: JSON.parse(body).data.map((m: { id: string }) => m.id),
          }
        : { ok: response.ok, status: response.status, body };
    },
  };
}

/** A signed-in remote account with its policy host, as main.ts assembles it. */
async function openAccount(options: MockOptions = {}) {
  const mock = new MockSub2Api({
    users: [user],
    userApiKeys: false,
    registrationThrottle: false,
    groups: [pro],
    subscriptions: [{ id: 77, group_id: 4, status: "active" }],
    models: { status: 200, body: { data: [{ id: "gpt-5.5" }] } },
    ...options,
  });
  await mock.start();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-policy-"));
  const accounts = new RemoteAccounts(root, mock.url, fakeCipher);
  const result = await accounts.login(user.email, user.password);
  if (result.kind !== "signedIn") throw Error("expected sign-in");
  const backend = new RemoteBackend(accounts, result.session, root);
  await backend.prepare(keys());
  const store = new Store(path.join(root, "profile"));
  store.settings.mcpServers = { docs: { command: "docs-mcp" } } as never;
  const events: AppEvent[] = [];
  const focus = new Set<() => void>();
  let changedSettings = 0;
  let host: ReturnType<typeof createPolicyHost> | undefined;
  const engine = {
    policy: (): ClientPolicy => {
      throw Error("unbound");
    },
    modelLimits: (_p: string, _m: string): unknown => undefined,
  };
  const members: Record<string, unknown> = {
    store,
    engine,
    dataRoot: root,
    appVersion: "0.0.1",
    // Set once the account opened, as main.ts does after the policy host.
    activeAccount: undefined,
    mcpConfig: undefined,
    push: (event: AppEvent) => events.push(event),
    settingsChanged: () => changedSettings++,
    onWindowFocus: (cb: () => void) => {
      focus.add(cb);
      return () => focus.delete(cb);
    },
    policy: () => host!.current(),
  };
  const ctx = new Proxy(members, {
    get: (target, key) =>
      key in target
        ? target[key as string]
        : () => {
            throw Error(`AppContext.${String(key)} is not faked`);
          },
  }) as unknown as AppContext;
  const remote = new RemoteHost(ctx, backend);
  members.remote = remote;
  host = createPolicyHost(ctx, "a");
  members.activeAccount = {
    id: "a",
    email: user.email,
    name: "Bob",
    remote: true,
  };
  return {
    mock,
    root,
    store,
    engine,
    events,
    focus,
    remote,
    host,
    backend,
    changedSettings: () => changedSettings,
    async done() {
      host!.stop();
      await mock.close();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

test("a remote account gets the administrator's policy with no local policy file", async () => {
  const env = await openAccount({
    policy: servicePolicyWire,
    catalog: {
      default_model: "gpt-5.5",
      items: [
        {
          id: "gpt-5.5",
          display_name: "GPT-5.5",
          sort: 10,
          context_window: 400000,
          auto_compact_tokens: 320000,
        },
      ],
    },
    release: {
      // The service compares X-Claudex-Version (this build's 0.0.1).
      latest_version: "1.4.0",
      minimum_version: "0.0.1",
      release_notes_md: "## Improved\n- Faster sign-in.",
      published_at: "2026-09-20T00:00:00Z",
      downloads: {
        [`${process.platform}-${process.arch}`]: {
          url: "https://claudex.example.com/download",
        },
      },
    },
  });
  try {
    assert.equal(fs.existsSync(path.join(env.root, "backend")), false);
    const policy = env.host.current();
    assert.equal(policy.revision, 17);
    assert.equal(policy.planLabel, "Max");
    assert.equal(policy.attachments.maxBytes, 10485760);
    assert.deepEqual(policy.connectors?.[0], {
      name: "github",
      urlPrefix: "https://api.githubcopilot.com/mcp",
    });
    assert.equal((policy as { groupId?: number }).groupId, undefined);
    // The release section: the update and What's new's notes.
    assert.equal(policy.update?.state, "available");
    assert.equal(policy.update?.enforced, false);
    assert.equal(
      policy.update?.downloadUrl,
      "https://claudex.example.com/download",
    );
    assert.deepEqual((policy as { releaseNotes?: unknown }).releaseNotes, {
      version: "1.4.0",
      markdown: "## Improved\n- Faster sign-in.",
      publishedAt: Date.parse("2026-09-20T00:00:00Z"),
    });
    // Kept on disk for an offline start, readable by this user only.
    const file = path.join(env.store.root, policyCacheFileName);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(new PolicyCache(env.store.root).read()?.record.revision, 17);
    // The engine checks against it, and the catalog's limits are bound.
    assert.equal(env.engine.policy().revision, 17);
    assert.deepEqual(env.engine.modelLimits("sub2api", "gpt-5.5"), {
      contextWindow: 400000,
      autoCompactTokens: 320000,
    });
    assert.equal(env.engine.modelLimits("other", "gpt-5.5"), undefined);
    // The bootstrap brought it: starting does not ask again at once.
    const policyCalls = () =>
      env.mock.calls.filter((call) => call === "GET /api/v1/claudex/policy")
        .length;
    env.host.start();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(policyCalls(), 0);
  } finally {
    await env.done();
  }
});

test("a policy change reaches the window with its revision; an unchanged one is a 304", async () => {
  const env = await openAccount();
  try {
    const source = env.host.source as ServerPolicySource;
    // Code runs in Auto; the administrator then allows only Manual and Plan.
    env.store.settings.codeSandbox = "workspace-write";
    env.store.settings.codePlanMode = false;
    env.mock.options.policy = {
      revision: 18,
      permission_modes: ["manual", "plan"],
    };
    await source.refresh(true);
    const pushed = env.events.filter((event) => event.type === "policy");
    assert.equal(pushed.length, 1);
    assert.equal(pushed[0].type === "policy" && pushed[0].revision, 18);
    assert.equal(permissionModeOf(env.store.settings, null), "manual");
    assert.equal(env.changedSettings(), 1);
    // Asked again: the ETag is sent back and nothing changes.
    await source.refresh(true);
    const last = env.mock.requests.at(-1)!;
    assert.equal(last.path, "/api/v1/claudex/policy");
    assert.match(String(last.headers["if-none-match"]), /^W\/"/);
    assert.equal(
      env.events.filter((event) => event.type === "policy").length,
      1,
    );
    // The window's own reads (clientPolicy) are spaced 30 s apart.
    const before = env.mock.calls.length;
    await source.refresh();
    assert.equal(env.mock.calls.length, before);
  } finally {
    await env.done();
  }
});

test("window focus reads the policy again, at most once a minute", async () => {
  const env = await openAccount();
  try {
    env.host.start();
    const policyCalls = () =>
      env.mock.calls.filter((call) => call === "GET /api/v1/claudex/policy")
        .length;
    for (const cb of env.focus) cb();
    await new Promise((resolve) => setTimeout(resolve, 20));
    // Just started: the focus is within the minute.
    assert.equal(policyCalls(), 0);
    env.host.stop();
    assert.equal(env.focus.size, 0);
  } finally {
    await env.done();
  }
});

test("offline: the cached policy, else only MCP editing held back; Bypass is always the user's", async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-offline-"));
  try {
    const unreachable = async () => {
      throw Error("offline");
    };
    const settings = () => ({
      mcpServers: { docs: { command: "docs-mcp" } },
    });
    // First start offline with nothing cached.
    const fresh = new ServerPolicySource({
      load: unreachable,
      cache: new PolicyCache(profile),
      settings,
    });
    await fresh.refresh(true);
    const offline = fresh.current();
    assert.equal(offline.localMcpEditing, false);
    assert.equal(offline.pending, true);
    assert.deepEqual(offline.connectors, [{ name: "docs" }]);
    assert.deepEqual(offline.permissionModes, [
      "auto",
      "manual",
      "acceptEdits",
      "plan",
    ]);
    assert.equal(modeAllowed(offline, "bypass"), true);

    // The service answered once (a strict policy) ...
    const online = new ServerPolicySource({
      load: unreachable,
      cache: new PolicyCache(profile),
      settings,
    });
    online.accept({
      ...servicePolicyWire,
      revision: 21,
      permission_modes: ["plan"],
      local_mcp_editing: false,
    });
    // ... so the next offline start follows it.
    const restarted = new ServerPolicySource({
      load: unreachable,
      cache: new PolicyCache(profile),
      settings,
    });
    await restarted.refresh(true);
    const cached = restarted.current();
    assert.equal(cached.revision, 21);
    assert.deepEqual(cached.permissionModes, ["plan"]);
    assert.equal(cached.pending, undefined);
    assert.equal(modeAllowed(cached, "bypass"), true);

    // A damaged cache is not used.
    fs.writeFileSync(path.join(profile, policyCacheFileName), "{broken");
    const damaged = new ServerPolicySource({
      load: unreachable,
      cache: new PolicyCache(profile),
      settings,
    });
    assert.equal(damaged.current().pending, true);
    // An edited cache that grants Bypass through a mode list is not a policy.
    fs.writeFileSync(
      path.join(profile, policyCacheFileName),
      JSON.stringify({
        version: 1,
        fetchedAt: 1,
        etag: null,
        revision: 1,
        policy: { ...servicePolicyWire, permission_modes: ["bypass"] },
      }),
    );
    const edited = new ServerPolicySource({
      load: unreachable,
      cache: new PolicyCache(profile),
      settings,
    });
    assert.deepEqual(edited.current().permissionModes, []);
    assert.equal(modeAllowed(edited.current(), "bypass"), true);
  } finally {
    fs.rmSync(profile, { recursive: true, force: true });
  }
});

test("offline: computer use waits for the service even when the cache allowed it", async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-cu-"));
  try {
    const unreachable = async () => {
      throw Error("offline");
    };
    const settings = () => ({ mcpServers: {} });
    const allowed = {
      ...servicePolicyWire,
      ssh_remote: false,
      computer_use: {
        enabled: true,
        allow_full_control: false,
        denied_apps: ["com.apple.Terminal"],
        max_actions_per_turn: 50,
      },
    };
    // Nothing cached: the offline policy never offers computer use.
    const fresh = new ServerPolicySource({
      load: unreachable,
      cache: new PolicyCache(profile),
      settings,
    });
    assert.equal(fresh.current().computerUse?.enabled, false);
    assert.equal(fresh.current().sshRemote, true, "SSH stays usable offline");
    assert.equal(fresh.current().codexRuntimeMirror, null);

    new ServerPolicySource({
      load: unreachable,
      cache: new PolicyCache(profile),
      settings,
    }).accept(allowed);

    // Restarted offline: the cached policy applies, computer use waits.
    let answer: unknown;
    const restarted = new ServerPolicySource({
      load: async () => {
        if (!answer) throw Error("offline");
        return {
          notModified: false as const,
          status: 200,
          data: answer,
          etag: '"2"',
        };
      },
      cache: new PolicyCache(profile),
      settings,
    });
    assert.deepEqual(restarted.current().computerUse, {
      enabled: false,
      allowFullControl: false,
      deniedApps: ["com.apple.Terminal"],
      maxActionsPerTurn: 50,
    });
    assert.equal(
      restarted.current().sshRemote,
      false,
      "the rest applies as kept",
    );
    // The service answers: computer use is back.
    answer = allowed;
    await restarted.refresh(true);
    assert.equal(restarted.current().computerUse?.enabled, true);
  } finally {
    fs.rmSync(profile, { recursive: true, force: true });
  }
});

test("a bootstrap without its policy section falls back to the cache", async () => {
  const env = await openAccount({ policy: { revision: 30 } });
  try {
    // A later sign-in whose bootstrap lost the policy section.
    env.mock.route("GET", "/api/v1/claudex/bootstrap", (request) => {
      const data = env.mock.bootstrapFor(3, request.headers);
      delete data.policy;
      data.errors = [{ section: "policy", code: "CLAUDEX_SECTION_TIMEOUT" }];
      return { status: 200, body: { code: 0, message: "success", data } };
    });
    await env.backend.prepare(keys());
    assert.equal(env.backend.bootstrap.current()?.policy, undefined);
    const again = createPolicyHost(
      new Proxy(
        {
          store: env.store,
          engine: env.engine,
          remote: env.remote,
          appVersion: "0.0.1",
          activeAccount: undefined,
        },
        {
          get: (target, key) =>
            key in target
              ? (target as Record<string, unknown>)[key as string]
              : () => {
                  throw Error(`AppContext.${String(key)} is not faked`);
                },
        },
      ) as unknown as AppContext,
      "a",
    );
    assert.equal(again.current().revision, 30);
    assert.equal(again.current().pending, undefined);
    again.stop();
  } finally {
    await env.done();
  }
});

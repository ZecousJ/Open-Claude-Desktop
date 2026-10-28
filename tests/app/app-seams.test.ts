import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  bridgeErrorMessage,
  coreMethods,
  desktopMethods,
  domainMethods,
} from "../../shared/desktop-bridge";
import {
  lockedPolicy,
  modeAllowed,
  offlinePolicy,
  openPolicy,
  permissionModeOf,
  type ClientPolicy,
} from "../../shared/client-policy";
import { connectorAllowed } from "../../shared/client-policy-rules";
import { Store } from "../../electron/store/store";
import type { AppContext } from "../../electron/app/app-context";
import { registerModelCatalogHandlers } from "../../electron/ipc/model-catalog";
import { registerSpeechHandlers } from "../../electron/ipc/speech";
import { registerDiagnosticsHandlers } from "../../electron/ipc/diagnostics";
import { withOpenableLink } from "../../electron/ipc/usage";
import { RemoteHost } from "../../electron/remote/host";
import {
  createPolicyHost,
  handleRefusal,
} from "../../electron/remote/host-wiring";

/** Every `handle("name", …)` registration under electron/, by file. */
function registrations() {
  const electron = fileURLToPath(new URL("../../electron", import.meta.url));
  const found = new Map<string, string[]>();
  const walk = (folder: string) => {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      const file = path.join(folder, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (file.endsWith(".ts"))
        for (const match of fs
          .readFileSync(file, "utf8")
          .matchAll(/\bhandle\(\s*"([A-Za-z]+)"/g))
          found.set(match[1], [
            ...(found.get(match[1]) ?? []),
            path.relative(electron, file).split(path.sep).join("/"),
          ]);
    }
  };
  walk(electron);
  return found;
}

/** Where each domain's calls are handled (docs/ui-workpackages.md). */
const domainFiles: Record<keyof typeof domainMethods, string[]> = {
  "privacy-data": ["ipc/privacy-data.ts"],
  "desktop-extensions": ["connectors/extension-lifecycle.ts"],
  "device-trust": ["remote-control/account-device-state.ts"],
  "chat-devices": ["ipc/chat-devices.ts"],
  dispatch: ["ipc/dispatch.ts"],
  "settings-account": ["ipc/settings-account.ts"],
  "settings-desktop": [
    "ipc/settings-desktop.ts",
    "ipc/settings-desktop-connectors.ts",
    "ipc/settings-mcp.ts",
    "ipc/skills.ts",
  ],
  "code-email": ["ipc/code-email.ts"],
  policy: ["ipc/policy.ts"],
  usage: ["ipc/usage.ts"],
  billing: ["ipc/billing.ts"],
  "model-catalog": ["ipc/model-catalog.ts"],
  voice: ["ipc/transcription.ts", "ipc/speech.ts"],
  diagnostics: ["ipc/diagnostics.ts", "app/ipc-register.ts"],
  "edit-commands": ["app/edit-commands.ts"],
  "support-bundle": ["support/support-bundle.ts"],
  "office-addin": ["ipc/office-addin.ts"],
  "code-usage": ["ipc/code-usage.ts"],
  composer: ["ipc/composer.ts"],
  agent: ["ipc/agent.ts", "ipc/workflow.ts"],
  panels: [
    "ipc/panels.ts",
    "ipc/panels-browser-tools.ts",
    "ipc/terminal.ts",
    "ipc/background-terminals.ts",
    "ipc/session-loops.ts",
    "ipc/task-backlog.ts",
  ],
  artifacts: [
    "ipc/artifacts.ts",
    "ipc/artifact-library.ts",
    "artifacts/artifact-tools.ts",
    "ipc/blank-artifacts.ts",
  ],
  collections: [
    "ipc/collections.ts",
    "ipc/collections-schedules.ts",
    "ipc/collections-directory.ts",
    "routines/routine-migration-handlers.ts",
  ],
  "external-links": ["app/external-links.ts"],
  sharing: ["ipc/sharing.ts", "ipc/sharing-hosted.ts"],
  windows: ["ipc/windows.ts"],
  memory: ["ipc/memory.ts"],
  research: ["ipc/research.ts", "ipc/research-handlers.ts"],
  favicons: ["ipc/favicons.ts"],
  ssh: ["ipc/ssh.ts", "ipc/ssh-handlers.ts"],
  "computer-use": ["ipc/computer-use.ts"],
  cowork: ["ipc/cowork.ts"],
  "workspace-trust": ["ipc/workspace-trust.ts"],
  "app-update": ["ipc/app-update.ts"],
  "sign-in": ["ipc/remote-auth.ts"],
  github: ["ipc/github.ts"],
  linear: ["ipc/linear.ts"],
  "api-keys": ["ipc/api-keys.ts"],
  announcements: ["ipc/announcements.ts"],
  onboarding: ["ipc/onboarding.ts"],
  "account-profile": ["ipc/account-profile.ts"],
  "usage-stats": ["ipc/usage-stats.ts"],
  "service-status": ["ipc/service-status.ts"],
  "cloud-sync": ["ipc/cloud-sync.ts"],
  "cloud-environments": ["ipc/cloud-environments.ts"],
  "cloud-continue": ["ipc/cloud-continue.ts"],
  simulators: ["ipc/simulators.ts"],
};
/** Sign-in calls: Claudex accounts only (there are no local accounts). */
const signInFiles = ["ipc/remote-auth.ts"];

test("every bridge call has one handler, in the file of the domain that owns it", () => {
  assert.equal(new Set(desktopMethods).size, desktopMethods.length);
  const found = registrations();
  for (const name of found.keys())
    assert.ok(desktopMethods.includes(name), `${name} has no bridge entry`);
  for (const name of coreMethods) {
    const files = found.get(name) ?? [];
    assert.ok(files.length, `${name} has no handler`);
    if (files.length > 1)
      assert.deepEqual(
        files.filter((file) => !signInFiles.includes(file)),
        [],
        `${name} is handled twice: ${files.join(", ")}`,
      );
  }
  for (const [domain, names] of Object.entries(domainMethods))
    for (const name of names) {
      const files = found.get(name) ?? [];
      assert.equal(
        files.length,
        1,
        `${name} (${domain}) is handled in ${files.join(", ") || "no file"}`,
      );
      assert.ok(
        domainFiles[domain as keyof typeof domainMethods].includes(files[0]),
        `${name} (${domain}) is handled in ${files[0]}, outside its domain`,
      );
    }
});

test("a failed bridge call shows the main process's message without Electron's wrapper", () => {
  assert.equal(
    bridgeErrorMessage(
      new Error(
        "Error invoking remote method 'app:loginAccount': Error: The password is incorrect.",
      ),
    ),
    "The password is incorrect.",
  );
  assert.equal(
    bridgeErrorMessage(
      new Error(
        "Error invoking remote method 'app:send': TypeError: x is not a function",
      ),
    ),
    "x is not a function",
  );
  assert.equal(
    bridgeErrorMessage(new Error("Sign in to continue.")),
    "Sign in to continue.",
  );
  assert.equal(bridgeErrorMessage("offline"), "offline");
});

/** An AppContext for handlers that only read a few members. */
function fakeContext(members: Partial<AppContext>): AppContext {
  return new Proxy(members as AppContext, {
    get: (target, key) =>
      key in target
        ? target[key as keyof AppContext]
        : () => {
            throw Error(`AppContext.${String(key)} is not faked`);
          },
  });
}

test("the service slots answer with empty values until their packages fill them", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-slots-"));
  try {
    const store = new Store(root);
    store.settings.providers = [
      { ...store.settings.providers[0], transcriptionModel: "whisper-1" },
    ];
    const handlers = new Map<string, (...args: any[]) => any>();
    // Diagnostics (C7) listens to the context's events from registration on.
    const listen = () => () => {};
    const ctx = fakeContext({
      store,
      remote: undefined,
      policy: () => openPolicy,
      onSettingsChanged: listen,
      onRefusal: listen,
      onEvent: listen,
      onReplyRated: listen,
      // Speech ends an account's dictation session when it signs out.
      onAccountDeactivating: listen,
    });
    for (const register of [
      registerModelCatalogHandlers,
      registerSpeechHandlers,
      registerDiagnosticsHandlers,
    ])
      register((name, fn) => handlers.set(name, fn), ctx);
    assert.equal(await handlers.get("modelCatalog")!(), null);
    assert.equal(await handlers.get("refreshModels")!(), null);
    const voice = await handlers.get("voiceAvailability")!();
    assert.equal(voice.transcription, true);
    // Read aloud was removed (owner decision 19).
    assert.equal(handlers.has("speak"), false);
    assert.equal(await handlers.get("reportingStatus")!(), null);
    assert.deepEqual(
      await handlers.get("submitReplyFeedback")!({
        conversationId: "c",
        turnId: "t",
        rating: "up",
      }),
      { sent: false },
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the policy host brings stored settings within a local policy and binds the engine", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-policy-host-"));
  try {
    fs.mkdirSync(path.join(root, "backend"));
    fs.writeFileSync(
      path.join(root, "backend", "policy.json"),
      JSON.stringify({
        version: 1,
        defaults: { permissionModes: ["manual", "plan"] },
      }),
    );
    const store = new Store(path.join(root, "profile"));
    store.settings.codeSandbox = "workspace-write";
    store.settings.autoAcceptEdits = false;
    store.settings.codePlanMode = false;
    const engine = { policy: () => openPolicy } as { policy(): ClientPolicy };
    let current: ClientPolicy = openPolicy;
    const ctx = fakeContext({
      store,
      engine: engine as never,
      remote: undefined,
      dataRoot: root,
      appVersion: "0.0.1",
      policy: () => current,
    });
    const host = createPolicyHost(ctx, "account");
    current = host.current();
    assert.deepEqual(current.permissionModes, ["manual", "plan"]);
    // Auto is not allowed: the stored mode moved to the first allowed one.
    assert.equal(permissionModeOf(store.settings, null), "manual");
    assert.equal(engine.policy(), current);
    host.stop();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a gateway refusal is recorded, a refused key is issued again and the banner refreshed", async () => {
  const calls: string[] = [];
  const events: unknown[] = [];
  const remote = {
    recordRefusal: () => calls.push("record"),
    reprovision: async () => void calls.push("reprovision"),
  };
  const ctx = fakeContext({
    remote: remote as never,
    activeAccount: undefined,
    push: (event) => events.push(event),
  });
  handleRefusal(ctx, {
    status: 401,
    code: "INVALID_API_KEY",
    exceeded: false,
    invalidKey: true,
    message: "The device key was refused.",
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ["record", "reprovision"]);
  assert.deepEqual(events, [{ type: "weekly-usage", status: null }]);
});

test("the remote host hands a reissued device key to the running provider child and takes it out of the vault at sign-out", async () => {
  const provider = { id: "sub2api", protocol: "responses" };
  const backend = {
    provider,
    keyInVault: true,
    planName: "Pro",
    reprovision: async (
      apply: (key: string, groupKeys: Record<string, string>) => Promise<void>,
    ) => apply("sk-new-device-key", { "sub2api:g11": "sk-new-grok-key" }),
  };
  const handed: unknown[][] = [];
  const cleared: unknown[][] = [];
  let signedIn = true;
  const members = {
    get remote() {
      return signedIn ? host : undefined;
    },
    engine: {
      updateProviderKey: async (...args: unknown[]) => void handed.push(args),
    },
  };
  const host: RemoteHost = new RemoteHost(
    fakeContext(members as never),
    backend as never,
  );
  await host.reprovision();
  // With the keys of the account's other service groups (MG).
  assert.deepEqual(handed, [
    [
      "sub2api",
      "sk-new-device-key",
      true,
      { "sub2api:g11": "sk-new-grok-key" },
    ],
  ]);
  assert.deepEqual(
    host.account({ id: "a", email: "a@example.invalid", name: "A" }).plan,
    "Pro",
  );
  const credentials = {
    setKeys: async (...args: unknown[]) => void cleared.push(args),
  };
  await host.release(credentials as never);
  assert.deepEqual(cleared, [[{ sub2api: "" }, [provider]]]);
  // A key issued after sign-out is not handed to the next account's child.
  signedIn = false;
  await host.reprovision();
  assert.equal(handed.length, 1);
  // A key the vault could not hold was never written there.
  backend.keyInVault = false;
  await host.release(credentials as never);
  assert.equal(cleared.length, 1);
});

test("the remote host lists the models of the service group in use for each provider and follows a switch", () => {
  const item = (id: string, groupId: number) => ({
    id,
    displayName: id,
    description: "",
    badges: [],
    sort: 0,
    hidden: false,
    isDefault: false,
    usageHint: "",
    groupId,
  });
  const preferred: (readonly number[])[] = [];
  const backend = {
    preferGroups: (ids: readonly number[]) => void preferred.push(ids),
    catalog: {
      defaultModel: "gpt-5",
      items: [item("gpt-5", 2), item("gpt-5-pro", 4), item("grok-4", 3)],
    },
    serviceGroups: () => [
      {
        id: 2,
        name: "codex",
        primary: true,
        protocol: "responses",
        platform: "openai",
        models: ["gpt-5"],
      },
      {
        id: 4,
        name: "codex-pro",
        primary: false,
        protocol: "responses",
        platform: "openai",
        models: ["gpt-5-pro"],
      },
      {
        id: 3,
        name: "grok",
        primary: false,
        protocol: "chat",
        platform: "grok",
        models: ["grok-4"],
      },
    ],
  };
  const provider = { id: "sub2api", model: "gpt-5" };
  const settings = { apiGroups: {}, providers: [provider] } as {
    apiGroups: Record<string, number>;
    providers: (typeof provider)[];
  };
  let flushed = 0;
  let announced = 0;
  const host = new RemoteHost(
    fakeContext({
      store: { settings, flush: () => void flushed++ },
      settingsChanged: () => void announced++,
    } as never),
    backend as never,
  );
  assert.deepEqual(
    host.modelCatalog()?.items.map((entry) => entry.id),
    ["gpt-5", "grok-4"],
  );
  const selected = () =>
    Object.fromEntries(
      host.apiGroups().providers.map((entry) => [entry.id, entry.selected]),
    );
  assert.equal(selected().openai, 2);
  const groups = host.useGroup("openai", 4);
  assert.equal(groups.providers[0]?.selected, 4);
  assert.deepEqual(
    host.modelCatalog()?.items.map((entry) => entry.id),
    ["gpt-5-pro", "grok-4"],
  );
  // The provider's default model is one the groups serve, and the window hears of it.
  assert.equal(provider.model, "gpt-5-pro");
  assert.deepEqual(settings.apiGroups, { openai: 4 });
  // The service's keys follow: shared models go out with the groups in use.
  assert.deepEqual(preferred, [[4, 3]]);
  assert.equal(flushed, 1);
  assert.equal(announced, 1);
  assert.throws(() => host.useGroup("openai", 99), /isn't available/);
  // A group of another provider cannot be chosen for this one.
  assert.throws(() => host.useGroup("openai", 3), /isn't available/);
});

test("the usage banner offers Get more usage only when the policy lets the page open", () => {
  const status = {
    used: 90,
    limit: 100,
    percent: 90,
    warnPercent: 80,
    resetsAt: 0,
    moreUsageUrl: "https://usage.example.com/more",
    state: "warning" as const,
    dismissed: false,
  };
  assert.equal(withOpenableLink(status, openPolicy), status);
  assert.equal(withOpenableLink(status, lockedPolicy)?.moreUsageUrl, null);
  const named = {
    ...lockedPolicy,
    links: {
      ...lockedPolicy.links,
      getMoreUsage: "https://usage.example.com/more",
    },
  };
  assert.equal(withOpenableLink(status, named), status);
  assert.equal(withOpenableLink(null, lockedPolicy), null);
});

test("offline, only configured connectors run and Bypass stays the user's choice", () => {
  const policy = offlinePolicy({
    mcpServers: { docs: { command: "docs-mcp" }, git: { url: "https://x" } },
  });
  assert.equal(policy.localMcpEditing, false);
  assert.equal(policy.pending, true);
  assert.equal(connectorAllowed(policy, "docs", { command: "other" }), true);
  assert.equal(connectorAllowed(policy, "git"), true);
  assert.equal(connectorAllowed(policy, "added", { command: "x" }), false);
  assert.equal(modeAllowed(policy, "bypass"), true);
  // A rule bound to a definition still needs it; an address prefix (C2)
  // allows addresses under it only.
  const bound: Pick<ClientPolicy, "connectors"> = {
    connectors: [
      { name: "docs", command: "docs-mcp", args: [] },
      { name: "remote", urlPrefix: "https://mcp.example.com/" },
    ],
  };
  assert.equal(connectorAllowed(bound, "docs", { command: "docs-mcp" }), true);
  assert.equal(connectorAllowed(bound, "docs", { command: "evil" }), false);
  assert.equal(connectorAllowed(bound, "docs"), false);
  assert.equal(
    connectorAllowed(bound, "remote", { url: "https://mcp.example.com/a" }),
    true,
  );
  assert.equal(
    connectorAllowed(bound, "remote", { url: "https://evil.example.com/a" }),
    false,
  );
});

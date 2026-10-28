import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  lockedPolicy,
  modeAllowed,
  openPolicy,
  pendingPolicy,
  settingsRefusal,
  settingsWithinPolicy,
  type ClientPolicy,
} from "../../shared/client-policy";
import {
  allowedMcpServers,
  attachmentRefusal,
  clientUpdate,
  compareVersions,
  connectorAllowed,
  urlListed,
} from "../../shared/client-policy-rules";
import {
  currentClientPolicy,
  parseOperatorPolicy,
  resolveClientPolicy,
} from "../../server/operator-policy";
import {
  LocalPolicySource,
  RemotePolicySource,
  serviceLinks,
} from "../../electron/account/client-policy";
import { Engine } from "../../electron/engine/engine";
import { Store } from "../../electron/store/store";

const modeSettings = {
  codeSandbox: "workspace-write" as const,
  codePlanMode: false,
  autoAcceptEdits: false,
  bypassFolders: [] as string[],
  mcpServers: {} as Record<string, unknown>,
};
const bypass = { ...modeSettings, codeSandbox: "danger-full-access" as const };
const context = { platform: "darwin" as const, appVersion: "1.0.0" };

test("no policy, a locked policy or a pending one never restricts Bypass permissions", () => {
  for (const policy of [openPolicy, lockedPolicy, pendingPolicy]) {
    assert.equal(modeAllowed(policy, "bypass"), true);
    assert.equal(settingsRefusal(modeSettings, bypass, policy), undefined);
    assert.equal(settingsWithinPolicy(bypass, policy), undefined);
  }
  assert.equal(modeAllowed(lockedPolicy, "auto"), false);
  // A stored mode the administrator no longer allows moves to an allowed one.
  assert.deepEqual(
    settingsWithinPolicy(modeSettings, lockedPolicy)?.codeSandbox,
    "read-only",
  );
  assert.match(
    settingsRefusal(
      { ...modeSettings, codeSandbox: "read-only" },
      modeSettings,
      lockedPolicy,
    ) ?? "",
    /doesn't allow Auto mode/,
  );
  // The file may still list Bypass; it changes nothing.
  const file = parseOperatorPolicy({
    version: 1,
    defaults: { permissionModes: ["manual", "bypass"] },
  });
  assert.deepEqual(file.defaults?.permissionModes, ["manual"]);
  assert.throws(
    () =>
      parseOperatorPolicy({
        version: 1,
        defaults: { permissionModes: ["bypass"] },
      }),
    /other than bypass/,
  );
});

test("until the service answers, local MCP editing, Developer Mode and computer use are held back", () => {
  const {
    localMcpEditing,
    developerModeEnabled,
    pending,
    computerUse,
    ...rest
  } = pendingPolicy;
  const {
    localMcpEditing: _open,
    computerUse: _openComputerUse,
    developerModeEnabled: _openDeveloperMode,
    ...open
  } = openPolicy;
  assert.equal(localMcpEditing, false);
  assert.equal(developerModeEnabled, false);
  assert.equal(pending, true);
  assert.equal(computerUse?.enabled, false);
  assert.deepEqual(rest, open);
  const servers = { docs: { command: "docs-mcp", enabled: true } };
  const before = { ...modeSettings, mcpServers: servers };
  assert.match(
    settingsRefusal(
      before,
      { ...before, mcpServers: { ...servers, other: { command: "x" } } },
      pendingPolicy,
    ) ?? "",
    /once Claudex reaches your service/,
  );
  // Turning a configured connector on or off stays possible.
  assert.equal(
    settingsRefusal(
      before,
      {
        ...before,
        mcpServers: { docs: { command: "docs-mcp", enabled: false } },
      },
      pendingPolicy,
    ),
    undefined,
  );
  assert.match(
    settingsRefusal(
      before,
      { ...before, mcpServers: {} },
      { ...openPolicy, localMcpEditing: false },
    ) ?? "",
    /administrator has turned off adding MCP servers/,
  );
});

test("the connector allowlist matches a server's definition, not only its name", () => {
  const policy: Pick<ClientPolicy, "connectors"> = {
    connectors: [
      { name: "github", command: "npx", args: ["-y", "github-mcp"] },
      { name: "search", url: "https://mcp.example.com/sse" },
    ],
  };
  const servers = {
    github: { command: "npx", args: ["-y", "github-mcp"], enabled: true },
    search: { url: "https://mcp.example.com/sse" },
    other: { command: "npx", args: ["-y", "github-mcp"] },
  };
  assert.deepEqual(Object.keys(allowedMcpServers(servers, policy)), [
    "github",
    "search",
  ]);
  // Renaming another program to an allowed name does not let it run.
  assert.equal(
    connectorAllowed(policy, "github", { command: "/tmp/anything.sh" }),
    false,
  );
  assert.equal(
    connectorAllowed(policy, "github", {
      command: "npx",
      args: ["-y", "evil-package"],
    }),
    false,
  );
  assert.equal(
    connectorAllowed(policy, "search", { url: "https://evil.example.com" }),
    false,
  );
  assert.equal(connectorAllowed(policy, "github", "not an object"), false);
  assert.equal(connectorAllowed(openPolicy, "any", {}), true);
  assert.deepEqual(allowedMcpServers(servers, lockedPolicy), {});
  assert.throws(
    () =>
      parseOperatorPolicy({
        version: 1,
        defaults: { connectors: ["github"] },
      }),
    /must be an object/,
  );
  assert.throws(
    () =>
      parseOperatorPolicy({
        version: 1,
        defaults: { connectors: [{ name: "github" }] },
      }),
    /either a command or a url/,
  );
});

test("a local account's policy: defaults, then the account, then its platform", () => {
  const file = parseOperatorPolicy({
    version: 1,
    defaults: {
      webSearch: false,
      permissionModes: { default: ["auto", "manual"], win32: ["manual"] },
      attachments: { maxMegabytes: 1, types: ["png", "md"] },
    },
    accounts: { a: { webSearch: true, voice: false } },
    client: { minimumVersion: "1.2.0" },
  });
  const a = resolveClientPolicy(file, { ...context, accountId: "a" });
  assert.equal(a.webSearch, true);
  assert.equal(a.voice, false);
  assert.deepEqual(a.permissionModes, ["auto", "manual"]);
  assert.equal(a.attachments.maxBytes, 1024 * 1024);
  assert.equal(a.update?.state, "required");
  const b = resolveClientPolicy(file, {
    ...context,
    platform: "win32",
    accountId: "b",
  });
  assert.equal(b.webSearch, false);
  assert.equal(b.voice, true);
  assert.deepEqual(b.permissionModes, ["manual"]);
  // Group or plan names are not a way to address users.
  assert.throws(
    () => parseOperatorPolicy({ version: 1, plans: { Pro: {} } }),
    /plans is not a known field/,
  );
});

test("no policy file allows everything; a broken one locks optional features", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-policy-"));
  try {
    const local = { ...context, accountId: "a" };
    assert.deepEqual(currentClientPolicy(root, local), openPolicy);
    fs.mkdirSync(path.join(root, "backend"));
    fs.writeFileSync(path.join(root, "backend", "policy.json"), "{");
    const broken = currentClientPolicy(root, local);
    assert.equal(broken.localMcpEditing, false);
    assert.deepEqual(broken.connectors, []);
    assert.equal(modeAllowed(broken, "bypass"), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the local source reads the file again only after it changed", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-policy-"));
  try {
    const changes: ClientPolicy[] = [];
    const source = new LocalPolicySource(
      root,
      { ...context, accountId: "a" },
      (policy) => changes.push(policy),
    );
    const first = source.current();
    assert.equal(source.current(), first);
    fs.mkdirSync(path.join(root, "backend"));
    fs.writeFileSync(
      path.join(root, "backend", "policy.json"),
      JSON.stringify({ version: 1, defaults: { incognito: false } }),
    );
    await source.refresh();
    assert.equal(changes.length, 1);
    assert.equal(source.current().incognito, false);
    await source.refresh();
    assert.equal(changes.length, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the remote source answers at once and adopts the service's links when they arrive", async () => {
  let answer: (value: any) => void = () => {};
  let calls = 0;
  const changes: ClientPolicy[] = [];
  const source = new RemotePolicySource(
    () => {
      calls++;
      return new Promise((resolve) => (answer = resolve));
    },
    (policy) => changes.push(policy),
  );
  assert.equal(source.current(), pendingPolicy);
  const first = source.refresh();
  const second = source.refresh();
  assert.equal(calls, 1);
  answer({
    docUrl: "https://docs.example.com",
    purchaseUrl: "",
    menuItems: [
      { label: "Status", url: "https://status.example.com" },
      { label: "Get apps and extensions", url: "https://apps.example.com" },
      { label: "Plain", url: "http://insecure.example.com" },
    ],
  });
  await Promise.all([first, second]);
  const policy = source.current();
  assert.equal(policy.pending, undefined);
  assert.equal(policy.localMcpEditing, true);
  assert.equal(policy.links.help, "https://docs.example.com");
  assert.equal(policy.links.apps, "https://apps.example.com");
  assert.deepEqual(policy.links.learnMore, [
    { label: "Status", url: "https://status.example.com" },
  ]);
  assert.deepEqual(source.serviceUrls, ["https://docs.example.com"]);
  assert.equal(changes.length, 1);
  // Asked again within a minute: no request.
  await source.refresh();
  assert.equal(calls, 1);
});

test("an unreachable service leaves the pending policy in place", async () => {
  const source = new RemotePolicySource(
    async () => {
      throw Error("offline");
    },
    () => assert.fail("nothing changed"),
  );
  await source.refresh();
  assert.equal(source.current(), pendingPolicy);
  assert.deepEqual(
    serviceLinks({ docUrl: "", purchaseUrl: "", menuItems: [] }).learnMore,
    [],
  );
});

test("administrator pages open with links off whatever their spelling", () => {
  const listed = ["https://Docs.Example.com", "https://example.com/a/"];
  assert.equal(urlListed("https://docs.example.com/", listed), true);
  assert.equal(urlListed("https://example.com/a/", listed), true);
  assert.equal(urlListed("https://example.com/a", listed), false);
  assert.equal(urlListed("not a url", listed), false);
});

test("attachment refusals tell Claudex's limits apart from the administrator's", () => {
  assert.match(
    attachmentRefusal("Makefile", 10, openPolicy) ?? "",
    /“Makefile” can’t be attached in this chat yet — this file type isn’t supported here\. You can paste its contents into the message instead\./,
  );
  assert.match(
    attachmentRefusal("a.md", 10, {
      ...openPolicy,
      attachments: { maxBytes: null, types: ["png"] },
    }) ?? "",
    /administrator doesn't allow/,
  );
  assert.match(
    attachmentRefusal("a.png", 30 * 1024 * 1024, openPolicy) ?? "",
    /Images larger than 20MB can’t be attached\./,
  );
});

test("a pre-release does not satisfy the minimum version it precedes", () => {
  assert.equal(compareVersions("0.2.0-beta.1", "0.2.0"), -1);
  assert.equal(compareVersions("0.2.0", "0.2.0-beta.1"), 1);
  assert.equal(compareVersions("1.10.0", "1.9.2"), 1);
  assert.equal(
    clientUpdate("0.2.0-beta.1", { minimumVersion: "0.2.0" })?.state,
    "required",
  );
  assert.equal(clientUpdate("0.2.0", { latestVersion: "0.2.0" }), undefined);
});

test("with web search turned off, a conversation that had it on continues without it", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-policy-"));
  const store = new Store(root);
  try {
    store.settings.providers[0].model = "m";
    store.conversations.push({
      id: "c",
      title: "Fixture",
      mode: "chat",
      providerId: "default",
      model: "m",
      threadId: "t",
      webSearch: true,
      pinned: false,
      archived: false,
      createdAt: 1,
      updatedAt: 1,
      turns: [],
    });
    const calls: { method: string; params: any }[] = [];
    const engine = new Engine(
      store,
      "unused",
      () => "",
      () => {},
    );
    engine.ensure = async () => {};
    engine.rpc = {
      call: async (method: string, params: any) => {
        calls.push({ method, params });
        return method === "turn/start" ? { turn: { id: "turn" } } : {};
      },
    } as any;
    (engine as any).windowsSandbox = {
      assertReady() {},
      async ensureReady() {},
    };
    engine.policy = () => ({ ...openPolicy, webSearch: false });
    await engine.send({
      conversationId: "c",
      text: "hello",
      mode: "chat",
      attachments: [],
      providerId: "default",
      model: "m",
    });
    assert.equal(store.conversation("c").webSearch, false);
    const resume = calls.find((call) => call.method === "thread/resume");
    assert.equal(resume?.params.config.web_search, "disabled");
    assert.ok(calls.some((call) => call.method === "turn/start"));
  } finally {
    store.flush();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
